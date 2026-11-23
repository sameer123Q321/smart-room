// "Add face" page: guides the person through 5 photos - straight, left, right, up, down.
// face-api finds the face live, so each photo is taken automatically once the head
// is turned the right way. The server checks every photo again before saving.

const $ = (id) => document.getElementById(id);

const STEPS = [
  { label: "Straight", title: "Look straight at the camera",         arrow: "" },
  { label: "Left",     title: "Turn your head a little to the left", arrow: "←", axis: "yaw",   partner: 2 },
  { label: "Right",    title: "Now a little to the right",           arrow: "→", axis: "yaw",   partner: 1 },
  { label: "Up",       title: "Tilt your head up a little",          arrow: "↑", axis: "pitch", partner: 4 },
  { label: "Down",     title: "Now tilt it down a little",           arrow: "↓", axis: "pitch", partner: 3 }
];

const TURN = { yaw: 0.18, pitch: 0.08 };  // how far the head must turn compared to the straight photo
const HOLD_MS = 600;                       // stay in position this long, then the photo is taken
const MAX_SIDE = 640;                      // photos are shrunk to this size before sending

const shots = STEPS.map(() => null);       // { dataUrl, pose, mirror, bad }
let current = 0;        // which step we're on (STEPS.length = all done)
let stream = null;
let detector = false;   // true once face-api has loaded
let holdSince = 0;
let lastPose = null;    // { yaw, pitch, time } of the newest face seen
let saving = false;

// ---------- Head direction ----------

// yaw: nose left/right of the eyes. pitch: nose height between the eyes and the mouth.
function poseOf(landmarks) {
  const mean = (pts) => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length
  });
  const leftEye = mean(landmarks.getLeftEye());
  const rightEye = mean(landmarks.getRightEye());
  const mouth = mean(landmarks.getMouth());
  const nose = landmarks.getNose()[3];  // tip of the nose
  const eyes = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };
  const eyeGap = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y) || 1;

  return {
    yaw: (nose.x - eyes.x) / eyeGap,
    pitch: (nose.y - eyes.y) / ((mouth.y - eyes.y) || 1)
  };
}

function inPosition(i, pose) {
  const step = STEPS[i];
  if (!step.axis) return Math.abs(pose.yaw) < 0.12;

  const base = (shots[0] && shots[0].pose) || { yaw: 0, pitch: 0.6 };
  const delta = pose[step.axis] - base[step.axis];
  if (Math.abs(delta) < TURN[step.axis]) return false;

  // Left and right (and up and down) must be turned opposite ways - whichever way the camera mirrors
  const other = shots[step.partner];
  if (other && other.pose) {
    const otherDelta = other.pose[step.axis] - base[step.axis];
    if (Math.abs(otherDelta) >= TURN[step.axis] / 2 && Math.sign(otherDelta) === Math.sign(delta)) return false;
  }
  return true;
}

// ---------- Camera ----------

async function startCamera() {
  $("startBtn").disabled = true;
  $("startBtn").textContent = "Starting...";

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
  } catch (e) {
    $("camNote").textContent = e.name === "NotAllowedError"
      ? "Camera permission was blocked. Allow it from the browser's address bar, or upload photos instead."
      : "No camera found. You can upload photos instead.";
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Try again";
    return;
  }

  const video = $("video");
  video.srcObject = stream;
  await video.play();
  $("camStart").hidden = true;
  $("cam").classList.add("live");

  nextStep();
  loadDetector();
  detectLoop();
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

async function loadDetector() {
  if (typeof faceapi === "undefined") return;
  try {
    await faceapi.tf.ready();
    await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
    await faceapi.nets.faceLandmark68TinyNet.loadFromUri("/models");
    detector = true;
    renderStep();
  } catch (e) {
    console.warn("Face finder could not load - photos can still be taken with the button", e);
  }
}

async function detectLoop() {
  if (!stream) return;
  const video = $("video");

  if (detector && current < STEPS.length && video.readyState >= 2) {
    try {
      const face = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
        .withFaceLandmarks(true);
      handleFace(face, video);
    } catch (e) {
      // a missed frame is fine, try the next one
    }
  }
  setTimeout(detectLoop, 120);
}

function setGuide(state, hint) {
  $("guide").className = "cam-guide " + state;
  $("stepHint").textContent = hint;
}

function handleFace(face, video) {
  if (current >= STEPS.length) return;

  if (!face) {
    holdSince = 0;
    return setGuide("", "Can't see a face - look at the camera");
  }
  if (face.detection.box.width < video.videoWidth * 0.2) {
    holdSince = 0;
    return setGuide("seen", "Come a little closer");
  }

  const pose = poseOf(face.landmarks);
  lastPose = { ...pose, time: Date.now() };

  if (!inPosition(current, pose)) {
    holdSince = 0;
    return setGuide("seen", STEPS[current].axis ? "Keep turning slowly..." : "Look straight at the camera");
  }

  if (!holdSince) holdSince = Date.now();
  setGuide("hold", "Hold still...");
  if (Date.now() - holdSince >= HOLD_MS) {
    holdSince = 0;
    capture(pose);
  }
}

