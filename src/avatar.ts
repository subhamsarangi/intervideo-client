import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Load the page with #debug to see the mesh points, or #demo to animate without any API keys.

export interface Avatar {
  /** Starts the render loop. getViseme is called once per frame (0-21, 0 = silence). */
  start(getViseme: () => number): void;
  stop(): void;
}

type Pt = { x: number; y: number };
type Params = { open: number; wide: number; round: number };
type Eye = { poly: Pt[]; skin: string; a: Pt; b: Pt; lowerMid: Pt };

import { FILES, TUNING } from "./tuning";

// ---------- MediaPipe landmark index rings (checked against MediaPipe's own lip/eye connection lists) ----------
// 20 points each, same order: 0 = left corner, 1-9 upper lip, 10 = right corner, 11-19 lower lip.
const OUTER = [
  61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84,
  181, 91, 146,
];
const INNER = [
  78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87,
  178, 88, 95,
];
const EYE_R = [
  33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7,
];
const EYE_L = [
  362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381,
  382,
];
const N = 20;

// Vertex layout in the mesh: ring r starts at r * N.
const OUT = 0;
const IN = N;
const NEAR = 2 * N;
const FAR = 3 * N;
const RING_WEIGHT = [1, 1, 0.6, 0]; // how much of the jaw/mouth motion each ring receives; FAR stays fixed

// ---------- Azure viseme ID -> mouth parameters (IDs from Microsoft's viseme table) ----------
// open = jaw drop, wide = corners spread, round = lips pucker. All 0-1.
const P = (open: number, wide = 0, round = 0): Params => ({
  open,
  wide,
  round,
});
export const VISEME_PARAMS: Params[] = [
  P(0), //  0 silence
  P(0.5, 0.2), //  1 æ ə ʌ
  P(0.95, 0.1), //  2 ɑ
  P(0.65, 0, 0.4), //  3 ɔ
  P(0.4, 0.3), //  4 ɛ ʊ
  P(0.3, 0, 0.35), //  5 ɝ
  P(0.2, 0.75), //  6 j i ɪ
  P(0.15, 0, 1), //  7 w u
  P(0.45, 0, 0.8), //  8 o
  P(0.75, 0, 0.25), //  9 aʊ
  P(0.55, 0, 0.5), // 10 ɔɪ
  P(0.75, 0.2), // 11 aɪ
  P(0.3, 0.1), // 12 h
  P(0.2, 0, 0.4), // 13 ɹ
  P(0.3, 0.25), // 14 l
  P(0.1, 0.6), // 15 s z
  P(0.15, 0, 0.55), // 16 ʃ tʃ dʒ ʒ
  P(0.15, 0.2), // 17 ð
  P(0.06, 0.3), // 18 f v
  P(0.2, 0.2), // 19 d t n θ
  P(0.25, 0.05), // 20 k g ŋ
  P(0), // 21 p b m (lips closed)
];

// ---------- scene ----------
export interface Scene {
  base: HTMLCanvasElement; // the person, drawn at output size (slightly overscanned so head motion never shows edges)
  bg: HTMLCanvasElement | null; // optional static background, drawn behind and never moved
  w: number;
  h: number;
  S: Pt[]; // source mesh vertices: OUT, IN, NEAR, FAR rings
  c: Pt; // mouth center
  w0: number; // mouth width in pixels (scale reference)
  pivot: Pt; // head rotates around the chin
  eyes: Eye[];
  tris: number[][];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = (pts: Pt[]): Pt => ({
  x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
  y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});

function strip(A: number, B: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    out.push([A + i, A + j, B + i], [A + j, B + j, B + i]);
  }
  return out;
}

function sampleSkin(base: HTMLCanvasElement, at: Pt): string {
  const g = base.getContext("2d")!;
  const x = Math.max(1, Math.min(base.width - 2, Math.round(at.x)));
  const y = Math.max(1, Math.min(base.height - 2, Math.round(at.y)));
  const d = g.getImageData(x - 1, y - 1, 3, 3).data;
  let r = 0,
    gr = 0,
    b = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i];
    gr += d[i + 1];
    b += d[i + 2];
  }
  const n = d.length / 4;
  return `rgb(${Math.round(r / n)},${Math.round(gr / n)},${Math.round(b / n)})`;
}

