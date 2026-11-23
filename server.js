// Smart Room server (Express + EJS)
// Receives readings from the ESP32 over WiFi, shows them on a live dashboard
// and lets you open the door lock and switch the LED strip from the dashboard.
// The ESP32-CAM at the door sends a photo when its button is pressed - if the
// face belongs to someone registered on the dashboard, the door opens.
//
// First time:  npm install
// Run it:      npm start

const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const faceEngine = require("./face-engine");

const app = express();

const PORT = Number(process.env.PORT) || 3000;  // change with:  PORT=4000 npm start
const HOST = "0.0.0.0";   // listen on ALL network interfaces, so the ESP32 can reach it
const OFFLINE_AFTER_MS = 15000;
const DEVICES_OFFLINE_AFTER_MS = 5000; // ESP32 hasn't checked in for this long = door, light + fan offline

let latest = null;
let espLastSeen = 0;

function devicesOnline(now) {
  return now - espLastSeen < DEVICES_OFFLINE_AFTER_MS;
}

// ---------- Door lock ----------
const DOOR_PIN = "1234";           // PIN asked on the dashboard before opening. CHANGE IT! ("" = no PIN)
const UNLOCK_MS = 3000;             // door unlocks, then locks again by itself after this long
const REQUEST_EXPIRES_MS = 5000;    // "Open door" not picked up by the ESP32 in this time = cancelled
const LIGHT_ON_WHEN_DOOR_OPENS = true;  // turn the LED strip on every time the door unlocks

const door = { requestedAt: 0, unlockUntil: 0, open: false };
let wrongPins = 0;
let pinBlockedUntil = 0;

// "Open door" was pressed and the ESP32 hasn't picked it up yet
function doorRequested(now) {
  return door.requestedAt > 0 && now - door.requestedAt < REQUEST_EXPIRES_MS;
}

function doorState(now) {
  return {
    online: devicesOnline(now),
    open: door.open,
    remainingMs: doorRequested(now) ? UNLOCK_MS : Math.max(0, door.unlockUntil - now),
    pinRequired: DOOR_PIN !== "",
  };
}

// ---------- On/off switches (LED strip, fan) ----------
// want = what the dashboard asked for, on = what the ESP32 says the relay is doing
const switches = {
  light: { label: "Light", want: false, on: false },
  fan:   { label: "Fan",   want: false, on: false },
};

function switchStates(now) {
  const states = {};
  for (const [name, s] of Object.entries(switches)) {
    states[name] = { online: devicesOnline(now), want: s.want, on: s.on };
  }
  return states;
}

// ---------- Door camera (ESP32-CAM) + faces ----------
const CAMERA_KEY = "smart-room-cam";   // must match CAMERA_KEY in esp32-cam.ino. CHANGE IT in both!
const FACE_MATCH_THRESHOLD = faceEngine.MATCH_DISTANCE;  // lower = stricter (see face-engine.js)
const MAX_VISITS = 20;                 // recent door camera faces kept for "Save face"
const MAX_ACTIVITY = 500;              // history entries kept (with their photos)

const DATA_DIR = path.join(__dirname, "data");
const FACES_FILE = path.join(DATA_DIR, "faces.json");
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
const FACE_PHOTO_DIR = path.join(DATA_DIR, "faces");
const VISIT_PHOTO_DIR = path.join(DATA_DIR, "visits");

fs.mkdirSync(FACE_PHOTO_DIR, { recursive: true });
fs.mkdirSync(VISIT_PHOTO_DIR, { recursive: true });

// Registered people: [{ id, name, createdAt, descriptors: [[128 numbers], ...] }]
// A "descriptor" is the face fingerprint face-engine makes from one photo.
let people = [];
try {
  people = JSON.parse(fs.readFileSync(FACES_FILE, "utf8"));
} catch (e) {
  people = [];
}

function savePeople() {
  fs.writeFileSync(FACES_FILE, JSON.stringify(people));
}

