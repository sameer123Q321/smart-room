// Keeps the dashboard live: asks the server for new data every second
// and updates the page without reloading it. Also runs the door, light and fan tiles.

const REFRESH_MS = 1000;        // how often to ask the server
const OFFLINE_AFTER_MS = 15000; // no data for this long = ESP32 offline

const STATUS_CLASS = {
  "Comfortable": "good", "Good": "good",
  "Warm": "warn", "Dry": "warn", "A bit humid": "warn",
  "Hot": "bad", "Too hot": "bad", "Too humid": "bad",
  "Cold": "cold"
};

const $ = (id) => document.getElementById(id);

function fmt(n, digits) {
  return typeof n === "number" ? n.toFixed(digits) : "--";
}

function setChip(el, text) {
  el.textContent = text || "";
  el.className = "chip " + (STATUS_CLASS[text] || "");
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + " s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min ago";
  return Math.floor(m / 60) + " h ago";
}

// Short message at the bottom of the screen (instead of pop-up alerts)
let toastTimer = null;
function toast(text, kind = "bad") {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast " + kind; }, 3500);
}

function greet() {
  const h = new Date().getHours();
  const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const day = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  $("greeting").textContent = part + " · " + day;
}

// ---------- Climate ----------

function renderClimate(r, serverTime) {
  if (!r) {
    $("conn").className = "pill";
    $("connText").textContent = "Connecting...";
    return;
  }

  const age = serverTime - r.time;
  const live = age < OFFLINE_AFTER_MS;
  $("conn").className = "pill " + (live ? "live" : "offline");
  $("connText").textContent = live ? "Live" : "Sensor offline";

  $("temp").textContent = fmt(r.temperature, 1);
  $("hum").textContent = fmt(r.humidity, 0);
  $("feels").textContent = fmt(r.feelsLike, 1);
  setChip($("tempStatus"), r.tempStatus);
  setChip($("humStatus"), r.humidityStatus);

  // Bars: humidity 0-100 %, feels-like on a 10-40 °C scale
  $("humBar").style.width = Math.min(100, Math.max(0, r.humidity || 0)) + "%";
  $("feelsBar").style.width = Math.min(100, Math.max(0, ((r.feelsLike || 0) - 10) / 30 * 100)) + "%";

  $("advice").textContent = r.advice || "--";
  $("updated").textContent = "Last update: " + ago(age);
  renderAdviceButton(r.advice || "");
}

// When the advice is about the fan, offer the button right there
function renderAdviceButton(advice) {
  const fan = switches.fan;
  const btn = $("adviceBtn");
  let action = null;

  if (fan && fan.online) {
    if (/turn on the fan/i.test(advice) && !fan.want) action = { label: "Turn on fan", on: true };
    if (/turn off the ac\/fan/i.test(advice) && fan.want) action = { label: "Turn off fan", on: false };
  }

  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.disabled = !!switching.fan;
  }
}

$("adviceBtn").addEventListener("click", () => toggleSwitch("fan"));

// ---------- Door ----------

let door = null;      // newest door info from the server
let opening = false;  // true while the "Open door" request is on its way
let unlockTotal = 0;  // longest countdown seen during this unlock, for the progress bar

function renderDoor() {
  if (!door) return;
  let state, text, msg = "";

  if (!door.online) {
    state = "offline"; text = "Offline"; msg = "The door lock is not connected";
  } else if (door.open) {
    state = "unlocked"; text = "Unlocked";
    if (door.remainingMs > 0) msg = "Locks again in " + Math.ceil(door.remainingMs / 1000) + " s";
  } else if (door.remainingMs > 0 || opening) {
    state = "opening"; text = "Opening...";
  } else {
    state = "locked"; text = "Locked";
  }

  unlockTotal = door.remainingMs > 0 ? Math.max(unlockTotal, door.remainingMs) : 0;
  $("doorBar").style.width = state === "unlocked" && unlockTotal ? (door.remainingMs / unlockTotal * 100) + "%" : "0";

  $("doorTile").dataset.state = state;
  $("doorState").textContent = text;
  $("doorMsg").textContent = msg;
  $("doorBtn").disabled = opening || !door.online || state === "unlocked";
  $("doorBtn").textContent = opening ? "Opening..." : "Open door";
}

