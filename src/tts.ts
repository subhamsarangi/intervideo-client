import * as sdk from "microsoft-cognitiveservices-speech-sdk";

export interface Speaker {
  /**
   * Synthesizes and plays the text. Calls are queued. Resolves when playback ends.
   * onCaption is called with each subtitle chunk at roughly the moment it is spoken.
   */
  speak(text: string, onCaption?: (chunk: string) => void): Promise<void>;
  /** Azure viseme ID (0-21) for the audio playing right now. 0 = silence. Call once per frame. */
  currentViseme(): number;
  isSpeaking(): boolean;
  /** The avatar's audio as a MediaStream, for the recorder to mix. */
  readonly audioStream: MediaStream;
  /** Stops current playback immediately. */
  stop(): void;
  close(): void;
}

type VisemeEvent = { t: number; id: number }; // t = seconds from audio start

type Playing = {
  source: AudioBufferSourceNode;
  startedAt: number;
  visemes: VisemeEvent[];
  idx: number;
};

/** Splits a reply into subtitle-sized chunks: sentences first, then long sentences cut near the middle (preferably after a comma). */
export function chunkCaptions(text: string, maxChars = 100): string[] {
  const sentences =
    text
      .replace(/\s+/g, " ")
      .trim()
      .match(/.+?(?:[.!?\u2026]+["')\]]*(?=\s|$)|$)/g) ?? [];
  const out: string[] = [];
  const split = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    if (s.length <= maxChars) {
      out.push(s);
      return;
    }
    const mid = s.length / 2;
    let cut = -1;
    let best = Infinity;
    for (let i = 1; i < s.length - 1; i++) {
      if (s[i] !== " ") continue;
      const score = Math.abs(i - mid) - (s[i - 1] === "," ? 15 : 0);
      if (score < best) {
        best = score;
        cut = i;
      }
    }
    if (cut < 0) {
      out.push(s);
      return;
    }
    split(s.slice(0, cut));
    split(s.slice(cut + 1));
  };
  sentences.forEach(split);
  return out;
}

const DEFAULT_VOICE = "en-US-JennyNeural"; // must be an en-US neural voice: visemes are only sent for supported voices
const TOKEN_REFRESH_MS = 8 * 60_000; // Azure tokens last 10 minutes

async function fetchToken(): Promise<{ token: string; region: string }> {
  const res = await fetch("/api/token");
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  return res.json();
}

export async function createSpeaker(
  voice: string = DEFAULT_VOICE,
): Promise<Speaker> {
  const ctx = new AudioContext();
  await ctx.resume(); // call this after a user click, or the browser blocks audio
  const recordDest = ctx.createMediaStreamDestination();

  const { token, region } = await fetchToken();
  const config = sdk.SpeechConfig.fromAuthorizationToken(token, region);
  config.speechSynthesisVoiceName = voice;
  config.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;

  // null audio config = the SDK plays nothing; we get raw audio back and play it ourselves
  // so the same audio goes to the speakers AND the recording.
  const synth = new sdk.SpeechSynthesizer(
    config,
    null as unknown as sdk.AudioConfig,
  );

  const refreshTimer = setInterval(async () => {
    try {
      synth.authorizationToken = (await fetchToken()).token;
    } catch (err) {
      console.error("azure token refresh failed:", err);
    }
  }, TOKEN_REFRESH_MS);

  let playing: Playing | null = null;
  let chain: Promise<void> = Promise.resolve();

  function synthesize(
    text: string,
  ): Promise<{ audio: ArrayBuffer; visemes: VisemeEvent[] }> {
    return new Promise((resolve, reject) => {
      const visemes: VisemeEvent[] = [];
      // audioOffset is in 100-ns ticks -> seconds = ticks / 10,000,000
      synth.visemeReceived = (_s, e) =>
        visemes.push({ t: e.audioOffset / 10_000_000, id: e.visemeId });

      synth.speakTextAsync(
        text,
        (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
            resolve({ audio: result.audioData, visemes });
          } else {
            reject(new Error(result.errorDetails || "speech synthesis failed"));
          }
        },
        (err) => reject(new Error(String(err))),
      );
    });
  }

  async function play(
    audio: ArrayBuffer,
    visemes: VisemeEvent[],
    text: string,
    onCaption?: (chunk: string) => void,
  ): Promise<void> {
    const buffer = await ctx.decodeAudioData(audio.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.connect(recordDest);

    return new Promise((resolve) => {
      const startedAt = ctx.currentTime + 0.05;
      const entry: Playing = { source, startedAt, visemes, idx: 0 };

      // Subtitles: each chunk appears at its share of the audio length (by character count).
      const timers: number[] = [];
      if (onCaption) {
        const chunks = chunkCaptions(text);
        const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
        let used = 0;
        for (const chunk of chunks) {
          timers.push(
            window.setTimeout(
              () => onCaption(chunk),
              50 + (used / total) * buffer.duration * 1000,
            ),
          );
          used += chunk.length;
        }
      }

      source.onended = () => {
        timers.forEach((t) => clearTimeout(t));
        if (playing === entry) playing = null;
        resolve();
      };
      playing = entry;
      source.start(startedAt);
    });
  }

  return {
    speak(text, onCaption) {
      const job = chain.then(async () => {
        const { audio, visemes } = await synthesize(text);
        if (visemes.length === 0) {
          console.warn(
            `No viseme events received. Voice "${voice}" may not support visemes; use an en-US neural voice.`,
          );
        }
        await play(audio, visemes, text, onCaption);
      });
      chain = job.catch(() => {}); // a failed line must not block later ones
      return job;
    },

    currentViseme() {
      if (!playing) return 0;
      // audio reaches the ears outputLatency seconds after ctx.currentTime, so delay the mouth to match
      const t = ctx.currentTime - playing.startedAt - (ctx.outputLatency ?? 0);
      if (t < 0) return 0;
      const v = playing.visemes;
      while (playing.idx + 1 < v.length && v[playing.idx + 1].t <= t)
        playing.idx++;
      return v.length > 0 && v[playing.idx].t <= t ? v[playing.idx].id : 0;
    },

    isSpeaking: () => playing !== null,
    audioStream: recordDest.stream,

    stop() {
      playing?.source.stop();
    },

    close() {
      clearInterval(refreshTimer);
      playing?.source.stop();
      synth.close();
      void ctx.close();
    },
  };
}