// Recent door camera photos with their face, newest first: { id, time, result, name, descriptor }
const visits = [];

// History of everything that happened at the door, newest first:
// { id, time, type, name, personId, photo }
//   type: "entered"      - registered face, door opened
//         "dashboard"    - door opened with the dashboard button
//         "unknown"      - face not registered, door stayed locked
//         "no_face"      - button pressed but no face in the photo
//         "door_offline" - registered face, but the door lock was offline
let activity = [];
try {
  activity = JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8"));
} catch (e) {
  activity = [];
}

function logActivity(entry) {
  activity.unshift({ id: newId(), time: Date.now(), name: "", personId: null, photo: false, ...entry });
  while (activity.length > MAX_ACTIVITY) {
    const old = activity.pop();
    if (old.photo) fs.rmSync(path.join(VISIT_PHOTO_DIR, old.id + ".jpg"), { force: true });
  }
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity));
}

function activityInfo(a) {
  return { id: a.id, time: a.time, type: a.type, name: a.name, personId: a.personId, photo: a.photo ? `/visits/${a.id}.jpg` : null };
}

function newId() {
  return crypto.randomBytes(6).toString("hex");
}

// The registered person whose face is closest to this one: { person, distance } or null
function closestPerson(descriptor) {
  let best = null;
  for (const person of people) {
    for (const d of person.descriptors) {
      if (d.length !== descriptor.length) continue;  // saved by an older face engine
      const dist = faceEngine.distance(descriptor, d);
      if (!best || dist < best.distance) best = { person, distance: dist };
    }
  }
  return best;
}

// Each person with how often and when they last came in
function peopleList() {
  return people.map((p) => {
    const entries = activity.filter((a) => a.type === "entered" && a.personId === p.id);
    return {
      id: p.id,
      name: p.name,
      photos: p.descriptors.length,
      entries: entries.length,
      lastSeen: entries.length ? entries[0].time : null,
    };
  });
}

function visitInfo(v) {
  if (!v) return null;
  return { id: v.id, time: v.time, result: v.result, name: v.name, hasFace: !!v.descriptor, photo: `/visits/${v.id}.jpg` };
}

// Photos from the dashboard arrive as "data:image/jpeg;base64,..."
function dataUrlToJpeg(value) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(typeof value === "string" ? value : "");
  return m ? Buffer.from(m[1], "base64") : null;
}

// Faces saved by an older face engine have a different kind of fingerprint. Rebuild them from
// the photos we still have: the "Add face" photo, and door camera photos that recognised them.
async function updateOldFaces() {
  for (const person of people) {
    if (person.descriptors.every((d) => d.length === faceEngine.DIM)) continue;

    const photos = [path.join(FACE_PHOTO_DIR, person.id + ".jpg")];
    for (const a of activity) {
      if (a.personId === person.id && a.photo) photos.push(path.join(VISIT_PHOTO_DIR, a.id + ".jpg"));
    }

    const descriptors = [];
    for (const file of photos.slice(0, 10)) {
      try {
        const d = await faceEngine.describe(fs.readFileSync(file));
        if (d) descriptors.push(d);
      } catch (err) {
        // photo missing or unreadable - skip it
      }
    }
    person.descriptors = descriptors;
    console.log(descriptors.length
      ? `Face updated for the new face engine: ${person.name} (${descriptors.length} photos)`
      : `${person.name} needs to be added again on the dashboard (no usable photo found)`);
  }
  savePeople();
}

// Face recognition loads in the background - the rest of the server works meanwhile.
// The first start on a new laptop downloads the models (about 190 MB).
faceEngine.init()
  .then(updateOldFaces)
  .then(() => console.log("Face recognition ready."))
  .catch((err) => console.error("Face recognition could not start:", err.message));

