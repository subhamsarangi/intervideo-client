import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import PDFDocument from "pdfkit";
import { WebSocketServer, type WebSocket } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import OpenAI from "openai";

// ---------- config ----------
const PORT = Number(process.env.PORT ?? 8787);
const LLM_MODEL = "gpt-5.4-nano";
const SESSIONS_DIR = path.resolve("sessions");
const RECORDINGS_DIR = path.resolve("recordings");
const FOLD_AT = 24; // when recent turns exceed this, fold the oldest half into session-specific memory

for (const key of [
  "DEEPGRAM_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_SPEECH_KEY",
  "AZURE_SPEECH_REGION",
]) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
}
const AZURE_KEY = process.env.AZURE_SPEECH_KEY!;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION!;

const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY! });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

await mkdir(SESSIONS_DIR, { recursive: true });
await mkdir(RECORDINGS_DIR, { recursive: true });

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

// ---------- memory ----------
type Turn = { role: "user" | "assistant"; content: string; ts: number };

// ---------- LLM ----------
const VOICE_RULES =
  "You are speaking aloud in a live video call. Reply in 1-3 short, natural spoken sentences. " +
  "No markdown, lists, emojis or stage directions.";

async function generateReply(
  systemPrompt: string,
  memory: string,
  turns: Turn[],
): Promise<string> {
  const instructions = [
    systemPrompt,
    VOICE_RULES,
    memory && `Your memory of earlier conversations with this user:\n${memory}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await openai.responses.create({
    model: LLM_MODEL,
    instructions,
    input: turns.map((t) => ({ role: t.role, content: t.content })),
    reasoning: { effort: "none" },
    max_output_tokens: 300,
  });
  return res.output_text.trim();
}

async function summarize(oldNotes: string, turns: Turn[]): Promise<string> {
  const transcript = turns
    .map((t) => `${t.role === "user" ? "User" : "Avatar"}: ${t.content}`)
    .join("\n");
  const res = await openai.responses.create({
    model: LLM_MODEL,
    instructions:
      "You maintain long-term memory notes for a conversational avatar. Merge the new conversation into the " +
      "existing notes. Keep names, facts, preferences and unresolved topics. Max 200 words. Output only the notes.",
    input: `Existing notes:\n${oldNotes || "(none)"}\n\nNew conversation:\n${transcript}`,
    reasoning: { effort: "none" },
    max_output_tokens: 400,
  });
  return res.output_text.trim();
}

async function summarizeSession(turns: Turn[]): Promise<string> {
  if (!turns || turns.length === 0) return "";
  const transcript = turns
    .map((t) => `${t.role === "user" ? "User" : "Avatar"}: ${t.content}`)
    .join("\n");
  const res = await openai.responses.create({
    model: LLM_MODEL,
    instructions:
      "You are a concise executive assistant creating a crisp summary of a video call transcript. " +
      "Output in clean, structured Markdown with short bullet points:\n" +
      "- **Topic / Context**: 1 tight sentence on call objective or core theme.\n" +
      "- **Key Highlights**: 2 to 4 concise bullet points covering critical arguments, questions, or responses.\n" +
      "- **Outcome / Next Steps**: 1 sentence summary of conclusion, consensus, or unresolved point.\n" +
      "No preamble, no conversational filler, max 150 words.",
    input: `Conversation transcript:\n${transcript}`,
    reasoning: { effort: "none" },
    max_output_tokens: 350,
  });
  return res.output_text.trim();
}

// ---------- topic validation & interpolation ----------
async function validateTopic(topic: string): Promise<{ valid: boolean; reason?: string; suggestions?: string[] }> {
  // Basic checks first
  if (topic.length < 3) {
    return { valid: false, reason: "Topic too short. Please provide at least 3 characters." };
  }
  
  if (topic.length > 100) {
    return { valid: false, reason: "Topic too long. Please keep it under 100 characters." };
  }
  
  // LLM validation for substance and appropriateness
  try {
    const res = await openai.responses.create({
      model: LLM_MODEL,
      instructions:
        "You are a strict topic validator for a video call conversation system. " +
        "REJECT topics that are: greetings ('hi', 'hello', 'hi there'), meaningless ('ok', 'test', 'checking'), " +
        "too vague ('stuff', 'things', 'something', 'idk'), or harmful/illegal/abusive content. " +
        "ACCEPT topics that represent specific subjects, questions, ideas, or technical terms (like 'LORA', 'BM25', 'RAG', 'API'). " +
        "Technical acronyms and specific terms ARE valid even if short. " +
        "Examples of VALID: 'LORA', 'BM25', 'machine learning', 'how to cook pasta', 'REST API', 'quantum computing'. " +
        "Examples of INVALID: 'hi there', 'stuff', 'ok', 'test', 'something', 'things', 'idk'. " +
        "When INVALID, provide 3 specific, relevant topic suggestions that expand on or clarify what the user might have intended based on their input. " +
        "Make suggestions related to the user's input context - if they said 'stuff about AI', suggest 'machine learning basics', 'neural networks', 'AI ethics'. " +
        "If they said 'hi there', suggest conversation topics like 'job interview prep', 'public speaking tips', 'networking strategies'. " +
        "Respond with JSON: {\"valid\": true} or {\"valid\": false, \"reason\": \"brief explanation\", \"suggestions\": [\"suggestion1\", \"suggestion2\", \"suggestion3\"]}.",
      input: `Topic: "${topic}"`,
      reasoning: { effort: "none" },
      max_output_tokens: 150,
    });
    try {
      const result = JSON.parse(res.output_text.trim());
      return result as { valid: boolean; reason?: string; suggestions?: string[] };
    } catch (parseErr) {
      // If LLM response can't parse, allow if basic checks passed
      return { valid: true };
    }
  } catch (err) {
    // If LLM fails, allow if basic checks passed
    return { valid: true };
  }
}

function buildSystemPrompt(topic: string): string {
    const basePrompt =
    "You are an experienced, professional mock interviewer conducting a realistic practice interview with a candidate. " +
    "The main focus of the interview is: {TOPIC}. " +
    "Your goal is to assess the candidate the way a real interviewer would and help them improve. " +
    "Ask exactly one question at a time and wait for the answer before moving on. " +
    "Start with a few easy warm-up questions about their background and experience with the topic, then gradually move to deeper technical or conceptual questions, " +
    "practical scenarios, and problem-solving questions. Mix in behavioral questions about past experience, teamwork, and challenges where relevant, " +
    "and cover related areas that an interviewer would likely probe beyond the topic itself. " +
    "Adapt the difficulty to how well they are doing: if they answer confidently, push further with harder follow-ups; if they struggle, simplify or rephrase the question. " +
    "Listen closely to each answer and ask probing follow-ups about vague claims, trade-offs, and the reasoning behind their choices. " +
    "After each answer, give a brief, honest reaction of one short sentence at most, such as acknowledging a strong point or gently noting something missing, and then move to the next question. " +
    "Do not lecture or give long explanations during the interview. If the candidate is stuck, give a small hint rather than the full answer. " +
    "If they ask for feedback or say they want to finish, give a short summary of their strengths and the areas to improve. " +
    "Stay encouraging, calm, and professional, and keep the tone of a real interview rather than a casual chat.";  
  return basePrompt.replace("{TOPIC}", topic);
}

type Avatar = { id: string; name: string; description?: string; voice?: string };

async function getAvatar(avatarId?: string): Promise<Avatar | null> {
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

// ---------- one conversation session (one WebSocket) ----------
async function startSession(ws: WebSocket, systemPrompt: string, avatarId?: string) {
  const sessionId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 6)}`;
  const avatar = await getAvatar(avatarId);
  const avatarName = avatar?.name;

  // Used for LLM calls only; the original systemPrompt is still what gets logged
  const replyPrompt = avatarName
    ? `${systemPrompt}\n\nYour name is ${avatarName}. Always use this name if asked who you are. Never use any other name.`
    : systemPrompt;
  const logFile = path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
  let memory = ""; // Session-specific memory, starts empty for each call
  const recent: Turn[] = [];
  const allTurns: Turn[] = [];
  let muted = false;
  let chain: Promise<void> = Promise.resolve();

  // Save initial session metadata including system prompt and avatar choice
  await appendFile(
    logFile,
    JSON.stringify({ 
      type: "meta", 
      systemPrompt, 
      avatarId: avatarId || "avatar-default",
      createdAt: Date.now() 
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
        // Memory stays in-session only, not persisted globally
      }
    } catch (err) {
      console.error("turn failed:", err);
      send({ type: "error", message: errText(err) });
    }
  };

  // Send initial greeting from interviewer
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

  // Deepgram Flux: 16 kHz mono linear16 PCM in, turn events out
  const dg = await deepgram.listen.v2.connect({
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
  
  // Send greeting after ready
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
        // Save session-specific memory to the session file
        await appendFile(
          logFile,
          JSON.stringify({ type: "memory", memory, ts: Date.now() }) + "\n"
        );
      }
    },
  };
}