// Draws the image or video frame onto a canvas, at most MAX_SIDE pixels, and returns a JPEG
function toJpeg(source, width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.9);
}

function capture(pose) {
  const video = $("video");
  if (!video.videoWidth || current >= STEPS.length) return;

  shots[current] = { dataUrl: toJpeg(video, video.videoWidth, video.videoHeight), pose, mirror: true, bad: false };
  $("flash").classList.remove("on");
  void $("flash").offsetWidth;  // restart the flash animation
  $("flash").classList.add("on");
  nextStep();
}

function captureNow() {
  const fresh = lastPose && Date.now() - lastPose.time < 500;
  capture(fresh ? { yaw: lastPose.yaw, pitch: lastPose.pitch } : null);
}

// ---------- Upload instead ----------

function fileToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(toJpeg(img, img.naturalWidth, img.naturalHeight));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Not an image"));
    };
    img.src = url;
  });
}

async function addFiles(files) {
  for (const file of files) {
    const slot = shots.findIndex((s) => !s || s.bad);
    if (slot < 0) break;
    try {
      shots[slot] = { dataUrl: await fileToJpeg(file), pose: null, mirror: false, bad: false };
    } catch (e) {
      // skip files the browser can't open
    }
  }
  nextStep();
}

// ---------- Screen ----------

function nextStep() {
  const next = shots.findIndex((s) => !s || s.bad);
  current = next < 0 ? STEPS.length : next;
  holdSince = 0;
  renderStep();
  renderShots();
  updateSave();
}

function renderStep() {
  const done = current >= STEPS.length;
  const count = shots.filter((s) => s && !s.bad).length;

  $("arrow").textContent = done || !stream ? "" : STEPS[current].arrow;
  $("captureBtn").disabled = done || !stream;
  if (done) $("guide").className = "cam-guide";

  if (!stream) {
    $("stepTitle").textContent = done ? "All 5 photos added" : count + " of 5 photos added";
    $("stepHint").textContent = done ? "Press Save face" : "Add more photos, or press Save face";
  } else if (done) {
    $("stepTitle").textContent = "All photos taken!";
    $("stepHint").textContent = "Check them below, then press Save face. Tap a photo to retake it.";
  } else {
    $("stepTitle").textContent = STEPS[current].title;
    $("stepHint").textContent = detector
      ? "The photo is taken automatically when you're in position"
      : "Press \"Take photo now\" when you're in position";
  }
}

function renderShots() {
  const box = $("shots");
  box.replaceChildren();

  STEPS.forEach((step, i) => {
    const shot = shots[i];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "shot" + (shot ? " taken" : "") + (shot && shot.bad ? " bad" : "") + (i === current ? " current" : "");
    b.title = shot ? "Retake: " + step.label : step.label;

    if (shot) {
      const img = new Image();
      img.src = shot.dataUrl;
      img.alt = step.label;
      if (shot.mirror) img.className = "mirror";
      b.appendChild(img);
    }
    const label = document.createElement("span");
    label.textContent = shot && shot.bad ? "Retake" : step.label;
    b.appendChild(label);

    b.addEventListener("click", () => {
      current = i;
      holdSince = 0;
      renderStep();
      renderShots();
    });
    box.appendChild(b);
  });
}

function updateSave() {
  const hasPhoto = shots.some((s) => s && !s.bad);
  $("saveBtn").disabled = saving || !hasPhoto || !$("name").value.trim();
}

async function save() {
  const name = $("name").value.trim();
  const slots = shots.map((s, i) => (s && !s.bad ? i : -1)).filter((i) => i >= 0);

  saving = true;
  updateSave();
  $("saveBtn").textContent = "Checking photos...";
  $("saveMsg").textContent = "";

  try {
    const res = await sendWithPin("/api/faces", { name, images: slots.map((i) => shots[i].dataUrl) });
    if (res && res.ok) {
      stopCamera();
      $("form").hidden = true;
      $("done").hidden = false;
      $("doneText").textContent = res.data.name + " was added";
      return;
    }
    if (res) {
      (res.data.failed || []).forEach((k) => { shots[slots[k]].bad = true; });
      $("saveMsg").textContent = res.data.error || "Could not save the face";
      nextStep();
    }
  } catch (e) {
    $("saveMsg").textContent = "Server not reachable";
  }

  saving = false;
  $("saveBtn").textContent = "Save face";
  updateSave();
}

// ---------- Start ----------

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  // Browsers only allow the camera on https or on the laptop itself (localhost)
  $("startBtn").hidden = true;
  $("camNote").textContent = "The live camera only works when this page is opened on the laptop (localhost). Use \"Upload photos instead\" below - on a phone it opens the camera.";
}

$("startBtn").addEventListener("click", startCamera);
$("captureBtn").addEventListener("click", captureNow);
$("saveBtn").addEventListener("click", save);
$("name").addEventListener("input", updateSave);
$("fileInput").addEventListener("change", (e) => {
  addFiles(Array.from(e.target.files || []));
  e.target.value = "";
});

renderShots();
