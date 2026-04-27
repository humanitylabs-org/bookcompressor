import { NextResponse } from "next/server";
import { callOpenRouter } from "@/lib/openrouter";
import { buildBookSynthesisMessages, mergePromptConfig, PromptConfig } from "@/lib/prompts";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

type ModelRouting = {
  passOneModel?: string;
  passTwoModel?: string;
  passThreeModel?: string;
  synthesisModel?: string;
};

type SynthesisRequest = {
  apiKey?: string;
  model?: string;
  bookTitle?: string;
  chapterSummaries?: Array<{
    chapterIndex: number;
    chapterTitle: string;
    summary: string;
  }>;
  promptConfig?: Partial<PromptConfig>;
  modelRouting?: Partial<ModelRouting>;
};

function sanitizeModel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 120);
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: SynthesisRequest;

  try {
    body = (await request.json()) as SynthesisRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const apiKey = body.apiKey?.trim();
  const baseModel = sanitizeModel(body.model, DEFAULT_MODEL);
  const synthesisModel = sanitizeModel(body.modelRouting?.synthesisModel, baseModel);
  const bookTitle = body.bookTitle?.trim() || "Untitled Book";
  const chapterSummaries = Array.isArray(body.chapterSummaries)
    ? body.chapterSummaries.filter((item) => item?.summary && item?.chapterTitle)
    : [];
  const promptConfig = mergePromptConfig(body.promptConfig);

  if (!apiKey) {
    return NextResponse.json({ error: "OpenRouter API key is required." }, { status: 400 });
  }

  if (chapterSummaries.length === 0) {
    return NextResponse.json({ error: "chapterSummaries is required." }, { status: 400 });
  }

  try {
    const synthesis = await callOpenRouter({
      apiKey,
      model: synthesisModel,
      messages: buildBookSynthesisMessages({
        config: promptConfig,
        bookTitle,
        chapterSummaries,
      }),
      temperature: 0.35,
      maxTokens: 1900,
    });

    return NextResponse.json({
      bookTitle,
      modelUsed: synthesisModel,
      finalSynthesis: synthesis.text,
      usage: synthesis.usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Book synthesis failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
