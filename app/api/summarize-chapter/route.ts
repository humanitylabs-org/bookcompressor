import { NextResponse } from "next/server";
import { callOpenRouter } from "@/lib/openrouter";
import {
  buildPassOneMessages,
  buildPassThreeMessages,
  buildPassTwoMessages,
  DetailLevel,
  mergePromptConfig,
  PromptConfig,
} from "@/lib/prompts";

const MAX_CHAPTER_CHARS = 120_000;
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

type ModelRouting = {
  passOneModel?: string;
  passTwoModel?: string;
  passThreeModel?: string;
  synthesisModel?: string;
};

type SummarizeRequest = {
  apiKey?: string;
  model?: string;
  chapterTitle?: string;
  chapterText?: string;
  chapterIndex?: number;
  totalChapters?: number;
  detailLevel?: DetailLevel;
  passCount?: number;
  promptConfig?: Partial<PromptConfig>;
  modelRouting?: Partial<ModelRouting>;
};

function normalizeDetailLevel(level: string | undefined): DetailLevel {
  if (level === "tight" || level === "balanced" || level === "deep") {
    return level;
  }
  return "balanced";
}

function normalizePassCount(value: unknown): 1 | 2 | 3 {
  if (value === 2 || value === 3) return value;
  return 1;
}

function sanitizeModel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 120);
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
  const baseModel = sanitizeModel(body.model, DEFAULT_MODEL);
  const chapterTitle = body.chapterTitle?.trim() || "Untitled Chapter";
  const chapterIndex = Number(body.chapterIndex || 1);
  const totalChapters = Number(body.totalChapters || 1);
  const detailLevel = normalizeDetailLevel(body.detailLevel);
  const passCount = normalizePassCount(body.passCount);
  const promptConfig = mergePromptConfig(body.promptConfig);

  const routing = body.modelRouting || {};
  const passOneModel = sanitizeModel(routing.passOneModel, baseModel);
  const passTwoModel = sanitizeModel(routing.passTwoModel, baseModel);
  const passThreeModel = sanitizeModel(routing.passThreeModel, baseModel);

  if (!apiKey) {
    return NextResponse.json({ error: "OpenRouter API key is required." }, { status: 400 });
  }

  if (!body.chapterText || typeof body.chapterText !== "string") {
    return NextResponse.json({ error: "chapterText is required." }, { status: 400 });
  }

  const originalChars = body.chapterText.length;
  const chapterText = body.chapterText.slice(0, MAX_CHAPTER_CHARS);
  const wasTruncated = originalChars > MAX_CHAPTER_CHARS;

  try {
    const passOne = await callOpenRouter({
      apiKey,
      model: passOneModel,
      messages: buildPassOneMessages({
        config: promptConfig,
        chapterTitle,
        chapterText,
        chapterIndex,
        totalChapters,
        detailLevel,
      }),
      temperature: 0.35,
      maxTokens: 1200,
    });

    let passTwoText: string | null = null;
    let passThreeText: string | null = null;
    let usageTwo: unknown = undefined;
    let usageThree: unknown = undefined;

    if (passCount >= 2) {
      const passTwo = await callOpenRouter({
        apiKey,
        model: passTwoModel,
        messages: buildPassTwoMessages({
          config: promptConfig,
          chapterTitle,
          chapterText,
          passOneOutput: passOne.text,
        }),
        temperature: 0.2,
        maxTokens: 950,
      });

      passTwoText = passTwo.text;
      usageTwo = passTwo.usage;

      if (passCount === 3) {
        const passThree = await callOpenRouter({
          apiKey,
          model: passThreeModel,
          messages: buildPassThreeMessages({
            config: promptConfig,
            chapterTitle,
            passOneOutput: passOne.text,
            passTwoOutput: passTwo.text,
            detailLevel,
          }),
          temperature: 0.3,
          maxTokens: 1300,
        });

        passThreeText = passThree.text;
        usageThree = passThree.usage;
      }
    }

    const finalSummary = passCount === 1 ? passOne.text : passCount === 2 ? passTwoText || passOne.text : passThreeText || passTwoText || passOne.text;

    return NextResponse.json({
      chapterTitle,
      chapterIndex,
      detailLevel,
      passCount,
      truncated: wasTruncated,
      originalChars,
      processedChars: chapterText.length,
      passOne: passOne.text,
      passTwo: passTwoText,
      passThree: passThreeText,
      finalSummary,
      modelsUsed: {
        passOneModel,
        passTwoModel: passCount >= 2 ? passTwoModel : null,
        passThreeModel: passCount === 3 ? passThreeModel : null,
      },
      usage: {
        passOne: passOne.usage,
        passTwo: usageTwo,
        passThree: usageThree,
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
