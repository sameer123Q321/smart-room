
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const supabase = require("./supabase");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const OFFLINE_AFTER_MS = 15000;
const DEVICES_OFFLINE_AFTER_MS = 5000;

const DOOR_PIN = process.env.DOOR_PIN;
const CAMERA_KEY = process.env.CAMERA_KEY;
const LAPTOP_AGENT_KEY = process.env.LAPTOP_AGENT_KEY;

const UNLOCK_MS = 3000;
const REQUEST_EXPIRES_MS = 5000;
const LIGHT_ON_WHEN_DOOR_OPENS = true;

const REGISTERED_BUCKET = "registered-faces";
const ATTEMPTS_BUCKET = "camera-attempts";

if (!DOOR_PIN || !CAMERA_KEY || !LAPTOP_AGENT_KEY) {
  throw new Error(
    "Missing DOOR_PIN, CAMERA_KEY or LAPTOP_AGENT_KEY environment variable"
  );
}

let latest = null;
let espLastSeen = 0;

const door = {
  requestedAt: 0,
  unlockUntil: 0,
  open: false
};

let wrongPins = 0;
let pinBlockedUntil = 0;

const switches = {
  light: { label: "Light", want: false, on: false },
  fan: { label: "Fan", want: false, on: false }
};

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function newId() {
  return crypto.randomBytes(12).toString("hex");
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toText(value) {
  return value == null ? "" : String(value).slice(0, 100);
}

function devicesOnline(now = Date.now()) {
  return now - espLastSeen < DEVICES_OFFLINE_AFTER_MS;
}

function doorRequested(now) {
  return (
    door.requestedAt > 0 &&
    now - door.requestedAt < REQUEST_EXPIRES_MS
  );
}

function doorState(now = Date.now()) {
  return {
    online: devicesOnline(now),
    open: door.open,
    remainingMs: doorRequested(now)
      ? UNLOCK_MS
      : Math.max(0, door.unlockUntil - now),
    pinRequired: true
  };
}

function switchStates(now = Date.now()) {
  const result = {};

  for (const [name, item] of Object.entries(switches)) {
    result[name] = {
      online: devicesOnline(now),
      want: item.want,
      on: item.on
    };
  }

  return result;
}

function dataUrlToJpeg(value) {
  const match =
    /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(
      typeof value === "string" ? value : ""
    );

  if (!match) return null;

  const buffer = Buffer.from(match[1], "base64");

  if (
    buffer.length < 4 ||
    buffer[0] !== 0xff ||
    buffer[1] !== 0xd8
  ) {
    return null;
  }

  return buffer;
}

function validJpeg(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  );
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a || ""));
  const second = Buffer.from(String(b || ""));

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

function agentAuth(req, res, next) {
  if (
    !safeEqual(
      req.get("X-Laptop-Agent-Key"),
      LAPTOP_AGENT_KEY
    )
  ) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized laptop agent"
    });
  }

  next();
}

function cameraAuth(req, res, next) {
  if (!safeEqual(req.get("X-Camera-Key"), CAMERA_KEY)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized camera"
    });
  }

  next();
}

function pinOk(req, res) {
  const now = Date.now();

  if (now < pinBlockedUntil) {
    res.status(429).json({
      ok: false,
      error: "Too many wrong PINs. Try again in a minute."
    });

    return false;
  }

  if (
    !safeEqual(
      (req.body || {}).pin,
      DOOR_PIN
    )
  ) {
    wrongPins++;

    if (wrongPins >= 5) {
      pinBlockedUntil = now + 60000;
      wrongPins = 0;
    }

    res.status(401).json({
      ok: false,
      error: "Wrong PIN"
    });

    return false;
  }

  wrongPins = 0;
  return true;
}