/** lm = the 478 MediaPipe landmarks in base-canvas pixel coordinates. */
export function buildScene(
  base: HTMLCanvasElement,
  lm: Pt[],
  bg: HTMLCanvasElement | null = null,
): Scene {
  const outer = OUTER.map((i) => lm[i]);
  const inner = INNER.map((i) => lm[i]);
  const c = mean(inner);
  const w0 = dist(lm[61], lm[291]);

  const push = (p: Pt, pad: number): Pt => {
    const dx = p.x - c.x,
      dy = p.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / d) * pad * 0.6, y: p.y + (dy / d) * pad }; // reach less sideways so the face contour is left alone
  };
  const near = outer.map((p) => push(p, 0.45 * w0));
  const far = outer.map((p) => push(p, 0.95 * w0));

  const makeEye = (
    ring: number[],
    upper: number,
    lower: number,
    a: number,
    b: number,
  ): Eye => {
    const eyeW = dist(lm[a], lm[b]);
    return {
      poly: ring.map((i) => lm[i]),
      skin: sampleSkin(base, {
        x: lm[upper].x,
        y: lm[upper].y - TUNING.blink.skinSampleOffset * eyeW,
      }),
      a: lm[a],
      b: lm[b],
      lowerMid: lm[lower],
    };
  };

  return {
    base,
    bg,
    w: base.width,
    h: base.height,
    S: [...outer, ...inner, ...near, ...far],
    c,
    w0,
    pivot: lm[152],
    eyes: [
      makeEye(EYE_R, 159, 145, 33, 133),
      makeEye(EYE_L, 386, 374, 362, 263),
    ],
    tris: [...strip(IN, OUT), ...strip(OUT, NEAR), ...strip(NEAR, FAR)],
  };
}

// ---------- deformation ----------
function deform(s: Scene, p: Params): Pt[] {
  const D: Pt[] = new Array(4 * N);
  const T = TUNING.motion;
  const jaw = p.open * T.jawDrop * s.w0;
  const hx = 1 + T.lipSpread * p.wide - T.lipPucker * p.round; // horizontal stretch: spread for "ee", pucker for "oo"

  for (let r = 0; r < 4; r++) {
    const w = RING_WEIGHT[r];
    for (let i = 0; i < N; i++) {
      const src = s.S[r * N + i];
      const x = s.c.x + (src.x - s.c.x) * (1 + (hx - 1) * w);
      let y = src.y;
      if (i >= 11) {
        y +=
          jaw *
          w *
          (T.cornerFollow +
            (1 - T.cornerFollow) * Math.sin((Math.PI * (i - 10)) / 10)); // lower lip + chin follow the jaw
      } else if (i === 0 || i === 10) {
        y += jaw * T.cornerFollow * w - p.wide * T.smileLift * s.w0 * w; // corners: follow a little, lift when smiling
      } else {
        y -= jaw * T.upperLipLift * w * Math.sin((Math.PI * i) / 10); // upper lip lifts slightly
      }
      D[r * N + i] = { x, y };
    }
  }
  return D;
}

/** Affine matrix [a,b,c,d,e,f] mapping source triangle (s) onto destination triangle (d). */
export function affine(s: Pt[], d: Pt[]): number[] | null {
  const [x0, y0] = [s[0].x, s[0].y];
  const [x1, y1] = [s[1].x, s[1].y];
  const [x2, y2] = [s[2].x, s[2].y];
  const den = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
  if (Math.abs(den) < 1e-6) return null;
  const [u0, u1, u2] = [d[0].x, d[1].x, d[2].x];
  const [v0, v1, v2] = [d[0].y, d[1].y, d[2].y];
  return [
    (u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1)) / den,
    (v0 * (y1 - y2) + v1 * (y2 - y0) + v2 * (y0 - y1)) / den,
    (u0 * (x2 - x1) + u1 * (x0 - x2) + u2 * (x1 - x0)) / den,
    (v0 * (x2 - x1) + v1 * (x0 - x2) + v2 * (x1 - x0)) / den,
    (u0 * (x1 * y2 - x2 * y1) +
      u1 * (x2 * y0 - x0 * y2) +
      u2 * (x0 * y1 - x1 * y0)) /
      den,
    (v0 * (x1 * y2 - x2 * y1) +
      v1 * (x2 * y0 - x0 * y2) +
      v2 * (x0 * y1 - x1 * y0)) /
      den,
  ];
}

