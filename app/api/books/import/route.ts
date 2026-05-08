import { NextResponse } from "next/server";
import { createBook } from "@/lib/book-store";

type ImportableChapter = {
  chapterIndex?: number;
  chapterTitle?: string;
  summary?: string;
  finalSummary?: string;
  truncated?: boolean;
  originalChars?: number;
  processedChars?: number;
};

type ImportableBook = {
  bookTitle?: string;
  detectionMethod?: string | null;
  source?: string;
  settings?: {
    chapterModel?: string;
    synthesisModel?: string;
    detailLevel?: string;
    maxChapters?: string;
  };
  chapters?: ImportableChapter[];
  synthesis?: string | null;
};

function maybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeBook(raw: unknown): ImportableBook | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;

  if (!Array.isArray(candidate.chapters)) return null;

  const chapters = candidate.chapters
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") return null;
      const chapter = entry as Record<string, unknown>;

      const chapterTitle = typeof chapter.chapterTitle === "string" ? chapter.chapterTitle : "";
      const summaryValue =
        typeof chapter.summary === "string"
          ? chapter.summary
          : typeof chapter.finalSummary === "string"
            ? chapter.finalSummary
            : "";

      if (!chapterTitle.trim() || !summaryValue.trim()) return null;

      return {
        chapterIndex:
          typeof chapter.chapterIndex === "number" && Number.isFinite(chapter.chapterIndex)
            ? chapter.chapterIndex
            : index + 1,
        chapterTitle,
        summary: summaryValue,
        truncated: Boolean(chapter.truncated),
        originalChars: maybeNumber(chapter.originalChars),
        processedChars: maybeNumber(chapter.processedChars),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (!chapters.length) return null;

  const settings =
    candidate.settings && typeof candidate.settings === "object"
      ? (candidate.settings as ImportableBook["settings"])
      : undefined;

  return {
    bookTitle: typeof candidate.bookTitle === "string" ? candidate.bookTitle : "Untitled Book",
    detectionMethod:
      typeof candidate.detectionMethod === "string" || candidate.detectionMethod === null
        ? candidate.detectionMethod
        : null,
    source: typeof candidate.source === "string" ? candidate.source : "library-import",
    settings,
    chapters,
    synthesis: typeof candidate.synthesis === "string" ? candidate.synthesis : null,
  };
}

function extractBooksFromPayload(payload: unknown): ImportableBook[] {
  if (!payload || typeof payload !== "object") return [];
  const body = payload as Record<string, unknown>;

  const booksCandidate =
    Array.isArray(body.books) ? body.books : Array.isArray(body.book) ? body.book : null;

  if (booksCandidate) {
    return booksCandidate
      .map((entry) => normalizeBook(entry))
      .filter((entry): entry is ImportableBook => entry !== null);
  }

  if (body.book && typeof body.book === "object") {
    const one = normalizeBook(body.book);
    return one ? [one] : [];
  }

  const root = normalizeBook(body);
  return root ? [root] : [];
}

export const runtime = "nodejs";

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const books = extractBooksFromPayload(payload);
  if (!books.length) {
    return NextResponse.json(
      {
        error:
          "No valid books found. Expected a single book export or a library export with books[].",
      },
      { status: 400 },
    );
  }

  try {
    const created = [] as string[];
    for (const book of books) {
      const saved = await createBook({
        bookTitle: book.bookTitle || "Untitled Book",
        detectionMethod: book.detectionMethod || null,
        source: book.source || "library-import",
        settings: book.settings || {},
        chapters: (book.chapters || []).map((chapter, index) => ({
          chapterIndex:
            typeof chapter.chapterIndex === "number" && Number.isFinite(chapter.chapterIndex)
              ? chapter.chapterIndex
              : index + 1,
          chapterTitle: chapter.chapterTitle || `Chapter ${index + 1}`,
          summary: chapter.summary || chapter.finalSummary || "",
          truncated: Boolean(chapter.truncated),
          originalChars: maybeNumber(chapter.originalChars),
          processedChars: maybeNumber(chapter.processedChars),
        })),
        synthesis: book.synthesis || null,
      });

      created.push(saved.id);
    }

    return NextResponse.json({ imported: created.length, ids: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to import books.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
