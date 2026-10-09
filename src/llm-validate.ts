import OpenAI from "openai";

const LLM_MODEL = "gpt-5.4-nano";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function validateTopic(topic: string): Promise<{ valid: boolean; reason?: string; suggestions?: string[] }> {
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

export function buildSystemPrompt(topic: string): string {
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
