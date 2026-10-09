import OpenAI from "openai";

const LLM_MODEL = "gpt-5.4-nano";
const VOICE_RULES =
  "You are speaking aloud in a live video call. Reply in 1-3 short, natural spoken sentences. " +
  "No markdown, lists, emojis or stage directions.";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export type Turn = { role: "user" | "assistant"; content: string; ts: number };

export async function generateReply(
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

export async function summarize(oldNotes: string, turns: Turn[]): Promise<string> {
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

export async function summarizeSession(turns: Turn[]): Promise<string> {
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