async function logActivity(entry) {
  const row = {
    id: newId(),
    event_type: entry.type,
    person_id: entry.personId || null,
    person_name: entry.name || "",
    photo_path: entry.photoPath || null,
    details: entry.details || {},
    created_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("activity_events")
    .insert(row);

  if (error) {
    console.error("Activity database error:", error.message);
  }

  return row;
}

async function signedPhoto(bucket, storagePath) {
  if (!storagePath) return null;

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(storagePath, 3600);

  if (error) {
    console.error("Signed URL error:", error.message);
    return null;
  }

  return data.signedUrl;
}

// --------------------------------------------------
// EXPRESS SETUP
// --------------------------------------------------

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/api/faces", express.json({ limit: "15mb" }));
app.use(express.json({ limit: "10kb" }));

app.use(express.static(path.join(__dirname, "public")));

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

// --------------------------------------------------
// EJS HELPERS
// --------------------------------------------------

app.locals.STATUS_CLASS = {
  Comfortable: "good",
  Good: "good",
  Warm: "warn",
  Dry: "warn",
  "A bit humid": "warn",
  Hot: "bad",
  "Too hot": "bad",
  "Too humid": "bad",
  Cold: "cold"
};

app.locals.fmt = (n, digits) =>
  typeof n === "number" ? n.toFixed(digits) : "--";

app.locals.ago = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) return seconds + " s ago";

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return minutes + " min ago";

  return Math.floor(minutes / 60) + " h ago";
};

// --------------------------------------------------
// JSON-RPC FOR ESP32
// --------------------------------------------------

function rpcError(code, message) {
  const error = new Error(message);
  error.rpcCode = code;
  return error;
}

const rpcMethods = {
  "room.report"(params, req) {
    const reading = {
      temperature: toNumber(params.temperature),
      humidity: toNumber(params.humidity),
      feelsLike: toNumber(params.feelsLike),
      tempStatus: toText(params.tempStatus),
      humidityStatus: toText(params.humidityStatus),
      advice: toText(params.advice),
      time: Date.now(),
      from: (req.socket.remoteAddress || "").replace(
        /^::ffff:/,
        ""
      )
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

    latest = reading;

    return true;
  },

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
      }
    }

    return {
      unlockMs: Math.max(0, door.unlockUntil - now)
    };
  }
};

for (const [name, item] of Object.entries(switches)) {
  rpcMethods[name + ".check"] = (params) => {
    item.on = params.on === true;

    return {
      on: item.want
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
        message: "Invalid request"
      }
    };
  }

  let reply;

  if (!Object.hasOwn(rpcMethods, call.method)) {
    reply = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: "Method not found"
      }
    };
  } else {
    try {
      reply = {
        jsonrpc: "2.0",
        id,
        result: rpcMethods[call.method](
          call.params || {},
          req
        )
      };
    } catch (error) {
      if (!error.rpcCode) throw error;

      reply = {
        jsonrpc: "2.0",
        id,
        error: {
          code: error.rpcCode,
          message: error.message
        }
      };
    }
  }

  return call.id === undefined ? null : reply;
}

app.post("/rpc", (req, res) => {
  espLastSeen = Date.now();

  const body = req.body;

  if (Array.isArray(body)) {
    if (!body.length) {
      return res.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: "Invalid request"
        }
      });
    }

    const replies = body
      .map((call) => runRpcCall(call, req))
      .filter(Boolean);

    return replies.length
      ? res.json(replies)
      : res.status(204).end();
  }

  const reply = runRpcCall(body, req);

  return reply
    ? res.json(reply)
    : res.status(204).end();
});

// --------------------------------------------------
// DASHBOARD DOOR CONTROL
// --------------------------------------------------

app.post("/api/door/open", async (req, res) => {
  if (!pinOk(req, res)) return;

  const now = Date.now();

  if (!doorState(now).online) {
    return res.status(503).json({
      ok: false,
      error: "The door lock is offline"
    });
  }

  door.requestedAt = now;

  await logActivity({
    type: "dashboard"
  });

  res.json({ ok: true });
});

// --------------------------------------------------
// LIGHT AND FAN
// --------------------------------------------------

app.post("/api/switch/:name", (req, res) => {
  const item = Object.hasOwn(switches, req.params.name)
    ? switches[req.params.name]
    : null;

  const on = (req.body || {}).on;

  if (!item) {
    return res.status(404).json({
      ok: false,
      error: "Unknown switch"
    });
  }

  if (typeof on !== "boolean") {
    return res.status(400).json({
      ok: false,
      error: "on must be true or false"
    });
  }

  if (!devicesOnline()) {
    return res.status(503).json({
      ok: false,
      error: `The ${item.label.toLowerCase()} is offline`
    });
  }

  item.want = on;

  res.json({ ok: true });
});