async function openDoor() {
  opening = true;
  renderDoor();

  try {
    const res = await sendWithPin("/api/door/open", {});
    if (res && !res.ok) toast(res.data.error || "Could not open the door");
  } catch (e) {
    toast("Server not reachable");
  }

  opening = false;
  refresh();
}

$("doorBtn").addEventListener("click", openDoor);

// ---------- Light + fan ----------

let switches = {};          // newest light/fan info from the server
const switching = {};       // name -> true while its request is on its way

function renderSwitch(name) {
  const s = switches[name];
  const tile = $(name + "Btn");
  if (!s || !tile) return;
  const label = tile.dataset.label;
  let text, msg;

  if (!s.online) {
    text = "Offline"; msg = "Not connected";
  } else if (s.want !== s.on) {
    text = s.want ? "Turning on..." : "Turning off..."; msg = "One moment";
  } else {
    text = s.on ? "On" : "Off"; msg = s.on ? "Tap to turn off" : "Tap to turn on";
  }

  tile.classList.toggle("on", s.online && s.want);
  tile.classList.toggle("busy", s.online && s.want !== s.on);
  tile.setAttribute("aria-pressed", String(s.want));
  tile.setAttribute("aria-label", label + ": " + text);
  tile.disabled = switching[name] || !s.online;
  $(name + "State").textContent = text;
  $(name + "Msg").textContent = msg;
}

async function toggleSwitch(name) {
  const s = switches[name];
  if (!s) return;

  // Flip the tile straight away so it feels instant; the ESP32 catches up within a second
  s.want = !s.want;
  switching[name] = true;
  renderSwitch(name);

  try {
    const res = await fetch("/api/switch/" + name, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: s.want })
    });
    const data = await res.json();
    if (!res.ok) toast(data.error || "Could not switch it");
  } catch (e) {
    toast("Server not reachable");
  }

  switching[name] = false;
  refresh();
}

document.querySelectorAll("[data-switch]").forEach((tile) => {
  tile.addEventListener("click", () => toggleSwitch(tile.dataset.switch));
});

// ---------- Door camera ----------

const VISIT_TEXT = {
  opened:       (v) => ["Welcome " + v.name + " — door opened", "good"],
  door_offline: (v) => [v.name + " recognised — but the door lock is offline", "warn"],
  unknown:      ()  => ["Unknown person — door stayed locked", "bad"],
  no_face:      ()  => ["No face in the photo", "warn"]
};

let faces = [];
let shownVisitId = null;
let savedVisitId = null;  // door camera photo that was just saved to someone

function renderVisit(visit, serverTime) {
  if (!visit) return;

  if (visit.id !== shownVisitId) {
    shownVisitId = visit.id;
    $("visitEmpty").hidden = true;
    $("visit").hidden = false;
    $("visitPhoto").src = visit.photo;
    $("visitLink").href = visit.photo;

    const [text, cls] = VISIT_TEXT[visit.result](visit);
    $("visitResult").textContent = text;
    $("visitResult").className = "visit-result " + cls;
  }

  $("visitTime").textContent = ago(serverTime - visit.time);
  // An unknown face can be saved to someone, so the door camera recognises them next time
  $("visitSave").hidden = !(visit.result === "unknown" && faces.length && visit.id !== savedVisitId);
}

async function saveVisitFace() {
  const personId = $("visitPerson").value;
  $("visitSaveBtn").disabled = true;
  try {
    const res = await sendWithPin("/api/visits/" + shownVisitId + "/save", { personId });
    if (res && res.ok) {
      savedVisitId = shownVisitId;
      const person = faces.find((f) => f.id === personId);
      $("visitResult").textContent = "Saved to " + (person ? person.name : "person") + " — they'll be recognised next time";
      $("visitResult").className = "visit-result good";
      $("visitSave").hidden = true;
    } else if (res) {
      toast(res.data.error || "Could not save the face");
    }
  } catch (e) {
    toast("Server not reachable");
  }
  $("visitSaveBtn").disabled = false;
}