// ---------- Setup ----------

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/api/faces", express.json({ limit: "15mb" }));   // new faces come with 5 photos
app.use(express.json({ limit: "10kb" }));                  // read JSON sent by the ESP32 and the dashboard
app.use(express.static(path.join(__dirname, "public")));  // style.css and the page scripts
app.use("/visits", express.static(VISIT_PHOTO_DIR));       // door camera photos
app.use("/face-photos", express.static(FACE_PHOTO_DIR));   // one photo per registered person

// face-api for the "Add face" page (finds the face live so photos are taken automatically)
const FACE_API_DIR = path.join(__dirname, "node_modules", "@vladmandic", "face-api");
app.use("/vendor/face-api", express.static(path.join(FACE_API_DIR, "dist")));
app.use("/models", express.static(path.join(FACE_API_DIR, "model")));

// Helpers the EJS page can use
app.locals.STATUS_CLASS = {
  "Comfortable": "good", "Good": "good",
  "Warm": "warn", "Dry": "warn", "A bit humid": "warn",
  "Hot": "bad", "Too hot": "bad", "Too humid": "bad",
  "Cold": "cold",
};
app.locals.fmt = (n, digits) => (typeof n === "number" ? n.toFixed(digits) : "--");
app.locals.ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + " s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min ago";
  return Math.floor(m / 60) + " h ago";
};

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toText(value) {
  return value === undefined || value === null ? "" : String(value).slice(0, 100);
}

function cleanIp(ip) {
  return (ip || "").replace(/^::ffff:/, "");
}

// ---------- Routes ----------

// ---------- JSON-RPC for the ESP32 ----------
// Every second the ESP32 sends ONE request to /rpc with a batch of calls:
//   room.report  - the newest temperature / humidity reading
//   door.check   - "is the lock open right now? should it be?"
//   light.check  - "is the LED strip on right now? should it be?"
//   fan.check    - "is the fan on right now? should it be?"
// and gets all the answers back in one reply.

function rpcError(code, message) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
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
      from: cleanIp(req.socket.remoteAddress),
    };

    if (reading.temperature === null || reading.humidity === null) {
      throw rpcError(-32602, "temperature and humidity are required");
    }

    // Readings arrive every second - only print when something changed
    const changed = !latest || latest.temperature !== reading.temperature ||
      latest.humidity !== reading.humidity || latest.advice !== reading.advice;
    latest = reading;

    if (changed) {
      console.log(
        `[${new Date().toLocaleTimeString()}] from ${reading.from}: ` +
        `${reading.temperature} C, ${reading.humidity} %, feels ${reading.feelsLike} C - ${reading.advice}`
      );
    }
    return true;
  },

  // Answers how many milliseconds the lock should stay open (0 = keep it locked)
  "door.check"(params) {
    const now = Date.now();
    door.open = params.open === true;

    // The 3 seconds start now, when the ESP32 actually unlocks - not when the button was pressed
    if (doorRequested(now)) {
      door.requestedAt = 0;
      door.unlockUntil = now + UNLOCK_MS;

      // Welcome light: light.check comes right after door.check in the same request,
      // so the light switches on together with the door
      if (LIGHT_ON_WHEN_DOOR_OPENS && !switches.light.want) {
        switches.light.want = true;
        console.log(`[${new Date().toLocaleTimeString()}] Light turned on because the door opened`);
      }
    }
    return { unlockMs: Math.max(0, door.unlockUntil - now) };
  },
};

// light.check, fan.check: answer whether that switch should be on
for (const [name, s] of Object.entries(switches)) {
  rpcMethods[name + ".check"] = (params) => {
    s.on = params.on === true;
    return { on: s.want };
  };
}