// ---------- HTTP: Azure token + recording upload + sessions + pdf ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const text = async (r: NodeJS.ReadableStream): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of r) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  try {
    if (req.method === "GET" && url.pathname === "/api/token") {
      const r = await fetch(
        `https://${AZURE_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": AZURE_KEY,
            "Content-Length": "0",
          },
        },
      );
      if (!r.ok) return json(502, { error: `azure token failed: ${r.status}` });
      return json(200, { token: await r.text(), region: AZURE_REGION });
    }

    // List all available avatars
    if (req.method === "GET" && url.pathname === "/api/avatars") {
      try {
        const avatarPath = path.resolve("public", "avatars.json");
        const avatarData = await readFile(avatarPath, "utf8");
        const avatars = JSON.parse(avatarData);
        return json(200, { avatars });
      } catch (err) {
        return json(500, { error: `Failed to load avatars: ${errText(err)}` });
      }
    }

    // Validate topic and return generated system prompt
    if (req.method === "POST" && url.pathname === "/api/topics/validate") {
      try {
        const body = await text(req);
        const { topic } = JSON.parse(body);
        if (!topic || typeof topic !== "string" || topic.trim().length === 0) {
          return json(400, { error: "Topic is required and must be a non-empty string" });
        }
        const trimmedTopic = topic.trim();
        const validation = await validateTopic(trimmedTopic);
        if (!validation.valid) {
          return json(400, { 
            error: "Invalid topic", 
            reason: validation.reason || "This topic is not suitable for conversation",
            suggestions: validation.suggestions || []
          });
        }
        const systemPrompt = buildSystemPrompt(trimmedTopic);
        return json(200, { valid: true, systemPrompt });
      } catch (err) {
        console.error("topic validation endpoint error:", err);
        return json(500, { error: `Validation failed: ${errText(err)}` });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/recording") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w-]+$/.test(id)) return json(400, { error: "bad id" });
      const file = path.join(RECORDINGS_DIR, `${id}.webm`);
      await pipeline(req, createWriteStream(file, { flags: "a" })); // chunks arrive in order and are appended
      return json(200, { saved: file });
    }

    // List all sessions in reverse chronological order
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const files = await readdir(SESSIONS_DIR);
      const jsonlFiles = files.filter(
        (f) => f.endsWith(".jsonl") && !f.startsWith(".")
      );

      const items = await Promise.all(
        jsonlFiles.map(async (file) => {
          const id = file.replace(/\.jsonl$/, "");
          const filePath = path.join(SESSIONS_DIR, file);
          const pdfPath = path.join(SESSIONS_DIR, `${id}.pdf`);
          const fileStat = await stat(filePath);

          let messageCount = 0;
          let preview = "";
          let systemPrompt = "";
          let summary = "";
          try {
            const content = await readFile(filePath, "utf8");
            const lines = content.trim().split("\n").filter(Boolean);
            for (const line of lines) {
              const record = JSON.parse(line);
              if (record.type === "meta") {
                if (record.systemPrompt) systemPrompt = record.systemPrompt;
              } else if (record.type === "summary") {
                if (record.summary) summary = record.summary;
              } else if (record.role) {
                messageCount++;
                if (!preview && record.content) {
                  preview = record.content;
                }
              }
            }
          } catch {}

          let hasPdf = false;
          try {
            await stat(pdfPath);
            hasPdf = true;
          } catch {}

          return {
            id,
            createdAt: fileStat.birthtimeMs || fileStat.mtimeMs,
            messageCount,
            preview,
            systemPrompt,
            summary,
            hasPdf,
          };
        })
      );

      // Sort reverse chronological
      items.sort((a, b) => b.createdAt - a.createdAt);
      return json(200, { sessions: items });
    }

    // Get specific session details or PDF download
    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      // /api/sessions/:id or /api/sessions/:id/pdf
      const id = parts[2];
      if (!id || !/^[\w-]+$/.test(id)) return json(400, { error: "bad session id" });

      const isPdfReq = parts[3] === "pdf";
      const jsonlPath = path.join(SESSIONS_DIR, `${id}.jsonl`);
      const pdfPath = path.join(SESSIONS_DIR, `${id}.pdf`);

      if (isPdfReq) {
        try {
          const pdfData = await readFile(pdfPath);
          res.writeHead(200, {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${id}.pdf"`,
            "Content-Length": pdfData.length,
          });
          res.end(pdfData);
          return;
        } catch {
          return json(404, { error: "PDF not found on disk" });
        }
      }

      // Return session turns, system prompt & summary
      try {
        const content = await readFile(jsonlPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        const turns: Turn[] = [];
        let systemPrompt = "";
        let summary = "";
        let summaryCount = 0;
        for (const line of lines) {
          const record = JSON.parse(line);
          if (record.type === "meta") {
            if (record.systemPrompt) systemPrompt = record.systemPrompt;
          } else if (record.type === "summary") {
            if (record.summary) summary = record.summary;
            summaryCount++;
          } else if (record.role) {
            turns.push(record as Turn);
          }
        }

        let hasPdf = false;
        try {
          await stat(pdfPath);
          hasPdf = true;
        } catch {}

        // Can regenerate if never summarized (count 0) or summarized once (count 1 -> regenerate once makes it count 2)
        const canRegenerate = summaryCount < 2;

        return json(200, { id, turns, systemPrompt, summary, summaryCount, canRegenerate, hasPdf });
      } catch {
        return json(404, { error: "Session not found" });
      }
    }

    // Handle POST /api/sessions/:id/summarize (generate or re-generate individual session summary, max once per item)
    if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/summarize")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[2];
      if (!id || !/^[\w-]+$/.test(id)) return json(400, { error: "bad session id" });

      const jsonlPath = path.join(SESSIONS_DIR, `${id}.jsonl`);
      let turns: Turn[] = [];
      let summaryCount = 0;
      try {
        const content = await readFile(jsonlPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          if (record.type === "summary") {
            summaryCount++;
          } else if (record.role) {
            turns.push(record as Turn);
          }
        }
      } catch {
        return json(404, { error: "Session not found" });
      }

      if (turns.length === 0) {
        return json(400, { error: "Session has no messages to summarize" });
      }

      // Allow 1 initial generation + 1 regeneration (total max 2 summaries stored)
      if (summaryCount >= 2) {
        return json(403, {
          error: "Summary has already been regenerated once. Regeneration limit reached.",
          canRegenerate: false,
        });
      }

      const summary = await summarizeSession(turns);
      if (summary) {
        await appendFile(
          jsonlPath,
          JSON.stringify({ type: "summary", summary, ts: Date.now() }) + "\n"
        );
        summaryCount++;
      }

      return json(200, {
        success: true,
        summary,
        summaryCount,
        canRegenerate: summaryCount < 2,
      });
    }

    // Handle POST /api/sessions/:id/create-pdf
    if (req.method === "POST" && url.pathname.startsWith("/api/sessions/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[2];
      const isCreatePdf = parts[3] === "create-pdf";
      if (!id || !/^[\w-]+$/.test(id) || !isCreatePdf) {
        return json(400, { error: "bad request" });
      }
      const jsonlPath = path.join(SESSIONS_DIR, `${id}.jsonl`);
      const pdfPath = path.join(SESSIONS_DIR, `${id}.pdf`);

      let turns: Turn[] = [];
      let systemPrompt = "";
      let summary = "";
      try {
        const content = await readFile(jsonlPath, "utf8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const record = JSON.parse(line);
          if (record.type === "meta") {
            if (record.systemPrompt) systemPrompt = record.systemPrompt;
          } else if (record.type === "summary") {
            if (record.summary) summary = record.summary;
          } else if (record.role) {
            turns.push(record as Turn);
          }
        }
      } catch {
        return json(404, { error: "Session not found" });
      }

      await new Promise<void>((resolve, reject) => {
        const doc = new PDFDocument({ margin: 40 });
        const stream = createWriteStream(pdfPath);
        doc.pipe(stream);

        doc.fontSize(20).text("Conversation Transcript", { underline: true });
        doc.fontSize(10).fillColor("#666666").text(`Session ID: ${id}`);
        doc.text(`Generated: ${new Date().toLocaleString()}`);

        if (systemPrompt) {
          doc.moveDown(0.5);
          doc.fontSize(10).fillColor("#4b5563").text(`System Prompt: ${systemPrompt}`, {
            oblique: true,
          });
        }

        if (summary) {
          doc.moveDown(0.5);
          doc.fontSize(11).fillColor("#0f766e").text("Session Summary:", { underline: true });
          doc.fontSize(10).fillColor("#1f2937").text(summary);
        }

        doc.moveDown(1.5);

        for (const turn of turns) {
          const isUser = turn.role === "user";
          const label = isUser ? "User" : "Avatar";
          const roleColor = isUser ? "#1d4ed8" : "#047857";
          const timeStr = turn.ts ? new Date(turn.ts).toLocaleTimeString() : "";

          doc.fontSize(11).fillColor(roleColor).text(`${label} [${timeStr}]:`, {
            continued: false,
          });
          doc.fontSize(10).fillColor("#111827").text(turn.content);
          doc.moveDown(0.8);
        }

        doc.end();
        stream.on("finish", () => resolve());
        stream.on("error", reject);
      });

      return json(200, { success: true, pdfUrl: `/api/sessions/${id}/pdf` });
    }

    json(404, { error: "not found" });
  } catch (err) {
    console.error(err);
    json(500, { error: errText(err) });
  }
});

// ---------- WebSocket: mic audio in, transcript/reply out ----------
// Client -> server: binary = PCM16 audio; JSON = {type:"start", systemPrompt} | {type:"mute", value}
// Server -> client: {type:"ready"|"partial"|"transcript"|"reply"|"error", ...}
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let session: Awaited<ReturnType<typeof startSession>> | null = null;

  ws.on("message", async (data, isBinary) => {
    let msgIsStart = false;
    try {
      if (isBinary) {
        session?.audio(data as Buffer);
        return;
      }
      const msg = JSON.parse(data.toString());
      if (msg.type === "start" && !session) {
        msgIsStart = true;
        session = await startSession(
          ws,
          String(
            msg.systemPrompt ?? "You are a friendly conversation partner.",
          ),
          msg.avatarId,
        );
      } else if (msg.type === "mute") {
        session?.setMuted(Boolean(msg.value));
      }
    } catch (err) {
      console.error(err);
      ws.send(
        JSON.stringify({
          type: "error",
          message: errText(err),
          fatal: msgIsStart,
        }),
      );
    }
  });

  ws.on("close", () => {
    session?.end().catch((err) => console.error("session end failed:", err));
  });
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`server on http://127.0.0.1:${PORT}`),
);
