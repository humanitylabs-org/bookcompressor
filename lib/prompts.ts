import type { OpenRouterMessage } from "@/lib/openrouter";

export type DetailLevel = "tight" | "balanced" | "deep";

export type PromptConfig = {
  passOneSystem: string;
  passOneUser: string;
  passTwoSystem: string;
  passTwoUser: string;
  passThreeSystem: string;
  passThreeUser: string;
  bookSystem: string;
  bookUser: string;
};

const MAX_PROMPT_LENGTH = 20_000;

const detailTargets: Record<DetailLevel, string> = {
  tight: "180-260 words",
  balanced: "260-420 words",
  deep: "420-700 words",
};

export const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  passOneSystem:
    "You are a precise nonfiction chapter compressor. Keep fidelity high. Do not invent claims. If uncertain, say uncertain.",
  passOneUser: `Compress Chapter {{chapter_index}} of {{total_chapters}}.
Title: {{chapter_title}}
Target length: {{target_length}}

Return exactly these sections with markdown headings:
## Core Thesis
## Structural Outline
## Key Ideas
## Notable Evidence / Examples
## Actionable Takeaways
## Open Questions or Weak Spots

Chapter text:
{{chapter_text}}`,
  passTwoSystem:
    "You are a strict quality auditor. Your job is to find misses, overclaims, and distortion. Be concrete and terse.",
  passTwoUser: `Audit this chapter summary for completeness and faithfulness.

Chapter title: {{chapter_title}}

Draft summary:
{{pass_one_output}}

Chapter text for verification:
{{chapter_text}}

Return exactly these sections:
## Missing Important Points
## Potential Distortions or Overclaims
## Nuance That Should Be Added
## Compression Quality Score (1-10)
## Revision Guidance`,
  passThreeSystem:
    "You are a synthesis editor. Produce a final chapter compression by integrating draft + critique. Keep it clear, faithful, and readable.",
  passThreeUser: `Create the final chapter compression for "{{chapter_title}}".
Target length: {{target_length}}

Draft summary:
{{pass_one_output}}

Audit critique:
{{pass_two_output}}

Return exactly these sections:
## Chapter Compression
## Key Insights (Bullet List)
## Practical Applications
## What To Revisit In Full Text
## Confidence Notes`,
  bookSystem:
    "You are a book-level synthesis writer. Build a coherent compression of the full book from chapter summaries only.",
  bookUser: `Book title: {{book_title}}

Use the chapter summaries below and produce:
## Book Compression
## Throughline Across Chapters
## Major Frameworks / Models
## Contradictions or Tensions
## Best Action Steps (Top 10)
## One-Page Executive Abstract

Chapter summaries:
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
    passOneSystem: normalizePrompt(source.passOneSystem, DEFAULT_PROMPT_CONFIG.passOneSystem),
    passOneUser: normalizePrompt(source.passOneUser, DEFAULT_PROMPT_CONFIG.passOneUser),
    passTwoSystem: normalizePrompt(source.passTwoSystem, DEFAULT_PROMPT_CONFIG.passTwoSystem),
    passTwoUser: normalizePrompt(source.passTwoUser, DEFAULT_PROMPT_CONFIG.passTwoUser),
    passThreeSystem: normalizePrompt(source.passThreeSystem, DEFAULT_PROMPT_CONFIG.passThreeSystem),
    passThreeUser: normalizePrompt(source.passThreeUser, DEFAULT_PROMPT_CONFIG.passThreeUser),
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

export function buildPassOneMessages(input: {
  config: PromptConfig;
  chapterTitle: string;
  chapterText: string;
  chapterIndex: number;
  totalChapters: number;
  detailLevel: DetailLevel;
}): OpenRouterMessage[] {
  return [
    {
      role: "system",
      content: input.config.passOneSystem,
    },
    {
      role: "user",
      content: fillTemplate(input.config.passOneUser, {
        chapter_index: input.chapterIndex,
        total_chapters: input.totalChapters,
        chapter_title: input.chapterTitle,
        target_length: detailTargets[input.detailLevel],
        chapter_text: input.chapterText,
      }),
    },
  ];
}

export function buildPassTwoMessages(input: {
  config: PromptConfig;
  chapterTitle: string;
  chapterText: string;
  passOneOutput: string;
}): OpenRouterMessage[] {
  return [
    {
      role: "system",
      content: input.config.passTwoSystem,
    },
    {
      role: "user",
      content: fillTemplate(input.config.passTwoUser, {
        chapter_title: input.chapterTitle,
        chapter_text: input.chapterText,
        pass_one_output: input.passOneOutput,
      }),
    },
  ];
}

export function buildPassThreeMessages(input: {
  config: PromptConfig;
  chapterTitle: string;
  passOneOutput: string;
  passTwoOutput: string;
  detailLevel: DetailLevel;
}): OpenRouterMessage[] {
  return [
    {
      role: "system",
      content: input.config.passThreeSystem,
    },
    {
      role: "user",
      content: fillTemplate(input.config.passThreeUser, {
        chapter_title: input.chapterTitle,
        target_length: detailTargets[input.detailLevel],
        pass_one_output: input.passOneOutput,
        pass_two_output: input.passTwoOutput,
      }),
    },
  ];
}

export function buildBookSynthesisMessages(input: {
  config: PromptConfig;
  bookTitle: string;
  chapterSummaries: Array<{ chapterIndex: number; chapterTitle: string; summary: string }>;
}): OpenRouterMessage[] {
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
