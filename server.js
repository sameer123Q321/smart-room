
// Smart Room server (Express + EJS)
// Render-compatible version
//
// Install: npm install
// Run:     npm start
//
// ESP32 endpoint:
// https://smart-room-exsy.onrender.com/rpc

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const faceEngine = require("./face-engine");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const OFFLINE_AFTER_MS = 15000;
const DEVICES_OFFLINE_AFTER_MS = 5000;

// Face recognition is disabled by default on Render Free.
// Enable only after configuring and testing the face engine.
const FACE_RECOGNITION_ENABLED =
  process.env.FACE_RECOGNITION_ENABLED === "true";

let latest = null;
let espLastSeen = 0;

// ---------- Security settings ----------

const DOOR_PIN = process.env.DOOR_PIN || "1234";

const CAMERA_KEY =
  process.env.CAMERA_KEY || "smart-room-cam";

const UNLOCK_MS = 3000;
const REQUEST_EXPIRES_MS = 5000;

const LIGHT_ON_WHEN_DOOR_OPENS = true;

const FACE_MATCH_THRESHOLD = faceEngine.MATCH_DISTANCE;

const MAX_VISITS = 20;
const MAX_ACTIVITY = 500;

// ---------- Data directories ----------

const DATA_DIR = path.join(__dirname, "data");

const FACES_FILE = path.join(DATA_DIR, "faces.json");
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");

const FACE_PHOTO_DIR = path.join(DATA_DIR, "faces");
const VISIT_PHOTO_DIR = path.join(DATA_DIR, "visits");

fs.mkdirSync(FACE_PHOTO_DIR, { recursive: true });
fs.mkdirSync(VISIT_PHOTO_DIR, { recursive: true });

// ---------- Helpers ----------

function newId() {
  return crypto.randomBytes(6).toString("hex");
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toText(value) {
  return value === undefined || value === null
    ? ""
    : String(value).slice(0, 100);
}

function cleanIp(ip) {
  return (ip || "").replace(/^::ffff:/, "");
}

function devicesOnline(now = Date.now()) {
  return now - espLastSeen < DEVICES_OFFLINE_AFTER_MS;
}

function isFaceEngineReady() {
  return FACE_RECOGNITION_ENABLED && faceEngine.isReady();
}

// ---------- Door lock ----------

const door = {
  requestedAt: 0,
  unlockUntil: 0,
  open: false,
};

let wrongPins = 0;
let pinBlockedUntil = 0;

function doorRequested(now) {
  return (
    door.requestedAt > 0 &&
    now - door.requestedAt < REQUEST_EXPIRES_MS
  );
}

function doorState(now) {
  return {
    online: devicesOnline(now),
    open: door.open,
    remainingMs: doorRequested(now)
      ? UNLOCK_MS
      : Math.max(0, door.unlockUntil - now),
    pinRequired: DOOR_PIN !== "",
  };
}

// ---------- Switches ----------

const switches = {
  light: {
    label: "Light",
    want: false,
    on: false,
  },

  fan: {
    label: "Fan",
    want: false,
    on: false,
  },
};

function switchStates(now) {
  const states = {};

  for (const [name, s] of Object.entries(switches)) {
    states[name] = {
      online: devicesOnline(now),
      want: s.want,
      on: s.on,
    };
  }

  return states;
}

// ---------- Faces and activity ----------

let people = [];

try {
  people = JSON.parse(fs.readFileSync(FACES_FILE, "utf8"));
} catch {
  people = [];
}

let activity = [];

try {
  activity = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8"));
} catch {
  activity = [];
}

const visits = [];

function savePeople() {
  fs.writeFileSync(FACES_FILE, JSON.stringify(people));
}

function logActivity(entry) {
  activity.unshift({
    id: newId(),
    time: Date.now(),
    name: "",
    personId: null,
    photo: false,
    ...entry,
  });

  while (activity.length > MAX_ACTIVITY) {
    const old = activity.pop();

    if (old.photo) {
      fs.rmSync(
        path.join(VISIT_PHOTO_DIR, old.id + ".jpg"),
        { force: true }
      );
    }
  }

  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity));
}

function activityInfo(a) {
  return {
    id: a.id,
    time: a.time,
    type: a.type,
    name: a.name,
    personId: a.personId,
    photo: a.photo ? `/visits/${a.id}.jpg` : null,
  };
}