function drawTri(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement,
  s: Pt[],
  d: Pt[],
) {
  const m = affine(s, d);
  if (!m) return;
  const cx = (d[0].x + d[1].x + d[2].x) / 3;
  const cy = (d[0].y + d[1].y + d[2].y) / 3;
  ctx.save();
  ctx.beginPath();
  d.forEach((q, i) => {
    const dx = q.x - cx,
      dy = q.y - cy;
    const l = Math.hypot(dx, dy) || 1;
    const gx = q.x + (dx / l) * 0.7; // grow 0.7px so neighbouring triangles overlap and leave no seams
    const gy = q.y + (dy / l) * 0.7;
    if (i === 0) ctx.moveTo(gx, gy);
    else ctx.lineTo(gx, gy);
  });
  ctx.closePath();
  ctx.clip();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

function polyPath(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((q, i) =>
    i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y),
  );
  ctx.closePath();
}

function drawMouthInterior(
  ctx: CanvasRenderingContext2D,
  D: Pt[],
  p: Params,
  w0: number,
) {
  const M = TUNING.mouth;
  const Th = TUNING.teeth;
  if (p.open < M.minOpenToShow) return;
  const poly = D.slice(IN, IN + N);
  const xs = poly.map((q) => q.x),
    ys = poly.map((q) => q.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const w = maxX - minX,
    h = maxY - minY;
  const fade = Math.min(1, p.open * M.appearSpeed);

  ctx.save();
  polyPath(ctx, poly);
  ctx.clip();
  ctx.globalAlpha = fade;

  // dark cavity
  const cavity = ctx.createLinearGradient(0, minY, 0, maxY);
  cavity.addColorStop(0, M.cavityTop);
  cavity.addColorStop(1, M.cavityBottom);
  ctx.fillStyle = cavity;
  ctx.fillRect(minX - 2, minY - 2, w + 4, h + 4);

  // tongue, low in the mouth
  if (p.open > M.tongueMinOpen) {
    ctx.fillStyle = M.tongueColor;
    ctx.beginPath();
    ctx.ellipse(
      (minX + maxX) / 2,
      maxY,
      w * M.tongueWidth,
      h * M.tongueHeight,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // depth: shadow under the upper lip and in both corners (drawn before the teeth so the teeth stay bright)
  const top = ctx.createLinearGradient(
    0,
    minY,
    0,
    minY + h * M.upperLipShadowDepth,
  );
  top.addColorStop(0, `rgba(0,0,0,${M.upperLipShadow})`);
  top.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = top;
  ctx.fillRect(minX - 2, minY - 2, w + 4, h * M.upperLipShadowDepth + 2);
  const sides = ctx.createLinearGradient(minX, 0, maxX, 0);
  sides.addColorStop(0, `rgba(0,0,0,${M.cornerShadow})`);
  sides.addColorStop(M.cornerShadowWidth, "rgba(0,0,0,0)");
  sides.addColorStop(1 - M.cornerShadowWidth, "rgba(0,0,0,0)");
  sides.addColorStop(1, `rgba(0,0,0,${M.cornerShadow})`);
  ctx.fillStyle = sides;
  ctx.fillRect(minX - 2, minY - 2, w + 4, h + 4);

  // upper teeth
  const teethH = Math.min(
    h * Th.maxHeightShare,
    Th.baseHeight * w0 + p.open * Th.heightPerOpen * w0,
  );
  if (teethH > 1) {
    const tx = minX + w * Th.sideInset;
    const tw = w * (1 - 2 * Th.sideInset);
    const ty = D[IN + 5].y - 1;
    const r = teethH * Th.cornerRadius;
    const g = ctx.createLinearGradient(0, ty, 0, ty + teethH);
    g.addColorStop(0, Th.colorTop);
    g.addColorStop(Th.middleStop, Th.colorMiddle);
    g.addColorStop(1, Th.colorBottom);
    ctx.globalAlpha = fade * (1 - Th.hideOnPucker * p.round);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx + tw, ty);
    ctx.lineTo(tx + tw, ty + teethH - r);
    ctx.quadraticCurveTo(tx + tw, ty + teethH, tx + tw - r, ty + teethH);
    ctx.lineTo(tx + r, ty + teethH);
    ctx.quadraticCurveTo(tx, ty + teethH, tx, ty + teethH - r);
    ctx.closePath();
    ctx.fill();

    // faint gaps between teeth so it doesn't read as one slab
    ctx.strokeStyle = Th.gapColor;
    ctx.lineWidth = Th.gapWidth;
    for (let k = 1; k < Th.count; k++) {
      const gx = tx + (tw * k) / Th.count;
      ctx.beginPath();
      ctx.moveTo(gx, ty);
      ctx.lineTo(gx, ty + teethH * Th.gapLength);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawBlink(ctx: CanvasRenderingContext2D, eyes: Eye[], blink: number) {
  if (blink < 0.02) return;
  for (const e of eyes) {
    ctx.save();
    polyPath(ctx, e.poly);
    ctx.globalAlpha = Math.min(1, blink * 1.4);
    ctx.fillStyle = e.skin;
    ctx.shadowColor = e.skin;
    ctx.shadowBlur = 3;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = blink;
    ctx.strokeStyle = TUNING.blink.lashColor;
    ctx.lineWidth = TUNING.blink.lashWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(e.a.x, e.a.y);
    ctx.quadraticCurveTo((e.a.x + e.b.x) / 2, e.lowerMid.y + 1, e.b.x, e.b.y);
    ctx.stroke();
    ctx.restore();
  }
}

function drawDebug(ctx: CanvasRenderingContext2D, s: Scene, D: Pt[]) {
  const colors = ["#00ff66", "#ff3355", "#3399ff", "#ffaa00"];
  for (let r = 0; r < 4; r++) {
    ctx.fillStyle = colors[r];
    for (let i = 0; i < N; i++)
      ctx.fillRect(D[r * N + i].x - 1.5, D[r * N + i].y - 1.5, 3, 3);
  }
  ctx.strokeStyle = "#00ffff";
  ctx.lineWidth = 1;
  for (const e of s.eyes) {
    polyPath(ctx, e.poly);
    ctx.stroke();
  }
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  p: Params,
  blink: number,
  t: number,
  energy: number,
  debug = false,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, s.w, s.h);
  if (s.bg) ctx.drawImage(s.bg, 0, 0); // the background stays still; only the person moves

  // idle head motion, a little livelier while speaking
  const H = TUNING.head;
  const k = s.bg ? H.amount : H.amountOnFlatPhoto;
  const angle =
    k *
    (H.tilt * Math.sin(t * 0.7) +
      H.tiltFast * Math.sin(t * 1.9) +
      energy * H.tiltWhenSpeaking * Math.sin(t * 3.1));
  const scale =
    1 + k * (H.zoom * Math.sin(t * 0.4) + H.zoomWhenSpeaking * energy);
  ctx.translate(
    s.pivot.x + k * H.driftX * Math.sin(t * 0.5),
    s.pivot.y + k * H.driftY * Math.sin(t * 0.63 + 1),
  );
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.translate(-s.pivot.x, -s.pivot.y);

  ctx.drawImage(s.base, 0, 0);
  drawBlink(ctx, s.eyes, blink);

  const D = deform(s, p);
  for (const [a, b, c] of s.tris)
    drawTri(ctx, s.base, [s.S[a], s.S[b], s.S[c]], [D[a], D[b], D[c]]);
  drawMouthInterior(ctx, D, p, s.w0);
  if (debug) drawDebug(ctx, s, D);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ---------- public API ----------
const DEMO_SEQUENCE = [2, 6, 7, 21, 4, 15, 1, 8, 0, 9, 21, 16, 0];
/** Cycles through mouth shapes with no audio. Handy for checking the face before wiring any APIs. */
export function demoViseme(): number {
  return DEMO_SEQUENCE[
    Math.floor(performance.now() / 220) % DEMO_SEQUENCE.length
  ];
}

/** Loads the first URL that is really an image. (In dev, Vite answers missing files with a web page, which fails to decode, so we move on.) */
async function loadFirstImage(
  urls: string[],
): Promise<HTMLImageElement | null> {
  for (const url of urls) {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      return img;
    } catch {
      // not there, try the next name
    }
  }
  return null;
}

async function loadSingleImage(url: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

export async function createAvatar(canvas: HTMLCanvasElement, avatarPath?: string): Promise<Avatar> {
  const img = avatarPath 
    ? await loadSingleImage(avatarPath)
    : await loadFirstImage(FILES.avatar);
  if (!img)
    throw new Error(
      "Could not load your photo. Put it in public/ as avatar.png (or avatar.jpg).",
    );
  const bgImg = await loadFirstImage(FILES.background);

  // 1. Find the face landmarks once, on the original full-resolution photo.
  const fileset = await FilesetResolver.forVisionTasks("/wasm");
  const landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: "/face_landmarker.task" },
    runningMode: "IMAGE",
    numFaces: 1,
  });
  const face = landmarker.detect(img).faceLandmarks[0];
  landmarker.close();
  if (!face)
    throw new Error(
      "No face found in the photo. Use a clear, front-facing photo.",
    );

  // 2. Draw the photo to a base canvas at output size (cover-fit, 5% overscan).
  const W = canvas.width,
    H = canvas.height;
  const scale = Math.max(W / img.naturalWidth, H / img.naturalHeight) * 1.05;
  const dw = img.naturalWidth * scale,
    dh = img.naturalHeight * scale;
  const ox = (W - dw) / 2,
    oy = (H - dh) / 2;
  const base = document.createElement("canvas");
  base.width = W;
  base.height = H;
  base
    .getContext("2d", { willReadFrequently: true })!
    .drawImage(img, ox, oy, dw, dh);

  // optional static background, cover-fit to the tile with no overscan (it never moves)
  let bg: HTMLCanvasElement | null = null;
  if (bgImg) {
    const bk = Math.max(W / bgImg.naturalWidth, H / bgImg.naturalHeight);
    const bw = bgImg.naturalWidth * bk,
      bh = bgImg.naturalHeight * bk;
    bg = document.createElement("canvas");
    bg.width = W;
    bg.height = H;
    bg.getContext("2d")!.drawImage(bgImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
  }

  const scene = buildScene(
    base,
    face.map((q) => ({ x: ox + q.x * dw, y: oy + q.y * dh })),
    bg,
  );
  const ctx = canvas.getContext("2d")!;
  const debug = location.hash.includes("debug");

  const params: Params = { open: 0, wide: 0, round: 0 };
  let energy = 0;
  let blinkStart = -1;
  let nextBlink =
    TUNING.blink.firstMin +
    Math.random() * (TUNING.blink.firstMax - TUNING.blink.firstMin);
  let last = 0;
  let raf = 0;
  let getViseme: () => number = () => 0;

  const approach = (cur: number, target: number, dt: number) =>
    cur +
    (target - cur) *
      (1 -
        Math.exp(
          -dt /
            (target > cur
              ? TUNING.motion.openSeconds
              : TUNING.motion.closeSeconds),
        )); // open fast, close a bit slower

  function frame(now: number) {
    const t = now / 1000;
    const dt = Math.min(0.1, Math.max(0.001, t - last));
    last = t;

    const id = getViseme();
    const target = VISEME_PARAMS[id] ?? VISEME_PARAMS[0];
    params.open = approach(params.open, target.open, dt);
    params.wide = approach(params.wide, target.wide, dt);
    params.round = approach(params.round, target.round, dt);
    energy += ((id !== 0 ? 1 : 0) - energy) * (1 - Math.exp(-dt / 0.25));

    let blink = 0;
    if (blinkStart < 0 && t >= nextBlink) blinkStart = t;
    if (blinkStart >= 0) {
      const ph = (t - blinkStart) / TUNING.blink.seconds;
      if (ph >= 1) {
        blinkStart = -1;
        nextBlink =
          t +
          TUNING.blink.gapMin +
          Math.random() * (TUNING.blink.gapMax - TUNING.blink.gapMin);
      } else {
        blink = Math.sin(ph * Math.PI);
      }
    }

    renderScene(ctx, scene, params, blink, t, energy, debug);
    raf = requestAnimationFrame(frame);
  }

  renderScene(ctx, scene, params, 0, 0, 0, debug); // show the neutral face immediately

  return {
    start(fn) {
      getViseme = fn;
      cancelAnimationFrame(raf);
      last = performance.now() / 1000;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(raf);
    },
  };
}
