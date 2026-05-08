import { NextResponse } from "next/server";
import { clearAllBooks, createBook, listBooks } from "@/lib/book-store";

type CreateBookBody = {
  bookTitle?: string;
  detectionMethod?: string | null;
  source?: string;
  settings?: {
    chapterModel?: string;
    synthesisModel?: string;
    detailLevel?: string;
    maxChapters?: string;
  };
  chapters?: Array<{
    chapterIndex?: number;
    chapterTitle?: string;
    summary?: string;
    truncated?: boolean;
    originalChars?: number;
    processedChars?: number;
  }>;
  synthesis?: string | null;
};

export const runtime = "nodejs";

export async function GET() {
  try {
    const books = await listBooks();
    return NextResponse.json({ books });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load books.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: CreateBookBody;
  try {
    body = (await request.json()) as CreateBookBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!Array.isArray(body.chapters) || body.chapters.length === 0) {
    return NextResponse.json({ error: "chapters is required." }, { status: 400 });
  }

  try {
    const created = await createBook({
      bookTitle: body.bookTitle || "Untitled Book",
      detectionMethod: body.detectionMethod || null,
      source: body.source || "web-upload-fallback",
      settings: body.settings || {},
      chapters: body.chapters.map((chapter, index) => ({
        chapterIndex: Number(chapter.chapterIndex || index + 1),
        chapterTitle: String(chapter.chapterTitle || `Chapter ${index + 1}`),
        summary: String(chapter.summary || ""),
        truncated: Boolean(chapter.truncated),
        originalChars:
          typeof chapter.originalChars === "number" && Number.isFinite(chapter.originalChars)
            ? chapter.originalChars
            : undefined,
        processedChars:
          typeof chapter.processedChars === "number" && Number.isFinite(chapter.processedChars)
            ? chapter.processedChars
            : undefined,
      })),
      synthesis: body.synthesis || null,
    });

    return NextResponse.json({
      book: {
        id: created.id,
        bookTitle: created.bookTitle,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        chapterCount: created.chapters.length,
        hasSynthesis: Boolean(created.synthesis?.trim()),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create book.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const deleted = await clearAllBooks();
    return NextResponse.json({ deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to clear books.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