// Runs one call. Returns the reply, or null for a notification (a call without an id).
function runRpcCall(call, req) {
  const id = call && (typeof call.id === "number" || typeof call.id === "string") ? call.id : null;

  if (!call || call.jsonrpc !== "2.0" || typeof call.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
  }

  let reply;
  if (!Object.hasOwn(rpcMethods, call.method)) {
    reply = { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  } else {
    try {
      reply = { jsonrpc: "2.0", id, result: rpcMethods[call.method](call.params || {}, req) };
    } catch (err) {
      if (!err.rpcCode) throw err;
      reply = { jsonrpc: "2.0", id, error: { code: err.rpcCode, message: err.message } };
    }
  }
  return call.id === undefined ? null : reply;
}

app.post("/rpc", (req, res) => {
  const body = req.body;
  espLastSeen = Date.now();

  if (Array.isArray(body)) {
    if (!body.length) {
      return res.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    }
    const replies = body.map((call) => runRpcCall(call, req)).filter(Boolean);
    return replies.length ? res.json(replies) : res.status(204).end();
  }

  const reply = runRpcCall(body, req);
  reply ? res.json(reply) : res.status(204).end();
});

// Checks the PIN the dashboard sent. When it's wrong, replies with the error and returns false.
function pinOk(req, res) {
  const now = Date.now();

  if (now < pinBlockedUntil) {
    res.status(429).json({ ok: false, error: "Too many wrong PINs. Try again in a minute." });
    return false;
  }
  if (DOOR_PIN && String((req.body || {}).pin || "") !== DOOR_PIN) {
    wrongPins++;
    if (wrongPins >= 5) {
      pinBlockedUntil = now + 60000;
      wrongPins = 0;
    }
    res.status(401).json({ ok: false, error: "Wrong PIN" });
    return false;
  }
  wrongPins = 0;
  return true;
}

// The "Open door" button on the dashboard
app.post("/api/door/open", (req, res) => {
  if (!pinOk(req, res)) return;
  const now = Date.now();

  if (!doorState(now).online) {
    return res.status(503).json({ ok: false, error: "The door lock is offline" });
  }

  door.requestedAt = now;
  logActivity({ type: "dashboard" });
  console.log(`[${new Date().toLocaleTimeString()}] Door opened from the dashboard (${cleanIp(req.socket.remoteAddress)})`);
  res.json({ ok: true });
});

// The "Turn on" / "Turn off" buttons for the light and the fan
app.post("/api/switch/:name", (req, res) => {
  const s = Object.hasOwn(switches, req.params.name) ? switches[req.params.name] : null;
  const on = (req.body || {}).on;
  if (!s) return res.status(404).json({ ok: false, error: "Unknown switch" });
  if (typeof on !== "boolean") {
    return res.status(400).json({ ok: false, error: "on must be true or false" });
  }
  if (!devicesOnline(Date.now())) {
    return res.status(503).json({ ok: false, error: `The ${s.label.toLowerCase()} is offline` });
  }

  s.want = on;
  console.log(`[${new Date().toLocaleTimeString()}] ${s.label} turned ${on ? "on" : "off"} from the dashboard (${cleanIp(req.socket.remoteAddress)})`);
  res.json({ ok: true });
});

// ---------- Door camera ----------

// The ESP32-CAM sends a JPEG here when its button is pressed
app.post("/api/camera/photo", express.raw({ type: "image/jpeg", limit: "2mb" }), async (req, res) => {
  if (req.get("X-Camera-Key") !== CAMERA_KEY) {
    return res.status(401).json({ ok: false, error: "Wrong camera key" });
  }
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ ok: false, error: "Send the photo as image/jpeg" });
  }
  if (!faceEngine.isReady()) {
    return res.status(503).json({ ok: false, error: "Face recognition is still starting" });
  }

  let descriptor;
  try {
    descriptor = await faceEngine.describe(req.body);
  } catch (err) {
    return res.status(400).json({ ok: false, error: "Could not read the photo" });
  }

  const now = Date.now();
  const visit = { id: "", time: now, result: "no_face", name: "", descriptor };
  let person = null;
  let note = "no face in the photo";

  if (descriptor) {
    const closest = closestPerson(descriptor);
    if (closest && closest.distance < FACE_MATCH_THRESHOLD) {
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
    note = closest ? `closest: ${closest.person.name} (${closest.distance.toFixed(2)})` : "no faces registered";
  }

  // The photo is kept with its history entry (and removed when the entry gets too old)
  logActivity({
    type: visit.result === "opened" ? "entered" : visit.result,
    name: visit.name,
    personId: person ? person.id : null,
    photo: true,
  });
  visit.id = activity[0].id;
  fs.writeFileSync(path.join(VISIT_PHOTO_DIR, visit.id + ".jpg"), req.body);

  visits.unshift(visit);
  if (visits.length > MAX_VISITS) visits.pop();

  console.log(`[${new Date().toLocaleTimeString()}] Door camera: ${visit.result}${visit.name ? " - " + visit.name : ""} (${note})`);
  res.json({ ok: true, result: visit.result, name: visit.name });
});

