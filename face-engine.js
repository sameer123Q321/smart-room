// Face recognition for the door camera, using InsightFace's "buffalo_l" models:
//   SCRFD   - finds faces and 5 points (eyes, nose, mouth corners), even in dim light
//   ArcFace - turns a face into a "face fingerprint" of 512 numbers
// Runs on this laptop with ONNX Runtime - no internet needed once the models are downloaded.
// The models are for non-commercial use only (InsightFace licence).

const path = require("path");
const ort = require("onnxruntime-node");
const jpeg = require("jpeg-js");
const { ensureModels, MODEL_DIR } = require("./scripts/setup-models");

// Lower distance = more alike (distance = 1 - cosine similarity of the two fingerprints)
const MATCH_DISTANCE = 0.6;         // closer than this = the same person (opens the door)
const SAME_PERSON_DISTANCE = 0.75;  // "Add face": all photos must be at least this alike
const DIM = 512;                    // numbers in one fingerprint

const DET_SIZE = 640;               // the face finder looks at the photo at 640x640
const DET_MIN_SCORE = 0.5;          // how sure it must be that it found a face
const NMS_OVERLAP = 0.4;            // boxes overlapping more than this are the same face
const STRIDES = [8, 16, 32];
const DARK_LEVEL = 90;              // darker photos (0-255) are brightened first

// Where the eyes, nose and mouth corners sit in the 112x112 face ArcFace expects
const ARCFACE_POINTS = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]
];

let detector = null;
let recognizer = null;

async function init() {
  await ensureModels();
  detector = await ort.InferenceSession.create(path.join(MODEL_DIR, "det_10g.onnx"));
  recognizer = await ort.InferenceSession.create(path.join(MODEL_DIR, "w600k_r50.onnx"));
}

function isReady() {
  return !!(detector && recognizer);
}

// ---------- Pictures ----------

// Colour of one channel at a (fractional) spot, blended from the 4 nearest pixels
function sample(img, x, y, c) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= img.width - 1 || y0 >= img.height - 1) {
    const xi = Math.min(img.width - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(img.height - 1, Math.max(0, Math.round(y)));
    return x < -1 || y < -1 || x > img.width || y > img.height ? 0 : img.data[(yi * img.width + xi) * 3 + c];
  }
  const fx = x - x0, fy = y - y0, w = img.width, d = img.data;
  const i = (y0 * w + x0) * 3 + c;
  const top = d[i] * (1 - fx) + d[i + 3] * fx;
  const bottom = d[i + w * 3] * (1 - fx) + d[i + w * 3 + 3] * fx;
  return top * (1 - fy) + bottom * fy;
}

// Average brightness, 0 (black) to 255 (white)
function brightness(rgb) {
  let sum = 0, count = 0;
  for (let i = 0; i < rgb.length; i += 12) {
    sum += 0.3 * rgb[i] + 0.59 * rgb[i + 1] + 0.11 * rgb[i + 2];
    count++;
  }
  return count ? sum / count : 0;
}

// Brightens a dark picture: lifts the shadows, then stretches darkest 1% to black, brightest 1% to white
function lighten(rgb) {
  const curve = new Uint8Array(256);
  for (let i = 0; i < 256; i++) curve[i] = Math.round(255 * Math.pow(i / 255, 0.6));
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = curve[rgb[i]];

  const hist = new Array(256).fill(0);
  for (let i = 0; i < out.length; i += 3) hist[Math.round(0.3 * out[i] + 0.59 * out[i + 1] + 0.11 * out[i + 2])]++;
  const pixels = out.length / 3;
  let lo = 0, hi = 255, seen = 0;
  for (; lo < 255; lo++) { seen += hist[lo]; if (seen > pixels * 0.01) break; }
  seen = 0;
  for (; hi > 0; hi--) { seen += hist[hi]; if (seen > pixels * 0.01) break; }

  const scale = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((out[i] - lo) * scale)));
  return out;
}

// Puts a black border around the picture. A face that's too close fills the whole photo (chin or
// forehead cut off), and the face finder misses it - with a border around it, it's found again.
function addBorder(img, fraction) {
  const px = Math.round(img.width * fraction), py = Math.round(img.height * fraction);
  const width = img.width + 2 * px, height = img.height + 2 * py;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < img.height; y++) {
    data.set(img.data.subarray(y * img.width * 3, (y + 1) * img.width * 3), ((y + py) * width + px) * 3);
  }
  return { width, height, data };
}

// ---------- Finding faces (SCRFD) ----------

