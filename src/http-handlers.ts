import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { validateTopic, buildSystemPrompt } from "./llm-validate";
import { summarizeSession, type Turn } from "./llm";

const SESSIONS_DIR = path.resolve("sessions");
const RECORDINGS_DIR = path.resolve("recordings");
const AZURE_KEY = process.env.AZURE_SPEECH_KEY!;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION!;

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

await mkdir(SESSIONS_DIR, { recursive: true });
await mkdir(RECORDINGS_DIR, { recursive: true });

export async function handleHttpRequest(
  req: any,
  res: any
) {
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
        }
      );
      if (!r.ok) return json(502, { error: `azure token failed: ${r.status}` });
      return json(200, { token: await r.text(), region: AZURE_REGION });
    }

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
            suggestions: validation.suggestions || [],
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
      await pipeline(req, createWriteStream(file, { flags: "a" }));
      return json(200, { saved: file });
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      const files = await readdir(SESSIONS_DIR);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("."));

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

      items.sort((a, b) => b.createdAt - a.createdAt);
      return json(200, { sessions: items });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const parts = url.pathname.split("/").filter(Boolean);
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

        const canRegenerate = summaryCount < 2;

        return json(200, { id, turns, systemPrompt, summary, summaryCount, canRegenerate, hasPdf });
      } catch {
        return json(404, { error: "Session not found" });
      }
    }

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
}