// "Save this face to ..." under the door camera photo - teaches the server this person's
// face as the door camera sees it
app.post("/api/visits/:id/save", (req, res) => {
  if (!pinOk(req, res)) return;
  const visit = visits.find((v) => v.id === req.params.id);
  const person = people.find((p) => p.id === (req.body || {}).personId);

  if (!visit || !visit.descriptor) return res.status(404).json({ ok: false, error: "That photo is no longer available" });
  if (!person) return res.status(404).json({ ok: false, error: "Choose a person" });

  person.descriptors.push(visit.descriptor);
  savePeople();
  console.log(`[${new Date().toLocaleTimeString()}] Door camera photo added to ${person.name}`);
  res.json({ ok: true });
});

// ---------- Faces ----------

// Add a person (or more photos for someone with the same name)
app.post("/api/faces", async (req, res) => {
  if (!pinOk(req, res)) return;

  const body = req.body || {};
  const name = toText(body.name).trim().slice(0, 40);
  const images = Array.isArray(body.images) ? body.images.slice(0, 10) : [];
  if (!name) return res.status(400).json({ ok: false, error: "Please type a name" });
  if (!images.length) return res.status(400).json({ ok: false, error: "Take at least one photo" });
  if (!faceEngine.isReady()) {
    return res.status(503).json({ ok: false, error: "Face recognition is still starting. Try again in a moment." });
  }

  const descriptors = [];
  const failed = [];
  for (let i = 0; i < images.length; i++) {
    const jpegBuf = dataUrlToJpeg(images[i]);
    let d = null;
    try {
      d = jpegBuf ? await faceEngine.describe(jpegBuf) : null;
    } catch (err) {
      d = null;
    }
    if (d) descriptors.push(d);
    else failed.push(i);
  }

  if (failed.length) {
    const error = failed.length === images.length
      ? "No face found in the photos. Make sure your face is well lit and fills the oval."
      : "No face found in some photos. Please retake the ones marked in red.";
    return res.status(422).json({ ok: false, error, failed });
  }

  // All photos must show the same person
  const others = [];
  descriptors.forEach((d, i) => {
    if (i > 0 && faceEngine.distance(descriptors[0], d) > faceEngine.SAME_PERSON_DISTANCE) others.push(i);
  });
  if (others.length) {
    return res.status(422).json({ ok: false, error: "Some photos look like a different person. Please retake them.", failed: others });
  }

  let person = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (person) {
    person.descriptors.push(...descriptors);
  } else {
    person = { id: newId(), name, createdAt: Date.now(), descriptors };
    people.push(person);
    fs.writeFileSync(path.join(FACE_PHOTO_DIR, person.id + ".jpg"), dataUrlToJpeg(images[0]));
  }
  savePeople();

  console.log(`[${new Date().toLocaleTimeString()}] Face saved: ${person.name} (${person.descriptors.length} photos)`);
  res.json({ ok: true, id: person.id, name: person.name });
});

app.delete("/api/faces/:id", (req, res) => {
  if (!pinOk(req, res)) return;
  const person = people.find((p) => p.id === req.params.id);
  if (!person) return res.status(404).json({ ok: false, error: "Not found" });

  people = people.filter((p) => p !== person);
  savePeople();
  fs.rmSync(path.join(FACE_PHOTO_DIR, person.id + ".jpg"), { force: true });
  console.log(`[${new Date().toLocaleTimeString()}] Face removed: ${person.name}`);
  res.json({ ok: true });
});