function visitInfo(v) {
  if (!v) return null;

  return {
    id: v.id,
    time: v.time,
    result: v.result,
    name: v.name,
    hasFace: !!v.descriptor,
    photo: `/visits/${v.id}.jpg`,
  };
}

function closestPerson(descriptor) {
  let best = null;

  for (const person of people) {
    for (const d of person.descriptors || []) {
      if (d.length !== descriptor.length) continue;

      const dist = faceEngine.distance(descriptor, d);

      if (!best || dist < best.distance) {
        best = {
          person,
          distance: dist,
        };
      }
    }
  }

  return best;
}

function peopleList() {
  return people.map((p) => {
    const entries = activity.filter(
      (a) => a.type === "entered" && a.personId === p.id
    );

    return {
      id: p.id,
      name: p.name,
      photos: (p.descriptors || []).length,
      entries: entries.length,
      lastSeen: entries.length ? entries[0].time : null,
    };
  });
}

function dataUrlToJpeg(value) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(
    typeof value === "string" ? value : ""
  );

  return m ? Buffer.from(m[1], "base64") : null;
}

// ---------- Express setup ----------

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(
  "/api/faces",
  express.json({ limit: "15mb" })
);

app.use(
  express.json({ limit: "10kb" })
);

app.use(
  express.static(path.join(__dirname, "public"))
);

app.use(
  "/visits",
  express.static(VISIT_PHOTO_DIR)
);

app.use(
  "/face-photos",
  express.static(FACE_PHOTO_DIR)
);

// Face API browser files

const FACE_API_DIR = path.join(
  __dirname,
  "node_modules",
  "@vladmandic",
  "face-api"
);

app.use(
  "/vendor/face-api",
  express.static(path.join(FACE_API_DIR, "dist"))
);

app.use(
  "/models",
  express.static(path.join(FACE_API_DIR, "model"))
);

// ---------- EJS helpers ----------

app.locals.STATUS_CLASS = {
  Comfortable: "good",
  Good: "good",
  Warm: "warn",
  Dry: "warn",
  "A bit humid": "warn",
  Hot: "bad",
  "Too hot": "bad",
  "Too humid": "bad",
  Cold: "cold",
};

app.locals.fmt = (n, digits) =>
  typeof n === "number" ? n.toFixed(digits) : "--";

app.locals.ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));

  if (s < 60) return s + " s ago";

  const m = Math.floor(s / 60);

  if (m < 60) return m + " min ago";

  return Math.floor(m / 60) + " h ago";
};

// ---------- JSON-RPC ----------

function rpcError(code, message) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

const rpcMethods = {

  // ESP32 sends temperature and humidity readings.

  "room.report"(params, req) {
    const reading = {
      temperature: toNumber(params.temperature),
      humidity: toNumber(params.humidity),
      feelsLike: toNumber(params.feelsLike),
      tempStatus: toText(params.tempStatus),
      humidityStatus: toText(params.humidityStatus),
      advice: toText(params.advice),
      time: Date.now(),
      from: cleanIp(req.socket.remoteAddress),
    };

    if (
      reading.temperature === null ||
      reading.humidity === null
    ) {
      throw rpcError(
        -32602,
        "temperature and humidity are required"
      );
    }

    const changed =
      !latest ||
      latest.temperature !== reading.temperature ||
      latest.humidity !== reading.humidity ||
      latest.advice !== reading.advice;

    latest = reading;

    if (changed) {
      console.log(
        `[${new Date().toLocaleTimeString()}] ` +
        `${reading.temperature} C, ` +
        `${reading.humidity} %, ` +
        `feels ${reading.feelsLike} C - ${reading.advice}`
      );
    }

    return true;
  },

  // ESP32 checks whether the door should unlock.

  "door.check"(params) {
    const now = Date.now();

    door.open = params.open === true;

    if (doorRequested(now)) {
      door.requestedAt = 0;
      door.unlockUntil = now + UNLOCK_MS;

      if (
        LIGHT_ON_WHEN_DOOR_OPENS &&
        !switches.light.want
      ) {
        switches.light.want = true;

        console.log(
          "Light turned on because the door opened"
        );
      }
    }

    return {
      unlockMs: Math.max(0, door.unlockUntil - now),
    };
  },
};

// Light and fan checks.

for (const [name, s] of Object.entries(switches)) {
  rpcMethods[name + ".check"] = (params) => {
    s.on = params.on === true;

    return {
      on: s.want,
    };
  };
}