// --------------------------------------------------
// ESP32-CAM UPLOAD
// --------------------------------------------------

app.post(
  "/api/camera/photo",
  cameraAuth,
  express.raw({
    type: "image/jpeg",
    limit: "2mb"
  }),
  async (req, res) => {
    try {
      if (!validJpeg(req.body)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid JPEG image"
        });
      }

      const captureId = newId();
      const storagePath = `${captureId}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from(ATTEMPTS_BUCKET)
        .upload(storagePath, req.body, {
          contentType: "image/jpeg",
          upsert: false
        });

      if (uploadError) {
        console.error("Camera photo upload:", uploadError.message);

        return res.status(500).json({
          ok: false,
          error: "Could not save camera photo"
        });
      }

      const capturedAt = new Date().toISOString();

      const { data: attempt, error: dbError } = await supabase
        .from("camera_attempts")
        .insert({
          capture_id: captureId,
          image_path: storagePath,
          result: "pending",
          recognition_status: "pending",
          captured_at: capturedAt
        })
        .select()
        .single();

      if (dbError) {
        await supabase.storage
          .from(ATTEMPTS_BUCKET)
          .remove([storagePath]);

        console.error("Camera record:", dbError.message);

        return res.status(500).json({
          ok: false,
          error: "Could not create camera record"
        });
      }

      await logActivity({
        type: "pending",
        photoPath: storagePath,
        details: {
          captureId,
          attemptId: attempt.id
        }
      });

      console.log("Camera photo queued:", captureId);

      return res.json({
        ok: true,
        queued: true,
        captureId
      });
    } catch (error) {
      console.error("Camera upload error:", error.message);

      return res.status(500).json({
        ok: false,
        error: "Camera upload failed"
      });
    }
  }
);

// --------------------------------------------------
// REGISTER FIVE FACE PHOTOS
// --------------------------------------------------

const FACE_ANGLES = [
  "straight",
  "left",
  "right",
  "up",
  "down"
];

app.post("/api/faces", async (req, res) => {
  if (!pinOk(req, res)) return;

  try {
    const body = req.body || {};

    const name = toText(body.name).trim().slice(0, 40);

    const images = Array.isArray(body.images)
      ? body.images
      : [];

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Please type a name"
      });
    }

    if (images.length !== 5) {
      return res.status(400).json({
        ok: false,
        error: "Exactly five face photos are required"
      });
    }

    const buffers = images.map(dataUrlToJpeg);

    const failed = [];

    buffers.forEach((buffer, index) => {
      if (!buffer || !validJpeg(buffer)) {
        failed.push(index);
      }
    });

    if (failed.length) {
      return res.status(422).json({
        ok: false,
        error: "Some photos are invalid. Please retake them.",
        failed
      });
    }

    const { data: existingPeople, error: peopleError } =
      await supabase
        .from("people")
        .select("id,name");

    if (peopleError) throw peopleError;

    const existing = (existingPeople || []).find(
      (person) =>
        person.name.toLowerCase() === name.toLowerCase()
    );

    if (existing) {
      return res.status(409).json({
        ok: false,
        error: "A person with this name is already registered"
      });
    }

    const { data: person, error: insertError } =
      await supabase
        .from("people")
        .insert({
          name,
          sync_status: "pending"
        })
        .select()
        .single();

    if (insertError) throw insertError;

    const uploadedPaths = [];
    const photoRows = [];

    for (let i = 0; i < buffers.length; i++) {
      const angle = FACE_ANGLES[i];
      const storagePath =
        `${person.id}/${angle}_${Date.now()}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from(REGISTERED_BUCKET)
        .upload(storagePath, buffers[i], {
          contentType: "image/jpeg",
          upsert: false
        });

      if (uploadError) {
        throw uploadError;
      }

      uploadedPaths.push(storagePath);

      photoRows.push({
        person_id: person.id,
        storage_path: storagePath,
        angle
      });
    }

    const { error: photosError } = await supabase
      .from("face_photos")
      .insert(photoRows);

    if (photosError) throw photosError;

    await logActivity({
      type: "registered",
      personId: person.id,
      name: person.name,
      details: {
        photoCount: 5
      }
    });

    console.log("Face registration uploaded:", name);

    return res.json({
      ok: true,
      id: person.id,
      name: person.name,
      photoCount: 5,
      status: "pending"
    });
  } catch (error) {
    console.error("Face registration error:", error.message);

    return res.status(500).json({
      ok: false,
      error: "Could not save registration. Please try again."
    });
  }
});

