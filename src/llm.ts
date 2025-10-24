import OpenAI from "openai";

/**
 * Route to OpenAI if OPENAI_API_KEY is set; otherwise try Ollama at LOCAL_MODEL_URL.
 * Returns a single text string.
 */
export async function generateAnswer(prompt: string): Promise<string> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const client = new OpenAI({ apiKey: openaiKey });
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini", // small & cheap; change as you like
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });
    return res.choices[0]?.message?.content ?? "";
  }

  // Fallback: Ollama (simple /api/generate)
  const base = process.env.LOCAL_MODEL_URL || "http://localhost:11434";
  const body = { model: "llama3.1", prompt, stream: false };
  const resp = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Ollama error: ${resp.status} ${resp.statusText}`);
  const json = await resp.json();
  return json.response || "";
}