function runRpcCall(call, req) {
  const id =
    call &&
    (typeof call.id === "number" || typeof call.id === "string")
      ? call.id
      : null;

  if (
    !call ||
    call.jsonrpc !== "2.0" ||
    typeof call.method !== "string"
  ) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32600,
        message: "Invalid request",
      },
    };
  }

  let reply;

  if (!Object.hasOwn(rpcMethods, call.method)) {
    reply = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Method not found",
      },
    };
  } else {
    try {
      reply = {
        jsonrpc: "2.0",
        id,
        result: rpcMethods[call.method](
          call.params || {},
          req
        ),
      };
    } catch (err) {
      if (!err.rpcCode) throw err;

      reply = {
        jsonrpc: "2.0",
        id,
        error: {
          code: err.rpcCode,
          message: err.message,
        },
      };
    }
  }

  return call.id === undefined ? null : reply;
}

// ESP32 sends all four requests to this endpoint.

app.post("/rpc", (req, res) => {
  const body = req.body;

  if (Array.isArray(body)) {
    if (!body.length) {
      return res.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Invalid request",
        },
      });
    }

    const replies = body
      .map((call) => runRpcCall(call, req))
      .filter(Boolean);

    if (replies.length) {
      espLastSeen = Date.now();
      return res.json(replies);
    }

    return res.status(204).end();
  }

  const reply = runRpcCall(body, req);

  if (reply) {
    espLastSeen = Date.now();
    return res.json(reply);
  }

  return res.status(204).end();
});

// ---------- PIN verification ----------

function pinOk(req, res) {
  const now = Date.now();

  if (now < pinBlockedUntil) {
    res.status(429).json({
      ok: false,
      error: "Too many wrong PINs. Try again in a minute.",
    });

    return false;
  }

  if (
    DOOR_PIN &&
    String((req.body || {}).pin || "") !== DOOR_PIN
  ) {
    wrongPins++;

    if (wrongPins >= 5) {
      pinBlockedUntil = now + 60000;
      wrongPins = 0;
    }

    res.status(401).json({
      ok: false,
      error: "Wrong PIN",
    });

    return false;
  }

  wrongPins = 0;
  return true;
}

// ---------- Dashboard door control ----------

app.post("/api/door/open", (req, res) => {
  if (!pinOk(req, res)) return;

  const now = Date.now();

  if (!doorState(now).online) {
    return res.status(503).json({
      ok: false,
      error: "The door lock is offline",
    });
  }

  door.requestedAt = now;

  logActivity({
    type: "dashboard",
  });

  console.log(
    "Door open requested from dashboard"
  );

  res.json({
    ok: true,
  });
});

// ---------- Light and fan controls ----------

app.post("/api/switch/:name", (req, res) => {
  const s = Object.hasOwn(switches, req.params.name)
    ? switches[req.params.name]
    : null;

  const on = (req.body || {}).on;

  if (!s) {
    return res.status(404).json({
      ok: false,
      error: "Unknown switch",
    });
  }

  if (typeof on !== "boolean") {
    return res.status(400).json({
      ok: false,
      error: "on must be true or false",
    });
  }

  if (!devicesOnline(Date.now())) {
    return res.status(503).json({
      ok: false,
      error: `The ${s.label.toLowerCase()} is offline`,
    });
  }

  s.want = on;

  console.log(
    `${s.label} turned ${on ? "on" : "off"} from dashboard`
  );

  res.json({
    ok: true,
  });
});

// ---------- ESP32-CAM photo endpoint ----------

