import { NextResponse } from "next/server";
import { callOpenRouter } from "@/lib/openrouter";
import {
  DetailLevel,
  passOnePrompt,
  passTwoPrompt,
  passThreePrompt,
} from "@/lib/prompts";

const MAX_CHAPTER_CHARS = 120_000;

type SummarizeRequest = {
  apiKey?: string;
  model?: string;
  chapterTitle?: string;
  chapterText?: string;
  chapterIndex?: number;
  totalChapters?: number;
  detailLevel?: DetailLevel;
};

function normalizeDetailLevel(level: string | undefined): DetailLevel {
  if (level === "tight" || level === "balanced" || level === "deep") {
    return level;
  }
  return "balanced";
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: SummarizeRequest;

  try {
    body = (await request.json()) as SummarizeRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const apiKey = body.apiKey?.trim();
  const model = body.model?.trim() || "openai/gpt-4o-mini";
  const chapterTitle = body.chapterTitle?.trim() || "Untitled Chapter";
  const chapterIndex = Number(body.chapterIndex || 1);
  const totalChapters = Number(body.totalChapters || 1);
  const detailLevel = normalizeDetailLevel(body.detailLevel);

  if (!apiKey) {
    return NextResponse.json({ error: "OpenRouter API key is required." }, { status: 400 });
  }

  if (!body.chapterText || typeof body.chapterText !== "string") {
    return NextResponse.json({ error: "chapterText is required." }, { status: 400 });
  }

  if (model.length > 120) {
    return NextResponse.json({ error: "Model value is too long." }, { status: 400 });
  }

  const originalChars = body.chapterText.length;
  const chapterText = body.chapterText.slice(0, MAX_CHAPTER_CHARS);
  const wasTruncated = originalChars > MAX_CHAPTER_CHARS;

  try {
    const passOne = await callOpenRouter({
      apiKey,
      model,
      messages: passOnePrompt({
        chapterTitle,
        chapterText,
        chapterIndex,
        totalChapters,
        detailLevel,
      }),
      temperature: 0.35,
      maxTokens: 1200,
    });

    const passTwo = await callOpenRouter({
      apiKey,
      model,
      messages: passTwoPrompt({
        chapterTitle,
        chapterText,
        passOneOutput: passOne.text,
      }),
      temperature: 0.2,
      maxTokens: 850,
    });

    const passThree = await callOpenRouter({
      apiKey,
      model,
      messages: passThreePrompt({
        chapterTitle,
        passOneOutput: passOne.text,
        passTwoOutput: passTwo.text,
        detailLevel,
      }),
      temperature: 0.3,
      maxTokens: 1300,
    });

    return NextResponse.json({
      chapterTitle,
      chapterIndex,
      detailLevel,
      truncated: wasTruncated,
      originalChars,
      processedChars: chapterText.length,
      passOne: passOne.text,
      passTwo: passTwo.text,
      finalSummary: passThree.text,
      usage: {
        passOne: passOne.usage,
        passTwo: passTwo.usage,
        passThree: passThree.usage,
      },
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
