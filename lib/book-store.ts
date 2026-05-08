import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import slugify from "slugify";

const BOOKS_DIR = path.join(process.cwd(), ".runtime", "books");

export type StoredBookSettings = {
  chapterModel?: string;
  synthesisModel?: string;
  detailLevel?: string;
  maxChapters?: string;
};

export type StoredBookChapter = {
  chapterIndex: number;
  chapterTitle: string;
  summary: string;
  truncated?: boolean;
  originalChars?: number;
  processedChars?: number;
};

export type StoredBook = {
  id: string;
  createdAt: string;
  updatedAt: string;
  bookTitle: string;
  detectionMethod?: string | null;
  source?: string;
  settings: StoredBookSettings;
  chapters: StoredBookChapter[];
  synthesis?: string | null;
};

export type StoredBookListItem = {
  id: string;
  bookTitle: string;
  createdAt: string;
  updatedAt: string;
  chapterCount: number;
  hasSynthesis: boolean;
  source?: string;
};

export type CreateStoredBookInput = {
  bookTitle: string;
  detectionMethod?: string | null;
  source?: string;
  settings?: StoredBookSettings;
  chapters: StoredBookChapter[];
  synthesis?: string | null;
};

function idPattern(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value);
}

function normalizeId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || !idPattern(trimmed)) {
    throw new Error("Invalid book id.");
  }
  return trimmed;
}

function generateId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}-${random}`;
}

function bookFilePath(bookId: string): string {
  return path.join(BOOKS_DIR, `${bookId}.json`);
}

async function ensureBooksDir(): Promise<void> {
  await fs.mkdir(BOOKS_DIR, { recursive: true });
}

function toListItem(book: StoredBook): StoredBookListItem {
  return {
    id: book.id,
    bookTitle: book.bookTitle,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    chapterCount: Array.isArray(book.chapters) ? book.chapters.length : 0,
    hasSynthesis: Boolean(book.synthesis?.trim()),
    source: book.source,
  };
}

async function readBookFile(absolutePath: string): Promise<StoredBook | null> {
  try {
    const raw = await fs.readFile(absolutePath, "utf8");
    return JSON.parse(raw) as StoredBook;
  } catch (error) {
    const maybe = error as NodeJS.ErrnoException;
    if (maybe?.code === "ENOENT") return null;
    throw error;
  }
}

export async function listBooks(): Promise<StoredBookListItem[]> {
  await ensureBooksDir();
  const entries = await fs.readdir(BOOKS_DIR, { withFileTypes: true });

  const books: StoredBookListItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const book = await readBookFile(path.join(BOOKS_DIR, entry.name));
    if (!book) continue;
    books.push(toListItem(book));
  }

  books.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return b.createdAt.localeCompare(a.createdAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return books;
}

export async function getBook(bookId: string): Promise<StoredBook | null> {
  const id = normalizeId(bookId);
  return readBookFile(bookFilePath(id));
}

export async function createBook(input: CreateStoredBookInput): Promise<StoredBook> {
  await ensureBooksDir();

  const chapters = Array.isArray(input.chapters)
    ? input.chapters
        .filter((entry) => entry?.summary && entry?.chapterTitle)
        .map((entry, index) => ({
          chapterIndex: Number(entry.chapterIndex || index + 1),
          chapterTitle: String(entry.chapterTitle),
          summary: String(entry.summary),
          truncated: Boolean(entry.truncated),
          originalChars:
            typeof entry.originalChars === "number" && Number.isFinite(entry.originalChars)
              ? entry.originalChars
              : undefined,
          processedChars:
            typeof entry.processedChars === "number" && Number.isFinite(entry.processedChars)
              ? entry.processedChars
              : undefined,
        }))
    : [];

  if (!chapters.length) {
    throw new Error("At least one chapter summary is required.");
  }

  const id = generateId();
  const now = new Date().toISOString();

  const record: StoredBook = {
    id,
    createdAt: now,
    updatedAt: now,
    bookTitle: (input.bookTitle || "Untitled Book").trim() || "Untitled Book",
    detectionMethod: input.detectionMethod || null,
    source: input.source || "web-upload-fallback",
    settings: input.settings || {},
    chapters,
    synthesis: input.synthesis || null,
  };

  await fs.writeFile(bookFilePath(id), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function deleteBook(bookId: string): Promise<boolean> {
  const id = normalizeId(bookId);
  try {
    await fs.unlink(bookFilePath(id));
    return true;
  } catch (error) {
    const maybe = error as NodeJS.ErrnoException;
    if (maybe?.code === "ENOENT") return false;
    throw error;
  }
}

export async function clearAllBooks(): Promise<number> {
  await ensureBooksDir();
  const entries = await fs.readdir(BOOKS_DIR, { withFileTypes: true });

  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    await fs.unlink(path.join(BOOKS_DIR, entry.name));
    deleted += 1;
  }

  return deleted;
}

export async function buildBookZip(book: StoredBook): Promise<{ buffer: Buffer; filename: string }> {
  const zip = new JSZip();

  const summaryJson = {
    generatedAt: book.createdAt,
    bookTitle: book.bookTitle,
    chapterModel: book.settings.chapterModel || "",
    synthesisModel: book.settings.synthesisModel || "",
    detailLevel: book.settings.detailLevel || "balanced",
    detectionMethod: book.detectionMethod || null,
    chapters: book.chapters.map((chapter) => ({
      chapterIndex: chapter.chapterIndex,
      chapterTitle: chapter.chapterTitle,
      summary: chapter.summary,
      truncated: chapter.truncated || false,
      originalChars: chapter.originalChars,
      processedChars: chapter.processedChars,
    })),
    synthesis: book.synthesis || null,
  };

  zip.file("summary.json", JSON.stringify(summaryJson, null, 2));

  const chaptersFolder = zip.folder("chapters");
  for (const chapter of book.chapters) {
    const chapterSlug =
      slugify(chapter.chapterTitle, {
        lower: true,
        strict: true,
        trim: true,
      }) || "chapter";

    const filename = `${String(chapter.chapterIndex).padStart(2, "0")}-${chapterSlug}.md`;
    chaptersFolder?.file(
      filename,
      `# Chapter ${chapter.chapterIndex}: ${chapter.chapterTitle}\n\n${chapter.summary}\n`,
    );
  }

  zip.file(
    "book-compression.md",
    book.synthesis?.trim()
      ? `# ${book.bookTitle}\n\n${book.synthesis}\n`
      : "# Book Compression\n\nNo synthesis available.\n",
  );

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const safeName =
    slugify(book.bookTitle, {
      lower: true,
      strict: true,
      trim: true,
    }) || "book-compression";

  return {
    buffer,
    filename: `${safeName}.zip`,
  };
}

