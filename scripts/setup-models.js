// Downloads the face recognition models (InsightFace "buffalo_l": SCRFD + ArcFace) into models/insightface/.
// Runs by itself after "npm install", and again when the server starts if the files are missing,
// so a new laptop only needs:  npm install  then  npm start
//
// Run it by hand:  npm run setup
//
// Every file is checked against its SHA-256 fingerprint, so each laptop gets exactly the same,
// official files. They come from a Hugging Face copy (much faster than GitHub), which was checked
// to be identical to the official InsightFace release; the official zip is the fallback.
//
// The models are for non-commercial use only (InsightFace licence).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");

const MODEL_DIR = path.join(__dirname, "..", "models", "insightface");
const FAST_URL = "https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/";
const OFFICIAL_ZIP = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip";

const FILES = {
  "det_10g.onnx":   "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",  // face finder (SCRFD), 17 MB
  "w600k_r50.onnx": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",  // face recogniser (ArcFace), 174 MB
};

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function missingFiles() {
  return Object.keys(FILES).filter((f) => !fs.existsSync(path.join(MODEL_DIR, f)));
}

// Downloads to a temporary file, showing progress; returns the file's SHA-256
async function download(url, file, label) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);

  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(file);
  const hash = crypto.createHash("sha256");
  let got = 0, shown = -1;

  for await (const chunk of res.body) {
    out.write(chunk);
    hash.update(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 4) * 25 : -1;
    if (pct !== shown && pct >= 0) {
      shown = pct;
      console.log(`  ${label}: ${pct}%  (${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`);
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  return hash.digest("hex");
}

async function fromFastSource(name) {
  const tmp = path.join(MODEL_DIR, name + ".part");
  try {
    const sha = await download(FAST_URL + name, tmp, name);
    if (sha !== FILES[name]) throw new Error(`${name} is not the expected file (checksum mismatch)`);
    fs.renameSync(tmp, path.join(MODEL_DIR, name));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function fromOfficialZip(names) {
  console.log("Trying the official InsightFace download instead (290 MB, can be slow)...");
  const zipFile = path.join(os.tmpdir(), `buffalo_l-${process.pid}.zip`);
  try {
    await download(OFFICIAL_ZIP, zipFile, "buffalo_l.zip");
    const zip = new AdmZip(zipFile);
    for (const name of names) {
      const entry = zip.getEntries().find((e) => path.basename(e.entryName) === name);
      if (!entry) throw new Error(`${name} is missing from the download`);
      const data = entry.getData();
      if (sha256(data) !== FILES[name]) throw new Error(`${name} is not the expected file (checksum mismatch)`);
      fs.writeFileSync(path.join(MODEL_DIR, name), data);
    }
  } finally {
    fs.rmSync(zipFile, { force: true });
  }
}

async function ensureModels() {
  let missing = missingFiles();
  if (!missing.length) return;

  console.log("Downloading the face recognition models (about 190 MB, only needed once)...");
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  for (const name of missing) {
    try {
      await fromFastSource(name);
    } catch (err) {
      console.warn(`  ${name}: ${err.message}`);
    }
  }

  missing = missingFiles();
  if (missing.length) await fromOfficialZip(missing);
  console.log("Face recognition models ready.");
}

module.exports = { ensureModels, MODEL_DIR };

// "npm install" / "npm run setup": never fail the install - the server tries again when it starts
if (require.main === module) {
  ensureModels().catch((err) => {
    console.warn("Could not download the face recognition models now:", err.message);
    console.warn("No problem - they will be downloaded when the server starts (needs internet once).");
  });
}
