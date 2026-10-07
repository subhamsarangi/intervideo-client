import { createAvatar, demoViseme, type Avatar } from "./avatar";
import { createSpeaker, type Speaker } from "./tts";
import { createRecorder, type Recorder } from "./recorder";
import {
  parseCallRoute,
  updateCallUrl,
  redirectToSessionDetail,
  beforeunloadHandler,
} from "./call-router";

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("avatar");
const cam = $<HTMLVideoElement>("cam");
const topicDisplay = $<HTMLElement>("topicDisplay");
const topicText = $<HTMLElement>("topicText");
const startBtn = $<HTMLButtonElement>("startBtn");
const stopBtn = $<HTMLButtonElement>("stopBtn");
const statusEl = $<HTMLSpanElement>("status");
const logEl = $<HTMLElement>("log");
const capAvatarEl = $<HTMLElement>("capAvatar");
const capUserEl = $<HTMLElement>("capUser");
const captionsToggle = $<HTMLInputElement>("captionsToggle");

const setStatus = (text: string) => (statusEl.textContent = text);

// ---------- subtitles: shown on the live tiles and burned into the recording ----------
const captions = { avatar: "", user: "" };
let userCaptionTimer = 0;

function refreshCaptions() {
  capAvatarEl.textContent = captionsToggle.checked ? captions.avatar : "";
  capUserEl.textContent = captionsToggle.checked ? captions.user : "";
}

function setCaption(who: "avatar" | "user", text: string) {
  captions[who] = text;
  refreshCaptions();
}

function clearCaptions() {
  clearTimeout(userCaptionTimer);
  captions.avatar = "";
  captions.user = "";
  refreshCaptions();
}

function addBubble(
  role: "user" | "avatar",
  text: string,
  partial = false,
): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = partial ? `${role} partial` : role;
  p.textContent = text; // textContent, never innerHTML: model output is untrusted
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
  return p;
}

