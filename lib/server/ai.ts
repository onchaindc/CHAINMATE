/**
 * Optional LLM-enhanced commentary / summary via any OpenAI-compatible API.
 * Only active when AI_API_KEY is configured; the UI falls back to the
 * built-in rule-based engine otherwise.
 */

const AI_BASE_URL = process.env.AI_BASE_URL ?? "https://api.openai.com/v1";
const AI_MODEL = process.env.AI_MODEL ?? "gpt-4o-mini";

export function aiConfigured(): boolean {
  return Boolean(process.env.AI_API_KEY);
}

export async function runAi(prompt: string): Promise<string> {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    throw new Error("AI_API_KEY is not configured");
  }

  const res = await fetch(`${AI_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.7,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "You are ChainMate, a chess commentator for a GenLayer-powered chess dApp. " +
            "You write vivid, accurate, concise analysis in the style of a chess broadcast. " +
            "Reply with plain text only.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI request failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("AI returned an empty response");
  }
  return text;
}
