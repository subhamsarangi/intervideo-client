# InterVideo – Live AI Avatar Conversation App

Talk live with an AI avatar animated from a single photo. Your webcam and the avatar feed display side by side. Sessions record to local video files. Choose any persona via system prompt (interviewer, storyteller, teacher, etc.). Conversation memory persists across sessions.

## Features

- **Live avatar animation** from a single photo using MediaPipe face landmarks
- **Real-time conversation** with AI (speech-to-text → LLM → text-to-speech with viseme sync)
- **Local recording** to WebM format (480p, audio + video mixed)
- **Persistent memory** via JSONL transcripts and rolling summaries
- **No local AI models** – runs on any modern laptop from ~2020+

## Tech Stack

**Backend**: Node.js 26.x + TypeScript  
**Frontend**: Vite + vanilla TypeScript + Canvas 2D  
**STT**: Deepgram Flux  
**LLM**: OpenAI GPT-5.4-nano (Responses API)  
**TTS + Visemes**: Azure Cognitive Services Speech  
**Face Animation**: MediaPipe Face Landmarker

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Set up API keys** in `.env`
   ```
   DEEPGRAM_API_KEY=<your-key>
   OPENAI_API_KEY=<your-key>
   AZURE_SPEECH_KEY=<your-key>
   AZURE_SPEECH_REGION=<region>
   ```

3. **Start the dev server**
   ```bash
   npm run dev
   ```

4. **Open** `http://localhost:5173` in Chrome or Edge

## Cost

~$0.016 per conversation minute (~$0.95/hour). Deepgram new accounts get $200 credit.

## Requirements

- Chrome or Edge (current version)
- 2+ CPU cores, 8GB RAM
- ~0.5–1 GB disk per hour of recording
- API keys for Deepgram, OpenAI, and Azure Speech

## Deployment

See the brief in `/meta/brief.md` for full implementation details, pipeline architecture, and constraints.

---

**Expect ~1–3s turn latency. Use only photos you own or have consent for.**
