// Shared by the dashboard and the history page: turns history entries into readable rows.

const ACTIVITY_KINDS = {
  entered:      { title: (a) => a.name + " came in",            note: "Recognised by the door camera", cls: "good",   tag: "Face" },
  dashboard:    { title: () => "Door opened from the dashboard", note: "Opened with the PIN",           cls: "accent", tag: "Dashboard" },
  unknown:      { title: () => "Unknown person at the door",     note: "The door stayed locked",        cls: "bad",    tag: "Not let in" },
  no_face:      { title: () => "No face in the photo",           note: "The door stayed locked",        cls: "warn",   tag: "No face" },
  door_offline: { title: (a) => a.name + " was recognised",     note: "But the door lock was offline", cls: "warn",   tag: "Lock offline" }
};

const SCREEN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="5" y="2.5" width="14" height="19" rx="2.5"/><path d="M10 18h4"/></svg>';

function startOfDay(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function clockTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// "Today", "Yesterday" or "Monday 28 October"
function dayLabel(t) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(t).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

// "10:32", "Yesterday, 10:32" or "28 Oct, 10:32"
function whenLabel(t) {
  const day = dayLabel(t);
  if (day === "Today") return clockTime(t);
  if (day === "Yesterday") return "Yesterday, " + clockTime(t);
  return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" }) + ", " + clockTime(t);
}

// One history row: photo (or icon), what happened, and when.
// options.time(t) formats the time; options.onPhoto(entry) runs when the photo is tapped.
function activityRow(a, options = {}) {
  const kind = ACTIVITY_KINDS[a.type] || ACTIVITY_KINDS.no_face;
  const row = document.createElement("div");
  row.className = "event";

  let thumb;
  if (a.photo) {
    thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "event-thumb";
    thumb.setAttribute("aria-label", "Show the photo");
    const img = new Image();
    img.src = a.photo;
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => { thumb.classList.add("missing"); img.remove(); };
    thumb.appendChild(img);
    thumb.addEventListener("click", () => (options.onPhoto ? options.onPhoto(a) : window.open(a.photo, "_blank")));
  } else {
    thumb = document.createElement("span");
    thumb.className = "event-thumb event-icon";
    thumb.innerHTML = SCREEN_ICON;
  }

  const body = document.createElement("div");
  body.className = "event-body";
  const title = document.createElement("div");
  title.className = "event-title";
  title.textContent = kind.title(a);
  const note = document.createElement("div");
  note.className = "muted-small";
  note.textContent = kind.note;
  body.append(title, note);

  const side = document.createElement("div");
  side.className = "event-side";
  const time = document.createElement("div");
  time.className = "event-time";
  time.textContent = (options.time || whenLabel)(a.time);
  const tag = document.createElement("span");
  tag.className = "chip " + kind.cls;
  tag.textContent = kind.tag;
  side.append(time, tag);

  row.append(thumb, body, side);
  return row;
}
