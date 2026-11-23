// History page: everyone who came in (or tried to), grouped by day.
// Filters live in the address (?person=...&group=...) so a filtered view can be shared or reloaded.

const $ = (id) => document.getElementById(id);
const PAGE = 50;
const REFRESH_MS = 5000;

const params = new URLSearchParams(location.search);
let group = params.get("group") || "";
let person = params.get("person") || "";
let items = [];
let more = false;

function query(extra = {}) {
  const q = new URLSearchParams({ limit: PAGE, ...extra });
  if (group) q.set("group", group);
  if (person) q.set("person", person);
  return "/api/activity?" + q;
}

function saveFiltersInAddress() {
  const q = new URLSearchParams();
  if (group) q.set("group", group);
  if (person) q.set("person", person);
  history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : ""));
}

// ---------- Loading ----------

async function load() {
  const res = await fetch(query(), { cache: "no-store" });
  const data = await res.json();
  items = data.items;
  more = data.more;
  renderSummary(data);
  renderPeople(data.people);
  renderTimeline();
}

async function loadOlder() {
  if (!items.length) return;
  $("moreBtn").disabled = true;
  try {
    const res = await fetch(query({ before: items[items.length - 1].time }), { cache: "no-store" });
    const data = await res.json();
    items = items.concat(data.items);
    more = data.more;
    renderTimeline();
  } catch (e) {
    // keep what's shown; the button stays so it can be tried again
  }
  $("moreBtn").disabled = false;
}

// New entries appear by themselves (only while the newest page is shown)
async function checkForNew() {
  if (items.length > PAGE) return;
  try {
    const res = await fetch(query(), { cache: "no-store" });
    const data = await res.json();
    renderSummary(data);
    renderPeople(data.people);
    if ((data.items[0] && data.items[0].id) !== (items[0] && items[0].id)) {
      items = data.items;
      more = data.more;
      renderTimeline();
    }
  } catch (e) {
    // server not reachable - try again next time
  }
}

// ---------- Screen ----------

function renderSummary(data) {
  $("sumEntries").textContent = data.today.entries;
  $("sumUnknown").textContent = data.today.unknown;
  $("sumPeople").textContent = data.people.length;
}

let shownPeople = null;

function renderPeople(people) {
  const key = JSON.stringify(people) + person;
  if (key === shownPeople) return;
  shownPeople = key;

  const box = $("people");
  box.replaceChildren();

  const everyone = document.createElement("button");
  everyone.type = "button";
  everyone.className = "person-chip" + (person ? "" : " active");
  everyone.innerHTML = '<span class="avatar avatar-all">All</span>';
  const allText = document.createElement("span");
  allText.className = "person-text";
  allText.innerHTML = '<span class="person-name">Everyone</span>';
  everyone.appendChild(allText);
  everyone.addEventListener("click", () => setPerson(""));
  box.appendChild(everyone);

  for (const p of people) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "person-chip" + (p.id === person ? " active" : "");
    chip.setAttribute("aria-pressed", String(p.id === person));

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = p.name.trim().charAt(0).toUpperCase();
    const img = new Image();
    img.src = "/face-photos/" + p.id + ".jpg";
    img.alt = "";
    img.onerror = () => img.remove();
    avatar.appendChild(img);

    const text = document.createElement("span");
    text.className = "person-text";
    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = p.name;
    const seen = document.createElement("span");
    seen.className = "muted-small";
    seen.textContent = p.lastSeen ? "Last in " + whenLabel(p.lastSeen) : "Not seen yet";
    text.append(name, seen);

    chip.append(avatar, text);
    chip.addEventListener("click", () => setPerson(p.id === person ? "" : p.id));
    box.appendChild(chip);
  }

  // Someone who was removed can still be in the address - show everyone instead
  if (person && !people.some((p) => p.id === person)) setPerson("");
}

function renderTimeline() {
  const box = $("timeline");
  box.replaceChildren();

  let day = null;
  let list = null;
  for (const a of items) {
    const label = dayLabel(a.time);
    if (label !== day) {
      day = label;
      const title = document.createElement("div");
      title.className = "day-title";
      title.textContent = label;
      list = document.createElement("div");
      list.className = "day-list";
      box.append(title, list);
    }
    list.appendChild(activityRow(a, { time: clockTime, onPhoto: showPhoto }));
  }

  $("empty").hidden = items.length > 0;
  $("moreBtn").hidden = !more;
}

function showPhoto(a) {
  const kind = ACTIVITY_KINDS[a.type] || ACTIVITY_KINDS.no_face;
  $("photoBig").src = a.photo;
  $("photoTitle").textContent = kind.title(a);
  $("photoTime").textContent = dayLabel(a.time) + ", " + clockTime(a.time);
  $("photoDialog").showModal();
}

// ---------- Filters ----------

function setPerson(id) {
  person = id;
  shownPeople = null;
  saveFiltersInAddress();
  load();
}

function setGroup(g) {
  group = g;
  document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("active", b.dataset.group === g));
  saveFiltersInAddress();
  load();
}

document.querySelectorAll("#filters button").forEach((b) => {
  b.classList.toggle("active", b.dataset.group === group);
  b.addEventListener("click", () => setGroup(b.dataset.group));
});
$("moreBtn").addEventListener("click", loadOlder);
$("photoClose").addEventListener("click", () => $("photoDialog").close());
$("photoDialog").addEventListener("click", (e) => {
  if (e.target === $("photoDialog")) $("photoDialog").close();  // tap outside the photo
});

load().catch(() => {
  $("empty").hidden = false;
  $("empty").querySelector(".visit-empty-title").textContent = "Server not reachable";
});
setInterval(checkForNew, REFRESH_MS);
