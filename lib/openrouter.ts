export type OpenRouterMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OpenRouterCallOptions = {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type OpenRouterResult = {
  text: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export async function callOpenRouter({
  apiKey,
  model,
  messages,
  temperature = 0.4,
  maxTokens = 1100,
}: OpenRouterCallOptions): Promise<OpenRouterResult> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://book-compressor.vercel.app",
      "X-Title": "Book Compressor",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      provider: {
        data_collection: "deny",
        zdr: true,
      },
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const errorMessage =
      data?.error?.message ||
      data?.message ||
      `OpenRouter request failed with status ${res.status}`;
    throw new Error(errorMessage);
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== "string") {
    throw new Error("OpenRouter returned an empty response.");
  }

  return {
    text,
    usage: data?.usage,
  };
}
