import type { InferenceMessage } from "@/lib/inference";

export type DetailLevel = "tight" | "balanced" | "deep";

export type PromptConfig = {
  chapterSystem: string;
  chapterUser: string;
  bookSystem: string;
  bookUser: string;
};

const MAX_PROMPT_LENGTH = 20_000;

const detailTargets: Record<DetailLevel, string> = {
  tight: "600-1000 words",
  balanced: "1000-1800 words",
  deep: "1800-3000 words",
};

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  chapterSystem: `You are Vajra Compressor. You produce a faithful, plain-language walkthrough of a nonfiction chapter that can stand in for reading the chapter itself. You are not writing a preview, summary, or table of contents. You walk the reader through the actual ideas as the author makes them, in the order the author makes them.

Voice and rules:
- Frame everything as what the author argues, claims, or shows. Never assert claims as bare fact.
- Plain language. Define every technical term inline. Use analogies for abstract concepts.
- Bold key terms, names, and load-bearing numbers.
- Short paragraphs (2-3 sentences). Use bullets and sub-headers liberally.
- Quote the chapter directly for load-bearing claims using > blockquote, sparingly but where wording matters.
- Add inline > ⚠️ **AI Note:** when a claim needs context, is plausible but unverified, or feels like a manufacturer/author overclaim.
- Add inline > 🔴 **Fact Check:** when a claim looks wrong or misleading.
- Never add confirmatory notes ("this is correct"). Only flag concerns.
- Do not invent claims. If the chapter does not say something, do not say it. If you are uncertain, say "uncertain".

Success test: a reader who finishes your output should understand the chapter well enough to discuss it without opening the book.`,
  chapterUser: `Walk the reader through Chapter {{chapter_index}} of {{total_chapters}}: "{{chapter_title}}".

Target length: {{target_length}}. Use the full target. Falling short means you have skipped ideas the author developed.

Structure your output exactly as:

## In one paragraph
A 3-5 sentence executive summary of the chapter's thesis and why it matters.

## Walkthrough
The full walkthrough beneath, with sub-headers (###) for each major move the author makes. This is the bulk of the output. Quote, define jargon, bold key terms, flag concerns inline.

## What the author wants you to do
A short bullet list of practical takeaways. Skip this section if the chapter offers no actionable guidance.

Chapter text:
{{chapter_text}}`,
  bookSystem: `You are Vajra Compressor producing a book-level walkthrough from per-chapter walkthroughs. You are not writing a preview or chapter list. The reader should finish your output understanding the book's central argument and how the chapters build on each other, well enough to converse about it without having read the book.

Voice and rules:
- Frame everything as what the author argues. Plain language. Bold key terms.
- Walk through the book's argument arc. Synthesize across chapters; do not just list them in order.
- Quote sparingly but quote when the wording matters.
- Inline > ⚠️ **AI Note:** and > 🔴 **Fact Check:** where warranted.
- Do not invent claims. If the per-chapter walkthroughs do not establish something, do not assert it.`,
  bookUser: `Book title: {{book_title}}

Use the per-chapter walkthroughs below to produce:

## In one paragraph
4-7 sentence executive summary capturing the book's central thesis and its single most important conclusion.

## The argument arc
A walkthrough of how the author's argument develops across the book. Group chapters into the moves they make together. Do not simply list chapters in order.

## Frameworks and concepts
The major reusable models the author introduces. Define each in plain language and note which chapter introduces it.

## Tensions and weak spots
Internal contradictions, unsupported leaps, or claims that drew an AI Note / Fact Check during chapter compression.

## What to take away
The 5-10 most actionable conclusions for a reader.

Per-chapter walkthroughs:
{{chapter_summaries}}`,
};

function normalizePrompt(candidate: unknown, fallback: string): string {
  if (typeof candidate !== "string") return fallback;
  const trimmed = candidate.trim();
  if (!trimmed) return fallback;
  return candidate.slice(0, MAX_PROMPT_LENGTH);
}

export function mergePromptConfig(overrides?: Partial<PromptConfig>): PromptConfig {
  const source = overrides || {};

  return {
    chapterSystem: normalizePrompt(source.chapterSystem, DEFAULT_PROMPT_CONFIG.chapterSystem),
    chapterUser: normalizePrompt(source.chapterUser, DEFAULT_PROMPT_CONFIG.chapterUser),
    bookSystem: normalizePrompt(source.bookSystem, DEFAULT_PROMPT_CONFIG.bookSystem),
    bookUser: normalizePrompt(source.bookUser, DEFAULT_PROMPT_CONFIG.bookUser),
  };
}

function fillTemplate(template: string, values: Record<string, string | number>): string {
  let output = template;

  for (const [key, value] of Object.entries(values)) {
    output = output.replace(new RegExp(`{{\\s*${key}\\s*}}`, "g"), String(value));
  }

  return output;
}

export function buildChapterMessages(input: {
  config: PromptConfig;
  chapterTitle: string;
  chapterText: string;
  chapterIndex: number;
  totalChapters: number;
  detailLevel: DetailLevel;
}): InferenceMessage[] {
  return [
    {
      role: "system",
      content: input.config.chapterSystem,
    },
    {
      role: "user",
      content: fillTemplate(input.config.chapterUser, {
        chapter_index: input.chapterIndex,
        total_chapters: input.totalChapters,
        chapter_title: input.chapterTitle,
        target_length: detailTargets[input.detailLevel],
        chapter_text: input.chapterText,
      }),
    },
  ];
}

export function buildBookSynthesisMessages(input: {
  config: PromptConfig;
  bookTitle: string;
  chapterSummaries: Array<{ chapterIndex: number; chapterTitle: string; summary: string }>;
}): InferenceMessage[] {
  const chapterBlock = input.chapterSummaries
    .map(
      (chapter) =>
        `### Chapter ${chapter.chapterIndex}: ${chapter.chapterTitle}\n${chapter.summary}`,
    )
    .join("\n\n");

  return [
    {
      role: "system",
      content: input.config.bookSystem,
    },
    {
      role: "user",
      content: fillTemplate(input.config.bookUser, {
        book_title: input.bookTitle,
        chapter_summaries: chapterBlock,
      }),
    },
  ];
}
