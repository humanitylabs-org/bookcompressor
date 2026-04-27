export type DetailLevel = "tight" | "balanced" | "deep";

const detailTargets: Record<DetailLevel, string> = {
  tight: "180-260 words",
  balanced: "260-420 words",
  deep: "420-700 words",
};

export function passOnePrompt(input: {
  chapterTitle: string;
  chapterText: string;
  chapterIndex: number;
  totalChapters: number;
  detailLevel: DetailLevel;
}) {
  return [
    {
      role: "system" as const,
      content:
        "You are a precise nonfiction chapter compressor. Keep fidelity high. Do not invent claims. If uncertain, say uncertain.",
    },
    {
      role: "user" as const,
      content: `Compress Chapter ${input.chapterIndex} of ${input.totalChapters}.
Title: ${input.chapterTitle}
Target length: ${detailTargets[input.detailLevel]}

Return exactly these sections with markdown headings:
## Core Thesis
## Structural Outline
## Key Ideas
## Notable Evidence / Examples
## Actionable Takeaways
## Open Questions or Weak Spots

Chapter text:
${input.chapterText}`,
    },
  ];
}

export function passTwoPrompt(input: {
  chapterTitle: string;
  chapterText: string;
  passOneOutput: string;
}) {
  return [
    {
      role: "system" as const,
      content:
        "You are a strict quality auditor. Your job is to find misses, overclaims, and distortion. Be concrete and terse.",
    },
    {
      role: "user" as const,
      content: `Audit this chapter summary for completeness and faithfulness.

Chapter title: ${input.chapterTitle}

Draft summary:
${input.passOneOutput}

Chapter text for verification:
${input.chapterText}

Return exactly these sections:
## Missing Important Points
## Potential Distortions or Overclaims
## Nuance That Should Be Added
## Compression Quality Score (1-10)
## Revision Guidance`,
    },
  ];
}

export function passThreePrompt(input: {
  chapterTitle: string;
  passOneOutput: string;
  passTwoOutput: string;
  detailLevel: DetailLevel;
}) {
  return [
    {
      role: "system" as const,
      content:
        "You are a synthesis editor. Produce a final chapter compression by integrating draft + critique. Keep it clear, faithful, and readable.",
    },
    {
      role: "user" as const,
      content: `Create the final chapter compression for \"${input.chapterTitle}\".
Target length: ${detailTargets[input.detailLevel]}

Draft summary:
${input.passOneOutput}

Audit critique:
${input.passTwoOutput}

Return exactly these sections:
## Chapter Compression
## Key Insights (Bullet List)
## Practical Applications
## What To Revisit In Full Text
## Confidence Notes`,
    },
  ];
}

export function synthesisPrompt(input: {
  bookTitle: string;
  chapterSummaries: Array<{ chapterIndex: number; chapterTitle: string; summary: string }>;
}) {
  const chapterBlock = input.chapterSummaries
    .map(
      (chapter) =>
        `### Chapter ${chapter.chapterIndex}: ${chapter.chapterTitle}\n${chapter.summary}`,
    )
    .join("\n\n");

  return [
    {
      role: "system" as const,
      content:
        "You are a book-level synthesis writer. Build a coherent compression of the full book from chapter summaries only.",
    },
    {
      role: "user" as const,
      content: `Book title: ${input.bookTitle}

Use the chapter summaries below and produce:
## Book Compression
## Throughline Across Chapters
## Major Frameworks / Models
## Contradictions or Tensions
## Best Action Steps (Top 10)
## One-Page Executive Abstract

Chapter summaries:
${chapterBlock}`,
    },
  ];
}
