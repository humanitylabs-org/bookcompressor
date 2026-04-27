import { NextResponse } from "next/server";
import { callOpenRouter } from "@/lib/openrouter";
import { synthesisPrompt } from "@/lib/prompts";

type SynthesisRequest = {
  apiKey?: string;
  model?: string;
  bookTitle?: string;
  chapterSummaries?: Array<{
    chapterIndex: number;
    chapterTitle: string;
    summary: string;
  }>;
};

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: SynthesisRequest;

  try {
    body = (await request.json()) as SynthesisRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const apiKey = body.apiKey?.trim();
  const model = body.model?.trim() || "openai/gpt-4o-mini";
  const bookTitle = body.bookTitle?.trim() || "Untitled Book";
  const chapterSummaries = Array.isArray(body.chapterSummaries)
    ? body.chapterSummaries.filter((item) => item?.summary && item?.chapterTitle)
    : [];

  if (!apiKey) {
    return NextResponse.json({ error: "OpenRouter API key is required." }, { status: 400 });
  }

  if (chapterSummaries.length === 0) {
    return NextResponse.json({ error: "chapterSummaries is required." }, { status: 400 });
  }

  try {
    const synthesis = await callOpenRouter({
      apiKey,
      model,
      messages: synthesisPrompt({
        bookTitle,
        chapterSummaries,
      }),
      temperature: 0.35,
      maxTokens: 1800,
    });

    return NextResponse.json({
      bookTitle,
      finalSynthesis: synthesis.text,
      usage: synthesis.usage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Book synthesis failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
