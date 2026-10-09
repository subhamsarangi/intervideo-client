import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import { generateReply, summarize, summarizeSession, type Turn } from "./llm";

const SESSIONS_DIR = path.resolve("sessions");
const FOLD_AT = 24;

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

type Avatar = { id: string; name: string; description?: string; voice?: string };

export async function getAvatar(avatarId?: string): Promise<Avatar | null> {
  try {
    const raw = await readFile(path.resolve("public", "avatars.json"), "utf8");
    const avatars = JSON.parse(raw) as Avatar[];
    return (
      avatars.find((a) => a.id === (avatarId || "avatar-default")) ??
      avatars[0] ??
      null
    );
  } catch (err) {
    console.error("failed to load avatar:", err);
    return null;
  }
}

export async function startSession(ws: WebSocket, systemPrompt: string, avatarId?: string) {
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 6)}`;
  const avatar = await getAvatar(avatarId);
  const avatarName = avatar?.name;

  const replyPrompt = avatarName
    ? `${systemPrompt}\n\nYour name is ${avatarName}. Always use this name if asked who you are. Never use any other name.`
    : systemPrompt;
  const logFile = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  let memory = "";
  const recent: Turn[] = [];
  const allTurns: Turn[] = [];
  let muted = false;
  let chain: Promise<void> = Promise.resolve();

  await appendFile(
    logFile,
    JSON.stringify({
      type: "meta",
      systemPrompt,
      avatarId: avatarId || "avatar-default",
      createdAt: Date.now(),
    }) + "\n"
  );

  const send = (obj: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  const addTurn = async (role: Turn["role"], content: string) => {
    const turn: Turn = { role, content, ts: Date.now() };
    recent.push(turn);
    allTurns.push(turn);
    await appendFile(logFile, JSON.stringify(turn) + "\n");
  };

  const handleTurn = async (userText: string) => {
    try {
      await addTurn("user", userText);
      send({ type: "transcript", text: userText });

      const text = await generateReply(replyPrompt, memory, recent);
      await addTurn("assistant", text);
      send({ type: "reply", text });

      if (recent.length > FOLD_AT) {
        const old = recent.splice(0, Math.floor(recent.length / 2));
        memory = await summarize(memory, old);
      }
    } catch (err) {
      console.error("turn failed:", err);
      send({ type: "error", message: errText(err) });
    }
  };

  const sendGreeting = async () => {
    try {
      const greetingPrompt =
        "Introduce yourself briefly as the interviewer" +
        (avatarName ? `, clearly stating your name is ${avatarName},` : "") +
        " and ask the user to introduce themselves. Keep it warm, professional, and concise (2-3 sentences max).";
      const greeting = await generateReply(replyPrompt, "", [
        { role: "user", content: greetingPrompt, ts: Date.now() },
      ]);
      await addTurn("assistant", greeting);
      send({ type: "reply", text: greeting });
    } catch (err) {
      console.error("greeting failed:", err);
    }
  };

  const dg = await new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY! }).listen.v2.connect({
    model: "flux-general-en",
    encoding: "linear16",
    sample_rate: "16000",
    eot_threshold: 0.8,
  });

  dg.on("message", (m) => {
    if (m.type !== "TurnInfo") return;
    if (m.event === "Update") {
      send({ type: "partial", text: m.transcript });
    } else if (m.event === "EndOfTurn") {
      const text = m.transcript.trim();
      if (text) chain = chain.then(() => handleTurn(text));
    }
  });
  dg.on("error", (err) => {
    console.error("deepgram error:", err);
    send({
      type: "error",
      message: `speech-to-text error: ${errText(err)}`,
      fatal: true,
    });
  });

  dg.connect();
  await dg.waitForOpen();
  send({ type: "ready", sessionId });

  await sendGreeting();

  return {
    audio(chunk: Buffer) {
      if (!muted) dg.sendMedia(chunk);
    },
    setMuted(value: boolean) {
      muted = value;
    },
    async end() {
      dg.close();
      await chain;
      if (allTurns.length >= 2) {
        try {
          const sessionSummary = await summarizeSession(allTurns);
          if (sessionSummary) {
            await appendFile(
              logFile,
              JSON.stringify({ type: "summary", summary: sessionSummary, ts: Date.now() }) + "\n"
            );
          }
        } catch (e) {
          console.error("Failed to generate session summary:", e);
        }
      }
      if (recent.length >= 2) {
        memory = await summarize(memory, recent);
        await appendFile(
          logFile,
          JSON.stringify({ type: "memory", memory, ts: Date.now() }) + "\n"
        );
      }
    },
  };
}