// ---------- History ----------

const ACTIVITY_GROUPS = {
  entries: ["entered", "dashboard"],          // the door was opened
  unknown: ["unknown", "no_face"],            // someone was not let in
};

// History page: /api/activity?group=entries|unknown&person=<id>&before=<time>&limit=50
app.get("/api/activity", (req, res) => {
  const group = ACTIVITY_GROUPS[req.query.group];
  const person = typeof req.query.person === "string" ? req.query.person : "";
  const before = Number(req.query.before) || Infinity;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

  const list = activity.filter((a) =>
    a.time < before &&
    (!group || group.includes(a.type)) &&
    (!person || a.personId === person));

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const today = activity.filter((a) => a.time >= midnight.getTime());

  res.set("Cache-Control", "no-store");
  res.json({
    items: list.slice(0, limit).map(activityInfo),
    more: list.length > limit,
    people: peopleList(),
    today: {
      entries: today.filter((a) => ACTIVITY_GROUPS.entries.includes(a.type)).length,
      unknown: today.filter((a) => ACTIVITY_GROUPS.unknown.includes(a.type)).length,
    },
  });
});

// The dashboard asks for new data here every second
app.get("/api/latest", (req, res) => {
  const now = Date.now();
  res.set("Cache-Control", "no-store");
  res.json({
    latest,
    door: doorState(now),
    switches: switchStates(now),
    faces: peopleList(),
    visit: visitInfo(visits[0]),
    activity: activity.slice(0, 5).map(activityInfo),
    serverTime: now,
  });
});

// The dashboard page, rendered by EJS with the newest data already filled in
app.get("/", (req, res) => {
  const now = Date.now();
  const age = latest ? now - latest.time : null;
  res.render("index", {
    latest,
    age,
    live: latest !== null && age < OFFLINE_AFTER_MS,
    door: doorState(now),
    switches: switchStates(now),
    switchLabels: Object.fromEntries(Object.entries(switches).map(([name, s]) => [name, s.label])),
    pinRequired: DOOR_PIN !== "",
  });
});

// The "Add face" page
app.get("/register", (req, res) => {
  res.render("register", { pinRequired: DOOR_PIN !== "" });
});

// The history page: who came in and when
app.get("/history", (req, res) => {
  res.render("history");
});

// Bad JSON from a device -> clear error instead of a crash page
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    if (req.path === "/rpc") {
      return res.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: req.path.startsWith("/api/faces") ? "The photos are too large" : "Request too large" });
  }
  next(err);
});

// ---------- Start ----------

// Find this laptop's IP addresses on the local network
function getLocalIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const isV4 = net.family === "IPv4" || net.family === 4;
      if (isV4 && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

const server = app.listen(PORT, HOST, () => {
  const ips = getLocalIps();
  console.log("");
  console.log("Smart Room server (Express) is running and listening on the network.");
  console.log("");
  console.log(`  Dashboard on this laptop:  http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  Dashboard from a phone:    http://${ip}:${PORT}`));
  console.log("");
  if (ips.length) {
    console.log("  Put this line in esp32/dht/dht.ino and esp32-cam/esp32-cam.ino:");
    ips.forEach((ip) => console.log(`    const char* SERVER_IP   = "${ip}";`));
    if (ips.length > 1) console.log("  (more than one IP found - use the one on the same WiFi as the ESP32)");
  } else {
    console.log("  No network IP found - is the laptop connected to WiFi?");
  }
  console.log("");
  console.log("Waiting for data from the ESP32...");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Close the other server or change PORT in server.js.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

faceEngine.init()
  .then(updateOldFaces)
  .then(() => console.log("Face recognition ready."))
  .catch((err) => console.error("Face recognition could not start:", err.message));