app.post(
  "/api/camera/photo",
  express.raw({
    type: "image/jpeg",
    limit: "2mb",
  }),
  async (req, res) => {

    if (req.get("X-Camera-Key") !== CAMERA_KEY) {
      return res.status(401).json({
        ok: false,
        error: "Wrong camera key",
      });
    }

    if (
      !Buffer.isBuffer(req.body) ||
      !req.body.length
    ) {
      return res.status(400).json({
        ok: false,
        error: "Send the photo as image/jpeg",
      });
    }

    if (!isFaceEngineReady()) {
      return res.status(503).json({
        ok: false,
        error: "Face recognition is disabled on this server",
      });
    }

    let descriptor;

    try {
      descriptor = await faceEngine.describe(req.body);
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: "Could not read the photo",
      });
    }

    const now = Date.now();

    const visit = {
      id: "",
      time: now,
      result: "no_face",
      name: "",
      descriptor,
    };

    let person = null;
    let note = "no face in the photo";

    if (descriptor) {
      const closest = closestPerson(descriptor);

      if (
        closest &&
        closest.distance < FACE_MATCH_THRESHOLD
      ) {
        person = closest.person;
        visit.name = person.name;

        if (devicesOnline(now)) {
          door.requestedAt = now;
          visit.result = "opened";
        } else {
          visit.result = "door_offline";
        }
      } else {
        visit.result = "unknown";
      }

      note = closest
        ? `closest: ${closest.person.name} (${closest.distance.toFixed(2)})`
        : "no faces registered";
    }

    logActivity({
      type:
        visit.result === "opened"
          ? "entered"
          : visit.result,
      name: visit.name,
      personId: person ? person.id : null,
      photo: true,
    });

    visit.id = activity[0].id;

    fs.writeFileSync(
      path.join(VISIT_PHOTO_DIR, visit.id + ".jpg"),
      req.body
    );

    visits.unshift(visit);

    if (visits.length > MAX_VISITS) {
      visits.pop();
    }

    console.log(
      `Door camera: ${visit.result} ${visit.name} (${note})`
    );

    res.json({
      ok: true,
      result: visit.result,
      name: visit.name,
    });
  }
);

// ---------- Save camera face ----------

app.post("/api/visits/:id/save", (req, res) => {
  if (!pinOk(req, res)) return;

  if (!isFaceEngineReady()) {
    return res.status(503).json({
      ok: false,
      error: "Face recognition is disabled on this server",
    });
  }

  const visit = visits.find(
    (v) => v.id === req.params.id
  );

  const person = people.find(
    (p) => p.id === (req.body || {}).personId
  );

  if (!visit || !visit.descriptor) {
    return res.status(404).json({
      ok: false,
      error: "That photo is no longer available",
    });
  }

  if (!person) {
    return res.status(404).json({
      ok: false,
      error: "Choose a person",
    });
  }

  person.descriptors.push(visit.descriptor);

  savePeople();

  res.json({
    ok: true,
  });
});

// ---------- Register a face ----------

app.post("/api/faces", async (req, res) => {
  if (!pinOk(req, res)) return;

  if (!isFaceEngineReady()) {
    return res.status(503).json({
      ok: false,
      error: "Face recognition is disabled on this server",
    });
  }

  const body = req.body || {};

  const name = toText(body.name)
    .trim()
    .slice(0, 40);

  const images = Array.isArray(body.images)
    ? body.images.slice(0, 10)
    : [];

  if (!name) {
    return res.status(400).json({
      ok: false,
      error: "Please type a name",
    });
  }

  if (!images.length) {
    return res.status(400).json({
      ok: false,
      error: "Take at least one photo",
    });
  }

  const descriptors = [];
  const failed = [];

  for (let i = 0; i < images.length; i++) {
    const jpegBuf = dataUrlToJpeg(images[i]);

    let d = null;

    try {
      d = jpegBuf
        ? await faceEngine.describe(jpegBuf)
        : null;
    } catch {
      d = null;
    }

    if (d) {
      descriptors.push(d);
    } else {
      failed.push(i);
    }
  }

  if (failed.length) {
    const error =
      failed.length === images.length
        ? "No face found in the photos. Make sure your face is well lit and fills the oval."
        : "No face found in some photos. Please retake the ones marked in red.";

    return res.status(422).json({
      ok: false,
      error,
      failed,
    });
  }

  const others = [];

  descriptors.forEach((d, i) => {
    if (
      i > 0 &&
      faceEngine.distance(
        descriptors[0],
        d
      ) > faceEngine.SAME_PERSON_DISTANCE
    ) {
      others.push(i);
    }
  });

  if (others.length) {
    return res.status(422).json({
      ok: false,
      error: "Some photos look like a different person. Please retake them.",
      failed: others,
    });
  }

  let person = people.find(
    (p) => p.name.toLowerCase() === name.toLowerCase()
  );

  if (person) {
    person.descriptors.push(...descriptors);
  } else {
    person = {
      id: newId(),
      name,
      createdAt: Date.now(),
      descriptors,
    };

    people.push(person);

    fs.writeFileSync(
      path.join(FACE_PHOTO_DIR, person.id + ".jpg"),
      dataUrlToJpeg(images[0])
    );
  }

  savePeople();

  console.log(
    `Face saved: ${person.name}`
  );

  res.json({
    ok: true,
    id: person.id,
    name: person.name,
  });
});