// --------------------------------------------------
// DELETE REGISTERED PERSON
// --------------------------------------------------

app.delete("/api/faces/:id", async (req, res) => {
  if (!pinOk(req, res)) return;

  try {
    const { data: photos, error: photoError } = await supabase
      .from("face_photos")
      .select("storage_path")
      .eq("person_id", req.params.id);

    if (photoError) throw photoError;

    const paths = (photos || []).map((photo) => photo.storage_path);

    if (paths.length) {
      const { error: storageError } = await supabase.storage
        .from(REGISTERED_BUCKET)
        .remove(paths);

      if (storageError) throw storageError;
    }

    const { error: deleteError } = await supabase
      .from("people")
      .delete()
      .eq("id", req.params.id);

    if (deleteError) throw deleteError;

    res.json({ ok: true });
  } catch (error) {
    console.error("Delete face error:", error.message);

    res.status(500).json({
      ok: false,
      error: "Could not delete this person"
    });
  }
});

// --------------------------------------------------
// LAPTOP AGENT: GET REGISTERED PEOPLE AND PHOTOS
// --------------------------------------------------

app.get(
  "/api/agent/registrations",
  agentAuth,
  async (req, res) => {
    try {
      const { data: people, error: peopleError } = await supabase
        .from("people")
        .select("id,name,sync_status,created_at")
        .order("created_at", { ascending: true });

      if (peopleError) throw peopleError;

      const result = [];

      for (const person of people || []) {
        const { data: photos, error: photosError } = await supabase
          .from("face_photos")
          .select("id,storage_path,angle")
          .eq("person_id", person.id);

        if (photosError) throw photosError;

        const photoList = [];

        for (const photo of photos || []) {
          const url = await signedPhoto(
            REGISTERED_BUCKET,
            photo.storage_path
          );

          if (url) {
            photoList.push({
              id: photo.id,
              angle: photo.angle,
              url
            });
          }
        }

        result.push({
          id: person.id,
          name: person.name,
          status: person.sync_status,
          photos: photoList
        });
      }

      res.set("Cache-Control", "no-store");

      res.json({
        ok: true,
        people: result
      });
    } catch (error) {
      console.error("Agent registration error:", error.message);

      res.status(500).json({
        ok: false,
        error: "Could not load registrations"
      });
    }
  }
);

// --------------------------------------------------
// LAPTOP AGENT: MARK REGISTRATION SYNCHRONIZED
// --------------------------------------------------

app.post(
  "/api/agent/registrations/:id/synced",
  agentAuth,
  async (req, res) => {
    const { error } = await supabase
      .from("people")
      .update({
        sync_status: "synced",
        updated_at: new Date().toISOString()
      })
      .eq("id", req.params.id);

    if (error) {
      return res.status(500).json({
        ok: false,
        error: "Could not update registration status"
      });
    }

    res.json({ ok: true });
  }
);

// --------------------------------------------------
// LAPTOP AGENT: CLAIM PENDING CAMERA CAPTURES
// --------------------------------------------------

app.get(
  "/api/agent/captures",
  agentAuth,
  async (req, res) => {
    try {
      const limit = Math.min(
        10,
        Math.max(1, Number(req.query.limit) || 5)
      );

      const { data: attempts, error } = await supabase
        .from("camera_attempts")
        .select("*")
        .eq("recognition_status", "pending")
        .order("captured_at", { ascending: true })
        .limit(limit);

      if (error) throw error;

      const captures = [];

      for (const attempt of attempts || []) {
        const url = await signedPhoto(
          ATTEMPTS_BUCKET,
          attempt.image_path
        );

        if (url) {
          captures.push({
            id: attempt.id,
            captureId: attempt.capture_id,
            url,
            capturedAt: attempt.captured_at
          });
        }
      }

      res.set("Cache-Control", "no-store");

      res.json({
        ok: true,
        captures
      });
    } catch (error) {
      console.error("Agent capture queue:", error.message);

      res.status(500).json({
        ok: false,
        error: "Could not load camera queue"
      });
    }
  }
);