async function findFaces(img) {
  // Shrink the photo into the top-left of a 640x640 square, the rest stays black
  const scale = Math.min(DET_SIZE / img.width, DET_SIZE / img.height);
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const plane = DET_SIZE * DET_SIZE;
  const input = new Float32Array(3 * plane).fill(-127.5 / 128);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) / scale - 0.5, sy = (y + 0.5) / scale - 0.5;
      for (let c = 0; c < 3; c++) input[c * plane + y * DET_SIZE + x] = (sample(img, sx, sy, c) - 127.5) / 128;
    }
  }

  const out = await detector.run({ [detector.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, DET_SIZE, DET_SIZE]) });

  // The model gives scores, boxes and 5 points for each of its 3 grid sizes - sort them by shape
  const byShape = {};
  for (const name of detector.outputNames) {
    const t = out[name];
    const k = t.dims[t.dims.length - 1];
    byShape[k + ":" + t.data.length / k] = t.data;
  }

  const faces = [];
  for (const stride of STRIDES) {
    const cells = DET_SIZE / stride;
    const n = cells * cells * 2;  // 2 guesses per grid cell
    const scores = byShape["1:" + n], boxes = byShape["4:" + n], points = byShape["10:" + n];
    if (!scores || !boxes || !points) throw new Error("unexpected face finder output");

    for (let i = 0; i < n; i++) {
      if (scores[i] < DET_MIN_SCORE) continue;
      const cell = i >> 1;
      const cx = (cell % cells) * stride, cy = Math.floor(cell / cells) * stride;
      const p = [];
      for (let j = 0; j < 5; j++) {
        p.push([(cx + points[i * 10 + j * 2] * stride) / scale, (cy + points[i * 10 + j * 2 + 1] * stride) / scale]);
      }
      faces.push({
        score: scores[i],
        box: [
          (cx - boxes[i * 4] * stride) / scale, (cy - boxes[i * 4 + 1] * stride) / scale,
          (cx + boxes[i * 4 + 2] * stride) / scale, (cy + boxes[i * 4 + 3] * stride) / scale
        ],
        points: p
      });
    }
  }

  // Keep the best box where several boxes found the same face
  faces.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const f of faces) {
    if (kept.every((k) => overlap(k.box, f.box) <= NMS_OVERLAP)) kept.push(f);
  }
  return kept;
}

function overlap(a, b) {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

// ---------- Fingerprint (ArcFace) ----------

// Rotates, scales and moves the face so its eyes, nose and mouth land where ArcFace expects
function alignFace(img, points) {
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < 5; i++) {
    sx += points[i][0]; sy += points[i][1];
    dx += ARCFACE_POINTS[i][0]; dy += ARCFACE_POINTS[i][1];
  }
  sx /= 5; sy /= 5; dx /= 5; dy /= 5;

  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < 5; i++) {
    const px = points[i][0] - sx, py = points[i][1] - sy;
    const qx = ARCFACE_POINTS[i][0] - dx, qy = ARCFACE_POINTS[i][1] - dy;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = num1 / den, b = num2 / den;            // scale x cos, scale x sin
  const tx = dx - (a * sx - b * sy), ty = dy - (b * sx + a * sy);
  const norm = a * a + b * b;

  const plane = 112 * 112;
  const input = new Float32Array(3 * plane);
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      // Where this face pixel comes from in the photo
      const x = (a * (u - tx) + b * (v - ty)) / norm;
      const y = (-b * (u - tx) + a * (v - ty)) / norm;
      for (let c = 0; c < 3; c++) input[c * plane + v * 112 + u] = (sample(img, x, y, c) - 127.5) / 127.5;
    }
  }
  return input;
}

async function fingerprint(img, face) {
  const input = alignFace(img, face.points);
  const out = await recognizer.run({ [recognizer.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 112, 112]) });
  const v = out[recognizer.outputNames[0]].data;
  let len = 0;
  for (let i = 0; i < v.length; i++) len += v[i] * v[i];
  len = Math.sqrt(len) || 1;
  return Array.from(v, (x) => x / len);
}

// ---------- What the server uses ----------

// The fingerprint of the biggest face in a JPEG photo, or null when there is no face.
// Tries step by step until a face is found:
//   the photo as it is, then with a 25% border, then a 50% border (for faces that are too close),
//   each time the brightened version first if the photo is dark, then the other one.
async function describe(jpegBuffer) {
  const img = jpeg.decode(jpegBuffer, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 });
  const dark = brightness(img.data) < DARK_LEVEL;
  const brightened = { width: img.width, height: img.height, data: lighten(img.data) };
  const versions = dark ? [brightened, img] : [img, brightened];

  for (const border of [0, 0.25, 0.5]) {
    for (const version of versions) {
      const pic = border ? addBorder(version, border) : version;
      const faces = await findFaces(pic);
      if (!faces.length) continue;
      const biggest = faces.reduce((m, f) =>
        (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) > (m.box[2] - m.box[0]) * (m.box[3] - m.box[1]) ? f : m);
      return fingerprint(pic, biggest);
    }
  }
  return null;
}

// How different two faces are: 0 = identical, below MATCH_DISTANCE = same person
function distance(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - dot;
}

module.exports = { init, isReady, describe, distance, MATCH_DISTANCE, SAME_PERSON_DISTANCE, DIM };