// ---------- Delete a registered face ----------

app.delete("/api/faces/:id", (req, res) => {
  if (!pinOk(req, res)) return;

  const person = people.find(
    (p) => p.id === req.params.id
  );

  if (!person) {
    return res.status(404).json({
      ok: false,
      error: "Not found",
    });
  }

  people = people.filter(
    (p) => p !== person
  );

  savePeople();

  fs.rmSync(
    path.join(FACE_PHOTO_DIR, person.id + ".jpg"),
    { force: true }
  );

  res.json({
    ok: true,
  });
});

// ---------- Activity history ----------

const ACTIVITY_GROUPS = {
  entries: ["entered", "dashboard"],
  unknown: ["unknown", "no_face"],
};

app.get("/api/activity", (req, res) => {
  const group = ACTIVITY_GROUPS[req.query.group];

  const person =
    typeof req.query.person === "string"
      ? req.query.person
      : "";

  const before =
    Number(req.query.before) || Infinity;

  const limit = Math.min(
    100,
    Math.max(1, Number(req.query.limit) || 50)
  );

  const list = activity.filter((a) =>
    a.time < before &&
    (!group || group.includes(a.type)) &&
    (!person || a.personId === person)
  );

  const midnight = new Date();

  midnight.setHours(0, 0, 0, 0);

  const today = activity.filter(
    (a) => a.time >= midnight.getTime()
  );

  res.set("Cache-Control", "no-store");

  res.json({
    items: list
      .slice(0, limit)
      .map(activityInfo),

    more: list.length > limit,

    people: peopleList(),

    today: {
      entries: today.filter(
        (a) => ACTIVITY_GROUPS.entries.includes(a.type)
      ).length,

      unknown: today.filter(
        (a) => ACTIVITY_GROUPS.unknown.includes(a.type)
      ).length,
    },
  });
});

// ---------- Latest dashboard data ----------

app.get("/api/latest", (req, res) => {
  const now = Date.now();

  res.set("Cache-Control", "no-store");

  res.json({
    latest,
    door: doorState(now),
    switches: switchStates(now),
    faces: peopleList(),
    visit: visitInfo(visits[0]),
    activity: activity
      .slice(0, 5)
      .map(activityInfo),
    serverTime: now,
  });
});

// ---------- Dashboard pages ----------

app.get("/", (req, res) => {
  const now = Date.now();

  const age = latest
    ? now - latest.time
    : null;

  res.render("index", {
    latest,
    age,
    live:
      latest !== null &&
      age < OFFLINE_AFTER_MS,

    door: doorState(now),

    switches: switchStates(now),

    switchLabels: Object.fromEntries(
      Object.entries(switches).map(
        ([name, s]) => [name, s.label]
      )
    ),

    pinRequired: DOOR_PIN !== "",
  });
});

app.get("/register", (req, res) => {
  res.render("register", {
    pinRequired: DOOR_PIN !== "",
  });
});

app.get("/history", (req, res) => {
  res.render("history");
});

// ---------- Health check ----------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    server: "Smart Room",
    esp32Online: devicesOnline(),
    temperatureAvailable: latest !== null,
    faceRecognitionEnabled: isFaceEngineReady(),
    time: Date.now(),
  });
});

// ---------- Error handling ----------

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  if (err.type === "entity.parse.failed") {
    if (req.path === "/rpc") {
      return res.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error",
        },
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Invalid JSON",
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      error: "Request too large",
    });
  }

  res.status(500).json({
    ok: false,
    error: "Internal server error",
  });
});

// ---------- Start server ----------

const server = app.listen(PORT, HOST, () => {
  console.log("");
  console.log("==================================");
  console.log(" Smart Room server is running");
  console.log("==================================");
  console.log("");

  console.log(`Port: ${PORT}`);
  console.log(`Host: ${HOST}`);
  console.log(`Face recognition enabled: ${isFaceEngineReady()}`);

  console.log("");
  console.log("ESP32 RPC endpoint:");
  console.log("https://smart-room-exsy.onrender.com/rpc");

  console.log("");
  console.log("Dashboard:");
  console.log("https://smart-room-exsy.onrender.com");

  console.log("");
  console.log("Health check:");
  console.log("https://smart-room-exsy.onrender.com/health");

  console.log("");
  console.log("Waiting for ESP32 data...");
  console.log("");
});

server.on("error", (err) => {
  console.error("Server startup error:", err);

  process.exit(1);
});