// --------------------------------------------------
// LAPTOP AGENT: SEND RECOGNITION RESULT
// --------------------------------------------------

app.post(
  "/api/agent/captures/:id/result",
  agentAuth,
  async (req, res) => {
    try {
      const body = req.body || {};

      const allowedResults = [
        "entered",
        "unknown",
        "no_face",
        "door_offline"
      ];

      if (!allowedResults.includes(body.result)) {
        return res.status(400).json({
          ok: false,
          error: "Invalid recognition result"
        });
      }

      let person = null;

      if (body.personId) {
        const { data, error } = await supabase
          .from("people")
          .select("id,name")
          .eq("id", body.personId)
          .maybeSingle();

        if (error) throw error;

        person = data;

        if (!person) {
          return res.status(400).json({
            ok: false,
            error: "Registered person not found"
          });
        }
      }

      let result = body.result;

      if (result === "entered") {
        if (!person) {
          return res.status(400).json({
            ok: false,
            error: "A person ID is required for an authorized result"
          });
        }

        if (devicesOnline()) {
          door.requestedAt = Date.now();
        } else {
          result = "door_offline";
        }
      }

      const now = new Date().toISOString();

      const { data: attempt, error: attemptError } =
        await supabase
          .from("camera_attempts")
          .update({
            person_id: person ? person.id : null,
            person_name: person ? person.name : null,
            result,
            recognition_status: "completed",
            recognized_at: now,
            processed_at: now,
            details: {
              distance: toNumber(body.distance),
              note: toText(body.note)
            }
          })
          .eq("id", req.params.id)
          .eq("recognition_status", "pending")
          .select("id,image_path,captured_at")
          .maybeSingle();

      if (attemptError) throw attemptError;

      if (!attempt) {
        return res.status(409).json({
          ok: false,
          error: "Capture already processed or not found"
        });
      }

      const { error: activityError } = await supabase
        .from("activity_events")
        .insert({
          id: newId(),
          event_type: result,
          person_id: person ? person.id : null,
          person_name: person ? person.name : "",
          photo_path: attempt.image_path,
          details: {
            captureId: req.params.id,
            distance: toNumber(body.distance),
            note: toText(body.note)
          },
          created_at: now
        });

      if (activityError) throw activityError;

      console.log(
        `Laptop recognition: ${result} ${person ? person.name : ""}`
      );

      res.json({
        ok: true,
        result,
        doorRequested: result === "entered"
      });
    } catch (error) {
      console.error("Recognition result error:", error.message);

      res.status(500).json({
        ok: false,
        error: "Could not save recognition result"
      });
    }
  }
);

// --------------------------------------------------
// ACTIVITY HISTORY
// --------------------------------------------------

const ACTIVITY_GROUPS = {
  entries: ["entered", "dashboard"],
  unknown: ["unknown", "no_face", "door_offline"]
};

