import { NextResponse } from "next/server";
import { callInference } from "@/lib/inference";
import { buildBookSynthesisMessages, mergePromptConfig, PromptConfig } from "@/lib/prompts";

type SynthesisRequest = {
  model?: string;
  bookTitle?: string;
  chapterSummaries?: Array<{
    chapterIndex: number;
    chapterTitle: string;
    summary: string;
  }>;
  promptConfig?: Partial<PromptConfig>;
};

function sanitizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 160);
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: SynthesisRequest;

  try {
    body = (await request.json()) as SynthesisRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const synthesisModel = sanitizeModel(body.model);
  const bookTitle = body.bookTitle?.trim() || "Untitled Book";
  const chapterSummaries = Array.isArray(body.chapterSummaries)
    ? body.chapterSummaries.filter((item) => item?.summary && item?.chapterTitle)
    : [];
  const promptConfig = mergePromptConfig(body.promptConfig);

  if (chapterSummaries.length === 0) {
    return NextResponse.json({ error: "chapterSummaries is required." }, { status: 400 });
  }

  try {
    const synthesis = await callInference({
      model: synthesisModel,
      messages: buildBookSynthesisMessages({
        config: promptConfig,
        bookTitle,
        chapterSummaries,
      }),
      temperature: 0.4,
      maxTokens: 6000,
    });

    return NextResponse.json({
      bookTitle,
      modelUsed: synthesis.modelUsed || synthesisModel || "host default",
      providerUsed: synthesis.provider,
      finalSynthesis: synthesis.text,
      usage: synthesis.usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Book synthesis failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
