// Run once after `npm install`:  node setup-mediapipe.mjs
// 1) Downloads face_landmarker.task  -> public/face_landmarker.task
// 2) Copies the MediaPipe WASM files -> public/wasm/
import { mkdir, cp, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_DEST = path.resolve("public/face_landmarker.task");
const WASM_SRC = path.resolve("node_modules/@mediapipe/tasks-vision/wasm");
const WASM_DEST = path.resolve("public/wasm");

async function downloadModel() {
  if (existsSync(MODEL_DEST)) {
    console.log("model: already present, skipping");
    return;
  }
  await mkdir(path.dirname(MODEL_DEST), { recursive: true });
  console.log("model: downloading...");
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  await writeFile(MODEL_DEST, Buffer.from(await res.arrayBuffer()));
  const { size } = await stat(MODEL_DEST);
  console.log(`model: saved ${(size / 1024 / 1024).toFixed(1)} MB -> ${MODEL_DEST}`);
}

async function copyWasm() {
  if (!existsSync(WASM_SRC)) {
    throw new Error(
      "wasm: @mediapipe/tasks-vision not installed. Run `npm install @mediapipe/tasks-vision@latest` first."
    );
  }
  await mkdir(WASM_DEST, { recursive: true });
  await cp(WASM_SRC, WASM_DEST, { recursive: true });
  console.log(`wasm: copied -> ${WASM_DEST}`);
}

try {
  await downloadModel();
  await copyWasm();
  console.log("done");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