app.get("/api/activity", async (req, res) => {
  try {
    const group = ACTIVITY_GROUPS[req.query.group];

    const person =
      typeof req.query.person === "string"
        ? req.query.person
        : "";

    const limit = Math.min(
      100,
      Math.max(1, Number(req.query.limit) || 50)
    );

    let query = supabase
      .from("activity_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit + 1);

    if (group) {
      query = query.in("event_type", group);
    }

    if (person) {
      query = query.eq("person_id", person);
    }

    if (req.query.before) {
      const beforeDate = new Date(Number(req.query.before));

      if (!Number.isNaN(beforeDate.getTime())) {
        query = query.lt("created_at", beforeDate.toISOString());
      }
    }

    const { data: events, error } = await query;

    if (error) throw error;

    const selected = (events || []).slice(0, limit);

    const items = [];

    for (const event of selected) {
      const photoUrl = await signedPhoto(
        ATTEMPTS_BUCKET,
        event.photo_path
      );

      items.push({
        id: event.id,
        time: new Date(event.created_at).getTime(),
        type: event.event_type,
        name: event.person_name || "",
        personId: event.person_id,
        photo: photoUrl
      });
    }

    const { data: people, error: peopleError } = await supabase
      .from("people")
      .select("id,name");

    if (peopleError) throw peopleError;

    const { data: allEvents, error: eventError } = await supabase
      .from("activity_events")
      .select("event_type,person_id,created_at");

    if (eventError) throw eventError;

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const today = (allEvents || []).filter(
      (event) => new Date(event.created_at) >= midnight
    );

    const peopleList = (people || []).map((p) => {
      const entries = (allEvents || []).filter(
        (event) =>
          event.event_type === "entered" &&
          event.person_id === p.id
      );

      return {
        id: p.id,
        name: p.name,
        photos: 5,
        entries: entries.length,
        lastSeen: entries.length
          ? new Date(entries[0].created_at).getTime()
          : null
      };
    });

    res.set("Cache-Control", "no-store");

    res.json({
      items,
      more: (events || []).length > limit,
      people: peopleList,
      today: {
        entries: today.filter(
          (event) =>
            ACTIVITY_GROUPS.entries.includes(event.event_type)
        ).length,
        unknown: today.filter(
          (event) =>
            ACTIVITY_GROUPS.unknown.includes(event.event_type)
        ).length
      }
    });
  } catch (error) {
    console.error("Activity history error:", error.message);

    res.status(500).json({
      ok: false,
      error: "Could not load activity history"
    });
  }
});

// --------------------------------------------------
// LATEST DASHBOARD DATA
// --------------------------------------------------

app.get("/api/latest", async (req, res) => {
  try {
    const { data: people, error: peopleError } = await supabase
      .from("people")
      .select("id,name");

    if (peopleError) throw peopleError;

    const { data: events, error: eventsError } = await supabase
      .from("activity_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5);

    if (eventsError) throw eventsError;

    const activity = [];

    for (const event of events || []) {
      activity.push({
        id: event.id,
        time: new Date(event.created_at).getTime(),
        type: event.event_type,
        name: event.person_name || "",
        personId: event.person_id,
        photo: await signedPhoto(
          ATTEMPTS_BUCKET,
          event.photo_path
        )
      });
    }

    const { data: lastAttempt, error: visitError } = await supabase
      .from("camera_attempts")
      .select("*")
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (visitError) throw visitError;

    res.set("Cache-Control", "no-store");

    res.json({
      latest,
      door: doorState(),
      switches: switchStates(),
      faces: (people || []).map((p) => ({
        id: p.id,
        name: p.name
      })),
      visit: lastAttempt
        ? {
            id: lastAttempt.id,
            time: new Date(lastAttempt.captured_at).getTime(),
            result: lastAttempt.result,
            name: lastAttempt.person_name || "",
            photo: await signedPhoto(
              ATTEMPTS_BUCKET,
              lastAttempt.image_path
            )
          }
        : null,
      activity,
      serverTime: Date.now()
    });
  } catch (error) {
    console.error("Latest data error:", error.message);

    res.status(500).json({
      ok: false,
      error: "Could not load latest data"
    });
  }
});

// --------------------------------------------------
// DASHBOARD PAGES
// --------------------------------------------------

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
        ([name, item]) => [name, item.label]
      )
    ),
    pinRequired: true
  });
});

app.get("/register", (req, res) => {
  res.render("register", {
    pinRequired: true
  });
});

app.get("/history", (req, res) => {
  res.render("history");
});

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    server: "Smart Room",
    esp32Online: devicesOnline(),
    temperatureAvailable: latest !== null,
    faceRecognition: "Laptop agent",
    time: Date.now()
  });
});

// --------------------------------------------------
// ERROR HANDLING
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);

  if (err.type === "entity.parse.failed") {
    if (req.path === "/rpc") {
      return res.json({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error"
        }
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Invalid JSON"
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      error: "Request too large"
    });
  }

  res.status(500).json({
    ok: false,
    error: "Internal server error"
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const server = app.listen(PORT, HOST, () => {
  console.log("==================================");
  console.log(" Smart Room server is running");
  console.log("==================================");
  console.log("Port:", PORT);
  console.log("Host:", HOST);
  console.log("Face recognition: Laptop agent");
  console.log("Dashboard: https://smart-room-exsy.onrender.com");
  console.log("ESP32 RPC: https://smart-room-exsy.onrender.com/rpc");
  console.log("Health: https://smart-room-exsy.onrender.com/health");
});

server.on("error", (error) => {
  console.error("Server startup error:", error);
  process.exit(1);
});