$("visitSaveBtn").addEventListener("click", saveVisitFace);

// ---------- Faces ----------

let shownFaces = null;

function avatar(f) {
  const box = document.createElement("span");
  box.className = "avatar";
  box.textContent = f.name.trim().charAt(0).toUpperCase();  // shown if the photo can't load

  const img = document.createElement("img");
  img.src = "/face-photos/" + f.id + ".jpg";
  img.alt = "";
  img.onerror = () => img.remove();
  box.appendChild(img);
  return box;
}

function renderFaces(list) {
  faces = list || [];
  const key = JSON.stringify(faces);
  if (key === shownFaces) return;  // only redraw when something changed
  shownFaces = key;

  const box = $("faceList");
  box.replaceChildren();

  if (!faces.length) {
    const empty = document.createElement("div");
    empty.className = "faces-empty";
    empty.textContent = "No faces yet. Add someone so the door camera can let them in.";
    box.appendChild(empty);
  }

  for (const f of faces) {
    const row = document.createElement("div");
    row.className = "face";

    // Tapping a person shows their entries on the history page
    const info = document.createElement("a");
    info.className = "face-info";
    info.href = "/history?person=" + encodeURIComponent(f.id);
    info.title = "See when " + f.name + " came in";
    const name = document.createElement("div");
    name.className = "face-name";
    name.textContent = f.name;
    const sub = document.createElement("div");
    sub.className = "muted-small";
    sub.textContent = f.lastSeen
      ? "Last in " + whenLabel(f.lastSeen) + " · " + f.entries + (f.entries === 1 ? " visit" : " visits")
      : "Not seen yet";
    info.append(name, sub);

    const remove = document.createElement("button");
    remove.className = "icon-btn";
    remove.type = "button";
    remove.title = "Remove " + f.name;
    remove.setAttribute("aria-label", "Remove " + f.name);
    remove.textContent = "×";
    remove.addEventListener("click", () => removeFace(f));

    row.append(avatar(f), info, remove);
    box.appendChild(row);
  }

  // Keep the "Save face to" list in step with the people
  const select = $("visitPerson");
  const chosen = select.value;
  select.replaceChildren(...faces.map((f) => new Option(f.name, f.id)));
  if (faces.some((f) => f.id === chosen)) select.value = chosen;
}

async function removeFace(f) {
  if (!confirm("Remove " + f.name + "? They won't be able to open the door with their face any more.")) return;
  try {
    const res = await sendWithPin("/api/faces/" + f.id, {}, "DELETE");
    if (res && res.ok) toast(f.name + " was removed", "good");
    else if (res) toast(res.data.error || "Could not remove the face");
  } catch (e) {
    toast("Server not reachable");
  }
  refresh();
}

// ---------- Recent activity ----------

let shownActivity = null;

function renderActivity(list) {
  list = list || [];
  const key = JSON.stringify(list) + new Date().getDate();  // redraw at midnight for "Yesterday"
  if (key === shownActivity) return;
  shownActivity = key;

  const box = $("activityList");
  box.replaceChildren();

  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "faces-empty";
    empty.textContent = "Nothing yet. Door openings and visitors will show up here.";
    box.appendChild(empty);
    return;
  }
  for (const a of list) box.appendChild(activityRow(a));
}

// ---------- Live data ----------

async function refresh() {
  try {
    const res = await fetch("/api/latest", { cache: "no-store" });
    const data = await res.json();

    door = data.door;
    renderDoor();
    // A tile that was just tapped keeps its new state until its request is done
    for (const [name, s] of Object.entries(data.switches || {})) {
      if (!switching[name]) switches[name] = s;
      renderSwitch(name);
    }
    renderFaces(data.faces);
    renderVisit(data.visit, data.serverTime);
    renderActivity(data.activity);
    renderClimate(data.latest, data.serverTime);
  } catch (e) {
    $("conn").className = "pill offline";
    $("connText").textContent = "Server not reachable";
  }
}

greet();
setInterval(greet, 60000);
refresh();
setInterval(refresh, REFRESH_MS);