// ---------- mic capture: 16 kHz mono PCM16 in 80 ms chunks, which is what Deepgram Flux expects ----------
const WORKLET_CODE = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1280); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        const out = new Int16Array(this.n);
        for (let j = 0; j < this.n; j++) {
          const s = Math.max(-1, Math.min(1, this.buf[j]));
          out[j] = s < 0 ? s * 32768 : s * 32767;
        }
        this.port.postMessage(out.buffer, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
`;

// ---------- state ----------
let avatar: Avatar | null = null;
let speaker: Speaker | null = null;
let recorder: Recorder | null = null;
let media: MediaStream | null = null;
let micCtx: AudioContext | null = null;
let ws: WebSocket | null = null;
let sessionId = "";
let inCall = false;
let ending = false;
let micOpen = false; // audio is only sent while true (closed while the avatar speaks)
let pendingSpeech = 0;
let partialEl: HTMLParagraphElement | null = null;

const sendJson = (obj: unknown) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

// ---------- server messages ----------
function onServerMessage(ev: MessageEvent) {
  if (!inCall) return; // late message after the call ended
  const msg = JSON.parse(ev.data as string);

  switch (msg.type) {
    case "ready": {
      sessionId = msg.sessionId;
      // Update URL with session ID (replaces history so back button doesn't break)
      updateCallUrl(sessionId);
      try {
        recorder = createRecorder({
          avatarCanvas: canvas,
          camVideo: cam,
          micStream: new MediaStream(media!.getAudioTracks()),
          avatarAudio: speaker!.audioStream,
          sessionId,
          getCaptions: () =>
            captionsToggle.checked ? captions : { avatar: "", user: "" },
          onError: setStatus,
        });
        recorder.start();
      } catch (err) {
        recorder = null;
        console.error(err);
        setStatus(`Recording unavailable: ${err}`);
      }
      micOpen = true;
      setStatus(
        recorder ? "Listening... (recording)" : "Listening... (NOT recording)",
      );
      break;
    }

    case "partial": {
      partialEl ??= addBubble("user", "", true);
      partialEl.textContent = msg.text;
      clearTimeout(userCaptionTimer);
      setCaption("user", msg.text);
      logEl.scrollTop = logEl.scrollHeight;
      break;
    }

    case "transcript": {
      partialEl?.remove();
      partialEl = null;
      addBubble("user", msg.text);
      setCaption("user", msg.text);
      userCaptionTimer = window.setTimeout(() => setCaption("user", ""), 4000);
      setStatus("Thinking...");
      break;
    }

    case "reply": {
      if (!speaker || !inCall) break;
      addBubble("avatar", msg.text);
      pendingSpeech++;
      micOpen = false; // don't let the mic hear her own voice
      sendJson({ type: "mute", value: true });
      setStatus("Speaking...");

      speaker
        .speak(msg.text, (chunk) => {
          clearTimeout(userCaptionTimer);
          setCaption("user", "");
          setCaption("avatar", chunk);
        })
        .catch((err) => {
          console.error(err);
          setStatus(`Voice error: ${err}`);
        })
        .finally(() => {
          setCaption("avatar", "");
          pendingSpeech--;
          if (pendingSpeech === 0 && inCall) {
            micOpen = true;
            sendJson({ type: "mute", value: false });
            setStatus(
              recorder
                ? "Listening... (recording)"
                : "Listening... (NOT recording)",
            );
          }
        });
      break;
    }

    case "error": {
      if (msg.fatal) void endCall(`Error: ${msg.message}`);
      else setStatus(`Error: ${msg.message}`);
      break;
    }
  }
}

// Extract avatar and system prompt from URL params at startup
const urlParams = new URLSearchParams(window.location.search);
const avatarPathFromUrl = urlParams.get("avatarPath");
const avatarIdFromUrl = urlParams.get("avatarId");
const avatarVoiceFromUrl = urlParams.get("avatarVoice");
const systemPromptFromUrl = urlParams.get("prompt");
const topicFromUrl = urlParams.get("topic");

// ---------- start / end ----------
async function startCall() {
  startBtn.disabled = true;
  ending = false;
  inCall = true;
  pendingSpeech = 0;

  try {
    setStatus("Requesting camera and mic...");
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
    });
    cam.srcObject = media;
    await cam.play();

    setStatus("Starting voice...");
    speaker = await createSpeaker(avatarVoiceFromUrl || undefined); // after the click, so the browser allows audio
    const sp = speaker;
    avatar!.start(() => sp.currentViseme());

    micCtx = new AudioContext({ sampleRate: 16000 });
    await micCtx.resume();
    const url = URL.createObjectURL(
      new Blob([WORKLET_CODE], { type: "application/javascript" }),
    );
    await micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const source = micCtx.createMediaStreamSource(
      new MediaStream(media.getAudioTracks()),
    );
    const capture = new AudioWorkletNode(micCtx, "pcm-capture");
    const silent = micCtx.createGain(); // worklet output goes nowhere audible, but keeps the node pulled
    silent.gain.value = 0;
    source.connect(capture);
    capture.connect(silent);
    silent.connect(micCtx.destination);
    capture.port.onmessage = (e) => {
      if (micOpen && ws?.readyState === WebSocket.OPEN)
        ws.send(e.data as ArrayBuffer);
    };

    setStatus("Connecting to server...");
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    ws = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "start",
          systemPrompt: systemPromptFromUrl || undefined,
          avatarId: avatarIdFromUrl || undefined,
        }),
      );
    };
    socket.onmessage = onServerMessage;
    socket.onclose = () => {
      if (inCall) void endCall("Connection to server lost");
    };
    stopBtn.disabled = false;
  } catch (err) {
    console.error(err);
    await endCall(
      `Could not start: ${err instanceof Error ? err.message : err}`,
    );
  }
}

async function endCall(reason = "Call ended") {
  if (ending) return;
  ending = true;
  inCall = false;
  micOpen = false;
  stopBtn.disabled = true;

  ws?.close(); // the server then folds this conversation into long-term memory
  ws = null;
  speaker?.stop();

  const hadRecording = recorder !== null;
  if (recorder) {
    setStatus("Saving recording...");
    try {
      await recorder.stop();
    } catch (err) {
      console.error(err);
    }
    recorder = null;
  }

  speaker?.close();
  speaker = null;
  await micCtx?.close().catch(() => {});
  micCtx = null;
  media?.getTracks().forEach((t) => t.stop());
  media = null;
  cam.srcObject = null;
  avatar?.stop();

  partialEl?.remove();
  partialEl = null;
  clearCaptions();
  setStatus(
    hadRecording ? `${reason}. Saved to recordings/${sessionId}.webm` : reason,
  );
  startBtn.disabled = false;
  ending = false;

  // Redirect to session detail page after call ends
  if (sessionId) {
    setTimeout(() => {
      redirectToSessionDetail(sessionId);
    }, 2000); // 2 second delay to show the "Saved" message
  }
}

// ---------- init ----------
async function init() {
  // Check if returning to a call URL with session ID
  const route = parseCallRoute();
  if (route.isReturningToSession && route.sessionId) {
    setStatus("Redirecting to session...");
    try {
      // Redirect to session detail page immediately
      redirectToSessionDetail(route.sessionId);
      return; // prevent further execution
    } catch (err) {
      setStatus(`Redirect error: ${err instanceof Error ? err.message : String(err)}`);
      console.error("Redirect error:", err);
      // Continue if redirect fails for some reason
    }
  }

  // Extract avatar and system prompt from URL params
  const url = new URL(window.location.href);
  const avatarPath = url.searchParams.get("avatarPath");
  const topic = url.searchParams.get("topic");

  // Display topic if provided
  if (topic) {
    topicText.textContent = topic;
    topicDisplay.style.display = "block";
  }

  startBtn.disabled = true;
  stopBtn.disabled = true;
  setStatus("Loading face model...");
  try {
    avatar = await createAvatar(canvas, avatarPathFromUrl || undefined);
  } catch (err) {
    console.error(err);
    setStatus(`Avatar error: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (location.hash.includes("demo")) {
    avatar.start(demoViseme);
    setStatus("Demo mode: mouth animation only, no APIs used");
    return;
  }

  startBtn.disabled = false;
  setStatus("Idle");
}

// Add beforeunload warning when in an active call
window.addEventListener("beforeunload", (e) => {
  const message = beforeunloadHandler(inCall);
  if (message) {
    // Modern browsers show their own message, but we can set returnValue
    e.preventDefault();
    e.returnValue = message;
  }
});

captionsToggle.addEventListener("change", refreshCaptions);
startBtn.addEventListener("click", () => void startCall());
stopBtn.addEventListener("click", () => void endCall());
void init();
