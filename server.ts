import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { startSession } from "./src/interview-session";
import { handleHttpRequest } from "./src/http-handlers";

const PORT = Number(process.env.PORT ?? 3001);

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

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return String(e);
}

const server = createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    console.error("HTTP handler error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: errText(err) }));
  });
});

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
          String(msg.systemPrompt ?? "You are a friendly conversation partner."),
          msg.avatarId
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
        })
      );
    }
  });

  ws.on("close", () => {
    session?.end().catch((err) => console.error("session end failed:", err));
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`server on http://127.0.0.1:${PORT}`)
);
