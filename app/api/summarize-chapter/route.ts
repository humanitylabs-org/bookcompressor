import { NextResponse } from "next/server";
import { callInference } from "@/lib/inference";
import {
  buildChapterMessages,
  DetailLevel,
  mergePromptConfig,
  PromptConfig,
} from "@/lib/prompts";

const MAX_CHAPTER_CHARS = 120_000;

type SummarizeRequest = {
  model?: string;
  chapterTitle?: string;
  chapterText?: string;
  chapterIndex?: number;
  totalChapters?: number;
  detailLevel?: DetailLevel;
  promptConfig?: Partial<PromptConfig>;
};

function normalizeDetailLevel(level: string | undefined): DetailLevel {
  if (level === "tight" || level === "balanced" || level === "deep") {
    return level;
  }
  return "balanced";
}

function sanitizeModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 160);
}

function maxTokensFor(level: DetailLevel): number {
  if (level === "tight") return 2400;
  if (level === "deep") return 6000;
  return 4000;
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: SummarizeRequest;

  try {
    body = (await request.json()) as SummarizeRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const model = sanitizeModel(body.model);
  const chapterTitle = body.chapterTitle?.trim() || "Untitled Chapter";
  const chapterIndex = Number(body.chapterIndex || 1);
  const totalChapters = Number(body.totalChapters || 1);
  const detailLevel = normalizeDetailLevel(body.detailLevel);
  const promptConfig = mergePromptConfig(body.promptConfig);

  if (!body.chapterText || typeof body.chapterText !== "string") {
    return NextResponse.json({ error: "chapterText is required." }, { status: 400 });
  }

  const originalChars = body.chapterText.length;
  const chapterText = body.chapterText.slice(0, MAX_CHAPTER_CHARS);
  const wasTruncated = originalChars > MAX_CHAPTER_CHARS;

  try {
    const result = await callInference({
      model,
      messages: buildChapterMessages({
        config: promptConfig,
        chapterTitle,
        chapterText,
        chapterIndex,
        totalChapters,
        detailLevel,
      }),
      temperature: 0.4,
      maxTokens: maxTokensFor(detailLevel),
    });

    return NextResponse.json({
      chapterTitle,
      chapterIndex,
      detailLevel,
      truncated: wasTruncated,
      originalChars,
      processedChars: chapterText.length,
      finalSummary: result.text,
      modelUsed: result.modelUsed || model || "host default",
      providerUsed: result.provider,
      usage: result.usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Summarization failed.";
    return NextResponse.json(
      {
        error: message,
      },
      { status: 500 },
    );
  }
}
