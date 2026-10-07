export interface Recorder {
  start(): void;
  /** Stops recording, finishes the upload, and releases the canvas and audio resources. */
  stop(): Promise<void>;
}

export interface RecorderOptions {
  avatarCanvas: HTMLCanvasElement;
  camVideo: HTMLVideoElement;
  micStream: MediaStream; // your microphone
  avatarAudio: MediaStream; // Speaker.audioStream from tts.ts
  sessionId: string; // the recording is saved as recordings/<sessionId>.webm
  /** Current subtitle text for each tile; drawn onto the video. Return empty strings for no captions. */
  getCaptions?: () => { avatar: string; user: string };
  onError?: (message: string) => void;
}

const TILE_W = 640;
const TILE_H = 480; // 480p per tile -> 1280x480 side-by-side
const FPS = 30;
const CHUNK_MS = 2000; // uploaded every 2s, so RAM stays small and a crash loses at most 2s

function wrapLines(
  g: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (line && g.measureText(test).width > maxW) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws a subtitle box at the bottom of one tile. Shows the last 2 lines if the text is longer. */
export function drawCaption(
  g: CanvasRenderingContext2D,
  text: string,
  tileX: number,
  tileW = TILE_W,
  tileH = TILE_H,
) {
  const t = text.trim();
  if (!t) return;
  g.save();
  g.font = '600 22px system-ui, -apple-system, "Segoe UI", sans-serif';
  const lines = wrapLines(g, t, tileW - 64).slice(-2);
  const lineH = 28;
  const padX = 14;
  const padY = 8;
  const boxW = Math.max(...lines.map((l) => g.measureText(l).width)) + padX * 2;
  const boxH = lines.length * lineH + padY * 2;
  const x = tileX + (tileW - boxW) / 2;
  const y = tileH - 24 - boxH;
  const r = 8;

  g.fillStyle = "rgba(0,0,0,0.65)";
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + boxW - r, y);
  g.quadraticCurveTo(x + boxW, y, x + boxW, y + r);
  g.lineTo(x + boxW, y + boxH - r);
  g.quadraticCurveTo(x + boxW, y + boxH, x + boxW - r, y + boxH);
  g.lineTo(x + r, y + boxH);
  g.quadraticCurveTo(x, y + boxH, x, y + boxH - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
  g.fill();

  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  lines.forEach((l, i) =>
    g.fillText(l, tileX + tileW / 2, y + padY + lineH * (i + 0.5)),
  );
  g.restore();
}

function pickMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const {
    avatarCanvas,
    camVideo,
    micStream,
    avatarAudio,
    sessionId,
    getCaptions,
    onError,
  } = opts;

  // ----- video: avatar and webcam drawn side by side on one canvas -----
  const canvas = document.createElement("canvas");
  canvas.width = TILE_W * 2;
  canvas.height = TILE_H;
  const g = canvas.getContext("2d")!;

  function drawFrame() {
    g.fillStyle = "#000";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(avatarCanvas, 0, 0, TILE_W, TILE_H);

    const vw = camVideo.videoWidth;
    const vh = camVideo.videoHeight;
    if (vw && vh) {
      // cover-fit the webcam into its tile; not mirrored in the recording
      const k = Math.max(TILE_W / vw, TILE_H / vh);
      const sw = TILE_W / k;
      const sh = TILE_H / k;
      g.drawImage(
        camVideo,
        (vw - sw) / 2,
        (vh - sh) / 2,
        sw,
        sh,
        TILE_W,
        0,
        TILE_W,
        TILE_H,
      );
    }

    const caps = getCaptions?.();
    if (caps) {
      drawCaption(g, caps.avatar, 0);
      drawCaption(g, caps.user, TILE_W);
    }
  }

  // ----- audio: your mic + her voice mixed into one track -----
  const audioCtx = new AudioContext();
  void audioCtx.resume();
  const mix = audioCtx.createMediaStreamDestination();
  audioCtx.createMediaStreamSource(micStream).connect(mix);
  audioCtx.createMediaStreamSource(avatarAudio).connect(mix);

  const stream = new MediaStream([
    ...canvas.captureStream(FPS).getVideoTracks(),
    ...mix.stream.getAudioTracks(),
  ]);
  const mr = new MediaRecorder(stream, {
    mimeType: pickMimeType(),
    videoBitsPerSecond: 1_500_000,
    audioBitsPerSecond: 128_000,
  });

  // ----- upload: chunks are sent in order and appended to the file on the server -----
  let uploads: Promise<void> = Promise.resolve();
  mr.ondataavailable = (e) => {
    if (e.data.size === 0) return;
    uploads = uploads.then(async () => {
      try {
        const res = await fetch(
          `/api/recording?id=${encodeURIComponent(sessionId)}`,
          { method: "POST", body: e.data },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        onError?.(`Recording upload failed: ${err}`);
      }
    });
  };

  let timer = 0;

  return {
    start() {
      drawFrame();
      timer = window.setInterval(drawFrame, 1000 / FPS);
      mr.start(CHUNK_MS);
    },

    async stop() {
      if (mr.state !== "inactive") {
        const stopped = new Promise<void>(
          (resolve) => (mr.onstop = () => resolve()),
        );
        mr.stop(); // fires one last dataavailable, then stop
        await stopped;
      }
      await uploads;
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      await audioCtx.close();
    },
  };
}
