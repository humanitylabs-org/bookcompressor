"use client";

import { DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import JSZip from "jszip";
import { DEFAULT_PROMPT_CONFIG } from "@/lib/prompts";
import type { DetailLevel, PromptConfig } from "@/lib/prompts";
import { withBasePath } from "@/lib/base-path";

const DEFAULT_BASELINE_MODEL = "";

const SETTINGS_STORAGE_KEY = "book-compressor.settings.v3";
const RUN_STORAGE_KEY = "book-compressor.run.v3";
const CHAPTER_CACHE_STORAGE_KEY = "book-compressor.chapter-cache.v1";

type ParsedChapter = {
  chapterIndex: number;
  chapterTitle: string;
  chapterText: string;
  charCount: number;
};

type ParsedBook = {
  bookTitle: string;
  chapters: ParsedChapter[];
  detectionMethod: string;
};

type ChapterStatus = "queued" | "running" | "done" | "failed";

type ChapterResult = {
  chapterIndex: number;
  chapterTitle: string;
  status: ChapterStatus;
  finalSummary?: string;
  truncated?: boolean;
  originalChars?: number;
  processedChars?: number;
  error?: string;
};

type ChapterSummaryEntry = {
  chapterIndex: number;
  chapterTitle: string;
  summary: string;
  truncated?: boolean;
  originalChars?: number;
  processedChars?: number;
};

type ChapterCacheStore = Record<string, {
  updatedAt: number;
  chapters: ChapterSummaryEntry[];
}>;

type PreRunEstimate = {
  chapterCount: number;
  callCount: number;
};

type LibraryBookItem = {
  id: string;
  bookTitle: string;
  createdAt: string;
  updatedAt: string;
  chapterCount: number;
  hasSynthesis: boolean;
  source?: string;
};

function cleanText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function opfDirectory(opfPath: string): string {
  const normalized = opfPath.replace(/\\/g, "/");
  const slashIndex = normalized.lastIndexOf("/");
  return slashIndex >= 0 ? normalized.slice(0, slashIndex + 1) : "";
}

function resolveZipPath(baseDir: string, href: string): string {
  const baseUrl = `https://book.local/${baseDir}`;
  const resolved = new URL(href, baseUrl).pathname.replace(/^\/+/, "");
  return decodeURIComponent(resolved);
}

function extractXmlTitle(doc: Document): string {
  const namespacedTitle = doc.getElementsByTagNameNS("*", "title")[0]?.textContent;
  const fallbackTitle = doc.getElementsByTagName("title")[0]?.textContent;
  return cleanText(namespacedTitle || fallbackTitle || "");
}

function getChapterHeading(doc: Document): string {
  const heading =
    doc.querySelector("body h1")?.textContent ||
    doc.querySelector("body h2")?.textContent ||
    doc.querySelector("body h3")?.textContent ||
    doc.querySelector("title")?.textContent ||
    "";

  return cleanText(heading);
}

function fileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function buildRunCacheKey(input: {
  fileKey: string;
  detailLevel: DetailLevel;
  chapterModel: string;
  selectedChapters: ParsedChapter[];
}): string {
  const chapterSignature = input.selectedChapters
    .map((chapter) => `${chapter.chapterIndex}:${chapter.chapterTitle}:${chapter.charCount}`)
    .join("|");

  return [
    input.fileKey,
    input.detailLevel,
    input.chapterModel || "__default_model__",
    chapterSignature,
  ].join("::");
}

function readChapterCache(cacheKey: string): Map<number, ChapterSummaryEntry> {
  if (typeof window === "undefined") return new Map();

  try {
    const raw = localStorage.getItem(CHAPTER_CACHE_STORAGE_KEY);
    if (!raw) return new Map();

    const parsed = JSON.parse(raw) as ChapterCacheStore;
    const entry = parsed?.[cacheKey];
    if (!entry || !Array.isArray(entry.chapters)) return new Map();

    const output = new Map<number, ChapterSummaryEntry>();
    for (const chapter of entry.chapters) {
      if (!chapter || typeof chapter.chapterIndex !== "number") continue;
      if (typeof chapter.summary !== "string" || !chapter.summary.trim()) continue;
      output.set(chapter.chapterIndex, chapter);
    }

    return output;
  } catch {
    return new Map();
  }
}

function writeChapterCache(cacheKey: string, data: Map<number, ChapterSummaryEntry>) {
  if (typeof window === "undefined") return;

  try {
    const raw = localStorage.getItem(CHAPTER_CACHE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as ChapterCacheStore) : {};

    parsed[cacheKey] = {
      updatedAt: Date.now(),
      chapters: Array.from(data.values()).sort((a, b) => a.chapterIndex - b.chapterIndex),
    };

    localStorage.setItem(CHAPTER_CACHE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore local storage write failures
  }
}

function clearChapterCache(cacheKey: string) {
  if (typeof window === "undefined") return;

  try {
    const raw = localStorage.getItem(CHAPTER_CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as ChapterCacheStore;
    delete parsed[cacheKey];
    localStorage.setItem(CHAPTER_CACHE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore local storage write failures
  }
}

function statusClass(status: ChapterStatus): string {
  if (status === "running") return "badge badge--running";
  if (status === "done") return "badge badge--done";
  if (status === "failed") return "badge badge--failed";
  return "badge badge--queued";
}

async function postJsonWithTimeout<TPayload, TResult>(
  url: string,
  payload: TPayload,
  externalSignal: AbortSignal,
  timeoutMs = 420_000,
): Promise<TResult> {
  const internalController = new AbortController();
  const timeout = setTimeout(() => {
    internalController.abort();
  }, timeoutMs);

  const handleExternalAbort = () => {
    internalController.abort();
  };

  if (externalSignal.aborted) {
    internalController.abort();
  } else {
    externalSignal.addEventListener("abort", handleExternalAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: internalController.signal,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || `Request failed (${response.status}).`);
    }

    return data as TResult;
  } catch (error) {
    if (externalSignal.aborted) {
      throw new Error("Run stopped by user.");
    }

    if (internalController.signal.aborted) {
      throw new Error("Request timed out.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal.removeEventListener("abort", handleExternalAbort);
  }
}

type SpineDoc = {
  href: string;
  resolvedPath: string;
  bodyText: string;
  heading: string;
};

type TocEntry = {
  title: string;
  href: string;
  depth: number;
};

const FRONT_BACK_MATTER_PATTERNS = [
  /^cover$/i,
  /^title\s*page$/i,
  /^copyright/i,
  /^dedication$/i,
  /^acknowled?gments?$/i,
  /^contents?$/i,
  /^table\s+of\s+contents$/i,
  /^bibliography$/i,
  /^references?$/i,
  /^index$/i,
  /^notes?$/i,
  /^endnotes?$/i,
  /^glossary$/i,
  /^about\s+the\s+author/i,
  /^also\s+by/i,
  /^praise\s+for/i,
  /^epigraph$/i,
  /^colophon$/i,
];

function isFrontOrBackMatter(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  return FRONT_BACK_MATTER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function stripHrefFragment(href: string): string {
  const hashIndex = href.indexOf("#");
  return hashIndex >= 0 ? href.slice(0, hashIndex) : href;
}

function parseNavXhtml(navXml: string, parser: DOMParser): TocEntry[] {
  const doc = parser.parseFromString(navXml, "application/xhtml+xml");
  const navs = Array.from(doc.getElementsByTagName("nav"));
  const tocNav =
    navs.find((node) => (node.getAttribute("epub:type") || "").toLowerCase().includes("toc")) ||
    navs[0];

  if (!tocNav) return [];

  const entries: TocEntry[] = [];

  const walk = (list: Element, depth: number) => {
    Array.from(list.children).forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;

      const anchor = Array.from(li.children).find(
        (child) => child.tagName.toLowerCase() === "a",
      ) as HTMLAnchorElement | undefined;
      const span = Array.from(li.children).find(
        (child) => child.tagName.toLowerCase() === "span",
      ) as HTMLElement | undefined;

      const href = anchor?.getAttribute("href") || "";
      const title = cleanText(anchor?.textContent || span?.textContent || "");

      if (href) entries.push({ title, href, depth });

      const nestedList = Array.from(li.children).find(
        (child) => child.tagName.toLowerCase() === "ol" || child.tagName.toLowerCase() === "ul",
      );
      if (nestedList) walk(nestedList, depth + 1);
    });
  };

  const rootList = Array.from(tocNav.children).find(
    (child) => child.tagName.toLowerCase() === "ol" || child.tagName.toLowerCase() === "ul",
  );

  if (rootList) walk(rootList, 1);

  return entries;
}

function parseTocNcx(ncxXml: string, parser: DOMParser): TocEntry[] {
  const doc = parser.parseFromString(ncxXml, "application/xml");
  const navMap = doc.getElementsByTagName("navMap")[0];
  if (!navMap) return [];

  const entries: TocEntry[] = [];

  const walk = (parent: Element, depth: number) => {
    Array.from(parent.children).forEach((node) => {
      if (node.tagName.toLowerCase() !== "navpoint") return;

      const labelText = cleanText(
        node.getElementsByTagName("text")[0]?.textContent || "",
      );
      const contentEl = Array.from(node.children).find(
        (child) => child.tagName.toLowerCase() === "content",
      );
      const href = contentEl?.getAttribute("src") || "";

      if (href) entries.push({ title: labelText, href, depth });

      walk(node, depth + 1);
    });
  };

  walk(navMap, 1);
  return entries;
}

function chooseChapterDepth(entries: TocEntry[]): number {
  const byDepth = new Map<number, number>();
  entries.forEach((entry) => {
    byDepth.set(entry.depth, (byDepth.get(entry.depth) || 0) + 1);
  });

  const sorted = Array.from(byDepth.keys()).sort((a, b) => a - b);
  for (const depth of sorted) {
    const count = byDepth.get(depth) || 0;
    if (count >= 3 && count <= 60) return depth;
  }
  return sorted[0] || 1;
}

function buildChaptersFromToc(
  toc: TocEntry[],
  spineDocs: SpineDoc[],
  baseDir: string,
): ParsedChapter[] {
  const spineIndexByPath = new Map<string, number>();
  spineDocs.forEach((doc, index) => {
    if (!spineIndexByPath.has(doc.resolvedPath)) {
      spineIndexByPath.set(doc.resolvedPath, index);
    }
  });

  const chosenDepth = chooseChapterDepth(toc);
  const topLevel = toc.filter((entry) => entry.depth === chosenDepth);

  const boundaries = topLevel
    .map((entry) => {
      const resolved = resolveZipPath(baseDir, stripHrefFragment(entry.href));
      const spineIndex = spineIndexByPath.get(resolved);
      return spineIndex === undefined
        ? null
        : { title: entry.title, spineIndex };
    })
    .filter((entry): entry is { title: string; spineIndex: number } => entry !== null)
    .sort((a, b) => a.spineIndex - b.spineIndex);

  const chapters: ParsedChapter[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const startIndex = boundaries[i].spineIndex;
    const endIndex = i + 1 < boundaries.length ? boundaries[i + 1].spineIndex : spineDocs.length;
    const slice = spineDocs.slice(startIndex, endIndex);
    const text = cleanText(slice.map((doc) => doc.bodyText).join("\n\n"));

    const wordCount = text ? text.split(/\s+/).length : 0;
    if (wordCount < 200) continue;

    const title = boundaries[i].title || slice[0]?.heading || `Chapter ${chapters.length + 1}`;
    if (isFrontOrBackMatter(title)) continue;

    chapters.push({
      chapterIndex: chapters.length + 1,
      chapterTitle: title,
      chapterText: text,
      charCount: text.length,
    });
  }

  return chapters;
}

const CHAPTER_HEADING_PATTERN = /^\s*(Chapter|Part|Book|Section)\s+([0-9IVXLCM]+|[A-Z][a-z]+)/i;

function buildChaptersFromSpineHeadings(spineDocs: SpineDoc[]): ParsedChapter[] {
  const groups: { title: string; docs: SpineDoc[] }[] = [];
  let current: { title: string; docs: SpineDoc[] } | null = null;

  for (const doc of spineDocs) {
    const heading = doc.heading;
    if (CHAPTER_HEADING_PATTERN.test(heading)) {
      if (current) groups.push(current);
      current = { title: heading, docs: [doc] };
    } else if (current) {
      current.docs.push(doc);
    }
  }
  if (current) groups.push(current);

  const chapters: ParsedChapter[] = [];
  for (const group of groups) {
    const text = cleanText(group.docs.map((doc) => doc.bodyText).join("\n\n"));
    const wordCount = text ? text.split(/\s+/).length : 0;
    if (wordCount < 200) continue;
    if (isFrontOrBackMatter(group.title)) continue;

    chapters.push({
      chapterIndex: chapters.length + 1,
      chapterTitle: group.title,
      chapterText: text,
      charCount: text.length,
    });
  }

  return chapters;
}

function buildChaptersFromSpineFallback(spineDocs: SpineDoc[]): ParsedChapter[] {
  const chapters: ParsedChapter[] = [];
  for (const doc of spineDocs) {
    const wordCount = doc.bodyText ? doc.bodyText.split(/\s+/).length : 0;
    if (wordCount < 200) continue;
    const title = doc.heading || `Section ${chapters.length + 1}`;
    if (isFrontOrBackMatter(title)) continue;

    chapters.push({
      chapterIndex: chapters.length + 1,
      chapterTitle: title,
      chapterText: doc.bodyText,
      charCount: doc.bodyText.length,
    });
  }
  return chapters;
}

async function parseEpubInBrowser(file: File): Promise<ParsedBook> {
  const raw = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(raw);
  const parser = new DOMParser();

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) {
    throw new Error("Invalid EPUB: missing META-INF/container.xml");
  }

  const containerXml = await containerFile.async("text");
  const containerDoc = parser.parseFromString(containerXml, "application/xml");
  const rootfilePath =
    containerDoc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path") || "";

  if (!rootfilePath) {
    throw new Error("Invalid EPUB: rootfile path not found.");
  }

  const opfFile = zip.file(rootfilePath);
  if (!opfFile) {
    throw new Error(`Invalid EPUB: OPF file not found at ${rootfilePath}.`);
  }

  const opfXml = await opfFile.async("text");
  const opfDoc = parser.parseFromString(opfXml, "application/xml");
  const bookTitle = extractXmlTitle(opfDoc) || file.name.replace(/\.epub$/i, "");
  const baseDir = opfDirectory(rootfilePath);

  const manifest = new Map<
    string,
    { href: string; mediaType: string; properties: string }
  >();
  let navManifestId = "";
  let ncxManifestId = "";

  Array.from(opfDoc.getElementsByTagName("item")).forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") || "";
    const properties = item.getAttribute("properties") || "";
    if (!id || !href) return;

    manifest.set(id, { href, mediaType, properties });

    if (properties.toLowerCase().includes("nav")) navManifestId = id;
    if (mediaType === "application/x-dtbncx+xml") ncxManifestId = id;
  });

  const spineDocs: SpineDoc[] = [];
  const spineItems = Array.from(opfDoc.getElementsByTagName("itemref"));
  for (const spineItem of spineItems) {
    const idRef = spineItem.getAttribute("idref") || "";
    const item = manifest.get(idRef);
    if (!item) continue;

    const media = item.mediaType.toLowerCase();
    const looksLikeHtml = media.includes("xhtml") || media.includes("html") || media.includes("xml");
    if (!looksLikeHtml) continue;

    const resolvedPath = resolveZipPath(baseDir, item.href);
    const chapterFile = zip.file(resolvedPath) || zip.file(item.href);
    if (!chapterFile) continue;

    const chapterRaw = await chapterFile.async("text");
    const chapterDoc = parser.parseFromString(chapterRaw, "application/xhtml+xml");

    const bodyText = cleanText(
      chapterDoc.querySelector("body")?.textContent ||
        chapterDoc.documentElement?.textContent ||
        "",
    );
    const heading = getChapterHeading(chapterDoc);

    spineDocs.push({ href: item.href, resolvedPath, bodyText, heading });
  }

  if (!spineDocs.length) {
    throw new Error("No valid HTML content found in this EPUB.");
  }

  let toc: TocEntry[] = [];
  let tocBaseDir = baseDir;

  const tocItem = manifest.get(navManifestId) || manifest.get(ncxManifestId);
  if (tocItem) {
    const tocResolved = resolveZipPath(baseDir, tocItem.href);
    const tocFile = zip.file(tocResolved) || zip.file(tocItem.href);
    if (tocFile) {
      const tocXml = await tocFile.async("text");
      tocBaseDir = opfDirectory(tocResolved);
      toc =
        manifest.get(navManifestId) === tocItem
          ? parseNavXhtml(tocXml, parser)
          : parseTocNcx(tocXml, parser);
    }
  }

  let chapters: ParsedChapter[] = [];
  let detectionMethod = "";

  if (toc.length) {
    chapters = buildChaptersFromToc(toc, spineDocs, tocBaseDir);
    if (chapters.length >= 3) detectionMethod = "EPUB table of contents";
  }

  if (chapters.length < 3) {
    const headingChapters = buildChaptersFromSpineHeadings(spineDocs);
    if (headingChapters.length >= 3) {
      chapters = headingChapters;
      detectionMethod = "chapter heading pattern";
    }
  }

  if (chapters.length < 1) {
    chapters = buildChaptersFromSpineFallback(spineDocs);
    detectionMethod = "spine fallback (one section per file)";
  }

  if (!chapters.length) {
    throw new Error("No valid chapter content found in this EPUB.");
  }

  return { bookTitle, chapters, detectionMethod };
}

export default function Home() {
  const abortControllerRef = useRef<AbortController | null>(null);

  const [chapterModel, setChapterModel] = useState(DEFAULT_BASELINE_MODEL);
  const [synthesisModel, setSynthesisModel] = useState(DEFAULT_BASELINE_MODEL);
  const [detailLevel, setDetailLevel] = useState<DetailLevel>("balanced");
  const [maxChapters, setMaxChapters] = useState("0");
  const [chapterConcurrency, setChapterConcurrency] = useState("1");

  const [rightsConfirmed] = useState(true);
  const [epubFile, setEpubFile] = useState<File | null>(null);
  const [parsedBookCache, setParsedBookCache] = useState<ParsedBook | null>(null);
  const [parsedFileKey, setParsedFileKey] = useState("");
  const [isInspectingFile, setIsInspectingFile] = useState(false);
  const [isDropActive, setIsDropActive] = useState(false);

  const promptConfig: PromptConfig = DEFAULT_PROMPT_CONFIG;

  const [bookTitle, setBookTitle] = useState("");
  const [chapterResults, setChapterResults] = useState<ChapterResult[]>([]);
  const [bookSynthesis, setBookSynthesis] = useState("");

  const [isRunning, setIsRunning] = useState(false);
  const [isSavingBook, setIsSavingBook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("Idle");
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [savedBookId, setSavedBookId] = useState<string | null>(null);

  const [libraryBooks, setLibraryBooks] = useState<LibraryBookItem[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [isImportingLibrary, setIsImportingLibrary] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const completedCount = chapterResults.filter(
    (result) => result.status === "done" || result.status === "failed",
  ).length;

  const progressPercent = useMemo(() => {
    if (!chapterResults.length) return 0;
    return Math.round((completedCount / chapterResults.length) * 100);
  }, [chapterResults.length, completedCount]);

  const successfulChapters = chapterResults.filter(
    (result) => result.status === "done" && result.finalSummary,
  );

  const estimate = useMemo<PreRunEstimate | null>(() => {
    if (!parsedBookCache) return null;

    const chapterLimit = Number(maxChapters);
    const selected =
      Number.isFinite(chapterLimit) && chapterLimit > 0
        ? parsedBookCache.chapters.slice(0, chapterLimit)
        : parsedBookCache.chapters;

    if (!selected.length) return null;

    return {
      chapterCount: selected.length,
      callCount: selected.length + 1,
    };
  }, [parsedBookCache, maxChapters]);

  const loadLibrary = async () => {
    setIsLibraryLoading(true);
    setLibraryError(null);

    try {
      const response = await fetch(withBasePath("/api/books"), { cache: "no-store" });
      const data = (await response.json()) as { books?: LibraryBookItem[]; error?: string };

      if (!response.ok) {
        throw new Error(data.error || `Failed to load books (${response.status}).`);
      }

      setLibraryBooks(Array.isArray(data.books) ? data.books : []);
    } catch (libraryLoadError) {
      const message =
        libraryLoadError instanceof Error ? libraryLoadError.message : "Failed to load books.";
      setLibraryError(message);
    } finally {
      setIsLibraryLoading(false);
    }
  };

  const saveRunToLibrary = async (input: {
    bookTitle: string;
    detectionMethod?: string;
    chapters: Array<{
      chapterIndex: number;
      chapterTitle: string;
      summary: string;
      truncated?: boolean;
      originalChars?: number;
      processedChars?: number;
    }>;
    synthesis?: string;
  }) => {
    setIsSavingBook(true);
    try {
      const response = await fetch(withBasePath("/api/books"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bookTitle: input.bookTitle,
          detectionMethod: input.detectionMethod || null,
          source: "web-upload-fallback",
          settings: {
            chapterModel,
            synthesisModel,
            detailLevel,
            maxChapters,
            chapterConcurrency,
          },
          chapters: input.chapters,
          synthesis: input.synthesis || null,
        }),
      });

      const data = (await response.json()) as {
        book?: { id: string };
        error?: string;
      };

      if (!response.ok || !data.book?.id) {
        throw new Error(data.error || `Failed to save book (${response.status}).`);
      }

      setSavedBookId(data.book.id);
      await loadLibrary();
      return data.book.id;
    } finally {
      setIsSavingBook(false);
    }
  };

  const handleDeleteBook = async (bookId: string) => {
    const confirmed = window.confirm("Delete this saved book from local history?");
    if (!confirmed) return;

    try {
      const response = await fetch(withBasePath(`/api/books/${bookId}`), {
        method: "DELETE",
      });

      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(data?.error || `Delete failed (${response.status}).`);
      }

      setLibraryBooks((previous) => previous.filter((book) => book.id !== bookId));
      if (savedBookId === bookId) setSavedBookId(null);
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "Failed to delete book.";
      setLibraryError(message);
    }
  };

  const handleClearAllBooks = async () => {
    const confirmed = window.confirm(
      "Clear all saved books from local history on this machine?",
    );
    if (!confirmed) return;

    try {
      const response = await fetch(withBasePath("/api/books"), {
        method: "DELETE",
      });

      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(data?.error || `Clear failed (${response.status}).`);
      }

      setLibraryBooks([]);
      setSavedBookId(null);
      setLibraryError(null);
    } catch (clearError) {
      const message =
        clearError instanceof Error ? clearError.message : "Failed to clear book history.";
      setLibraryError(message);
    }
  };

  const triggerDownload = (url: string, filename?: string) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    if (filename) anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleExportLibrary = () => {
    setLibraryError(null);
    setLibraryNotice("Downloading library export...");
    triggerDownload(withBasePath("/api/books/export"), "bookcompressor-library.json");
  };

  const handleExportBook = (bookId: string) => {
    setLibraryError(null);
    setLibraryNotice("Downloading book export...");
    triggerDownload(
      withBasePath(`/api/books/${bookId}/export`),
      `bookcompressor-${bookId}.json`,
    );
  };

  const handleImportLibraryFile = async (file: File | null) => {
    if (!file) return;

    setIsImportingLibrary(true);
    setLibraryError(null);
    setLibraryNotice(null);

    try {
      const text = await file.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("Invalid JSON file.");
      }

      const response = await fetch(withBasePath("/api/books/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => null)) as
        | { imported?: number; error?: string }
        | null;

      if (!response.ok) {
        throw new Error(data?.error || `Import failed (${response.status}).`);
      }

      const imported = typeof data?.imported === "number" ? data.imported : 0;
      if (imported < 1) {
        throw new Error("No valid books found in the import file.");
      }

      setLibraryNotice(`Imported ${imported} book${imported === 1 ? "" : "s"}.`);
      await loadLibrary();
    } catch (importError) {
      const message =
        importError instanceof Error ? importError.message : "Failed to import library file.";
      setLibraryError(message);
    } finally {
      setIsImportingLibrary(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  useEffect(() => {
    void loadLibrary();
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as {
        chapterModel?: string;
        synthesisModel?: string;
        detailLevel?: DetailLevel;
        maxChapters?: string;
        chapterConcurrency?: string;
      };

      if (parsed.chapterModel) setChapterModel(parsed.chapterModel);
      if (parsed.synthesisModel) setSynthesisModel(parsed.synthesisModel);
      if (parsed.detailLevel) setDetailLevel(parsed.detailLevel);
      if (typeof parsed.maxChapters === "string") setMaxChapters(parsed.maxChapters);
      if (typeof parsed.chapterConcurrency === "string") {
        setChapterConcurrency(parsed.chapterConcurrency);
      }
    } catch {
      // ignore local storage parse failures
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          chapterModel,
          synthesisModel,
          detailLevel,
          maxChapters,
          chapterConcurrency,
        }),
      );
    } catch {
      // ignore write failures
    }
  }, [chapterModel, synthesisModel, detailLevel, maxChapters, chapterConcurrency]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RUN_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as {
        bookTitle?: string;
        chapterResults?: ChapterResult[];
        bookSynthesis?: string;
        statusLine?: string;
      };

      if (parsed.bookTitle) setBookTitle(parsed.bookTitle);
      if (Array.isArray(parsed.chapterResults) && parsed.chapterResults.length) {
        setChapterResults(parsed.chapterResults);
        setResumeNotice(
          "Restored last run output from browser checkpoint. If a run was in progress, it was stopped by refresh.",
        );
      }
      if (typeof parsed.bookSynthesis === "string") setBookSynthesis(parsed.bookSynthesis);
      if (typeof parsed.statusLine === "string") setStatusLine(parsed.statusLine);
    } catch {
      // ignore local storage parse failures
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        RUN_STORAGE_KEY,
        JSON.stringify({
          bookTitle,
          chapterResults,
          bookSynthesis,
          statusLine,
          updatedAt: Date.now(),
        }),
      );
    } catch {
      // ignore write failures
    }
  }, [bookTitle, chapterResults, bookSynthesis, statusLine]);

  const updateChapter = (chapterIndex: number, updates: Partial<ChapterResult>) => {
    setChapterResults((previous) =>
      previous.map((entry) =>
        entry.chapterIndex === chapterIndex ? { ...entry, ...updates } : entry,
      ),
    );
  };

  const clearOutput = () => {
    setBookTitle("");
    setChapterResults([]);
    setBookSynthesis("");
    setResumeNotice(null);
    setSavedBookId(null);
    setStatusLine("Idle");
    try {
      localStorage.removeItem(RUN_STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  const handleStopRun = () => {
    if (!isRunning) return;
    abortControllerRef.current?.abort();
    setStatusLine("Stopping after current request...");
  };

  const handleDropZoneDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(true);
  };

  const handleDropZoneDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);
  };

  const handleDropZoneDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDropActive(false);
    const file = event.dataTransfer?.files?.[0] || null;
    if (!file) return;
    void handleFileSelection(file);
  };

  const handleFileSelection = async (file: File | null) => {
    setEpubFile(file);
    setParsedBookCache(null);
    setParsedFileKey("");

    if (!file) return;

    const key = fileFingerprint(file);
    setParsedFileKey(key);
    setIsInspectingFile(true);
    setError(null);
    setStatusLine("Inspecting EPUB and counting chapters...");

    try {
      const parsed = await parseEpubInBrowser(file);
      setParsedBookCache(parsed);
      setBookTitle((previous) => previous || parsed.bookTitle);
      setStatusLine(
        `Ready. Detected ${parsed.chapters.length} chapters via ${parsed.detectionMethod}.`,
      );
    } catch (inspectionError) {
      const message =
        inspectionError instanceof Error ? inspectionError.message : "Failed to inspect EPUB.";
      setError(message);
      setStatusLine("Failed to inspect EPUB.");
    } finally {
      setIsInspectingFile(false);
    }
  };

  const handleCompress = async (event: FormEvent) => {
    event.preventDefault();

    setError(null);
    setBookSynthesis("");
    setResumeNotice(null);
    setSavedBookId(null);

    if (!epubFile) {
      setError("Please upload an EPUB file.");
      return;
    }

    if (!rightsConfirmed) {
      setError("You must confirm you have rights to process this content.");
      return;
    }

    const runController = new AbortController();
    abortControllerRef.current = runController;

    setIsRunning(true);

    try {
      const currentKey = fileFingerprint(epubFile);
      let parsed =
        parsedBookCache && parsedFileKey === currentKey
          ? parsedBookCache
          : await parseEpubInBrowser(epubFile);

      if (!parsedBookCache || parsedFileKey !== currentKey) {
        setParsedBookCache(parsed);
        setParsedFileKey(currentKey);
      }

      setBookTitle(parsed.bookTitle);

      const chapterLimit = Number(maxChapters);
      const selectedChapters =
        Number.isFinite(chapterLimit) && chapterLimit > 0
          ? parsed.chapters.slice(0, chapterLimit)
          : parsed.chapters;

      if (!selectedChapters.length) {
        throw new Error("No chapters selected for processing.");
      }

      const runCacheKey = buildRunCacheKey({
        fileKey: currentKey,
        detailLevel,
        chapterModel: chapterModel.trim(),
        selectedChapters,
      });

      const doneByChapter = readChapterCache(runCacheKey);
      for (const [cachedIndex, cachedEntry] of Array.from(doneByChapter.entries())) {
        const liveChapter = selectedChapters.find((chapter) => chapter.chapterIndex === cachedIndex);
        if (!liveChapter || liveChapter.chapterTitle !== cachedEntry.chapterTitle) {
          doneByChapter.delete(cachedIndex);
        }
      }

      if (!doneByChapter.size && chapterResults.length) {
        for (const result of chapterResults) {
          if (result.status !== "done" || !result.finalSummary) continue;
          const liveChapter = selectedChapters.find(
            (chapter) => chapter.chapterIndex === result.chapterIndex,
          );
          if (!liveChapter || liveChapter.chapterTitle !== result.chapterTitle) continue;

          doneByChapter.set(result.chapterIndex, {
            chapterIndex: result.chapterIndex,
            chapterTitle: result.chapterTitle,
            summary: result.finalSummary,
            truncated: result.truncated,
            originalChars: result.originalChars,
            processedChars: result.processedChars,
          });
        }

        if (doneByChapter.size) {
          writeChapterCache(runCacheKey, doneByChapter);
        }
      }

      setChapterResults(
        selectedChapters.map((chapter) => {
          const cached = doneByChapter.get(chapter.chapterIndex);
          if (cached && cached.chapterTitle === chapter.chapterTitle) {
            return {
              chapterIndex: chapter.chapterIndex,
              chapterTitle: chapter.chapterTitle,
              status: "done" as const,
              finalSummary: cached.summary,
              truncated: cached.truncated,
              originalChars: cached.originalChars,
              processedChars: cached.processedChars,
            };
          }

          return {
            chapterIndex: chapter.chapterIndex,
            chapterTitle: chapter.chapterTitle,
            status: "queued" as const,
          };
        }),
      );

      const pendingChapters = selectedChapters.filter(
        (chapter) => !doneByChapter.has(chapter.chapterIndex),
      );

      const CHAPTER_TIMEOUT_MS = 420_000;
      const RETRY_CHAPTER_TIMEOUT_MS = 720_000;
      const FINAL_RESCUE_TIMEOUT_MS = 900_000;
      const SYNTHESIS_TIMEOUT_MS = 600_000;
      const CHAPTER_RETRY_ATTEMPTS = 3;
      const FINAL_RESCUE_ATTEMPTS = 2;

      const runChapterSummary = async (
        chapter: ParsedChapter,
        timeoutMs: number,
      ) => {
        return postJsonWithTimeout<
          {
            model?: string;
            chapterTitle: string;
            chapterText: string;
            chapterIndex: number;
            totalChapters: number;
            detailLevel: DetailLevel;
            promptConfig: PromptConfig;
          },
          {
            finalSummary?: string;
            truncated?: boolean;
            originalChars?: number;
            processedChars?: number;
          }
        >(
          withBasePath("/api/summarize-chapter"),
          {
            model: chapterModel.trim() || undefined,
            chapterTitle: chapter.chapterTitle,
            chapterText: chapter.chapterText,
            chapterIndex: chapter.chapterIndex,
            totalChapters: selectedChapters.length,
            detailLevel,
            promptConfig,
          },
          runController.signal,
          timeoutMs,
        );
      };

      const storeChapterSummary = (
        chapter: ParsedChapter,
        payload: {
          finalSummary?: string;
          truncated?: boolean;
          originalChars?: number;
          processedChars?: number;
        },
      ) => {
        if (!payload.finalSummary) return;
        doneByChapter.set(chapter.chapterIndex, {
          chapterIndex: chapter.chapterIndex,
          chapterTitle: chapter.chapterTitle,
          summary: payload.finalSummary,
          truncated: payload.truncated,
          originalChars: payload.originalChars,
          processedChars: payload.processedChars,
        });
        writeChapterCache(runCacheKey, doneByChapter);
      };

      const doneNow: ChapterSummaryEntry[] = [];

      const rawConcurrency = Number(chapterConcurrency);
      const configuredWorkers = Number.isFinite(rawConcurrency)
        ? Math.max(1, Math.min(12, Math.floor(rawConcurrency)))
        : 1;
      const workerCount = Math.max(1, Math.min(configuredWorkers, pendingChapters.length || 1));

      let queueIndex = 0;
      let completedChapters = 0;
      let successCount = 0;
      let failureCount = 0;
      let fatalStopReason: string | null = null;
      let fatalStopRequested = false;

      if (!pendingChapters.length) {
        setStatusLine(`All ${selectedChapters.length} chapters already summarized. Moving to synthesis...`);
      } else if (doneByChapter.size > 0) {
        setStatusLine(
          `Resuming from checkpoint: ${doneByChapter.size}/${selectedChapters.length} done. Running ${pendingChapters.length} remaining with ${workerCount} worker${workerCount === 1 ? "" : "s"}...`,
        );
      } else {
        setStatusLine(
          `Compressing chapters with ${workerCount} worker${workerCount === 1 ? "" : "s"}...`,
        );
      }

      const runNextChapter = async () => {
        while (true) {
          if (fatalStopRequested) return;
          if (runController.signal.aborted) return;

          const chapter = pendingChapters[queueIndex];
          queueIndex += 1;
          if (!chapter) return;

          updateChapter(chapter.chapterIndex, { status: "running", error: undefined });

          try {
            const payload = await runChapterSummary(chapter, CHAPTER_TIMEOUT_MS);

            updateChapter(chapter.chapterIndex, {
              status: "done",
              finalSummary: payload.finalSummary,
              truncated: payload.truncated,
              originalChars: payload.originalChars,
              processedChars: payload.processedChars,
            });

            storeChapterSummary(chapter, payload);
            if (payload.finalSummary) {
              successCount += 1;
            } else {
              failureCount += 1;
            }
          } catch (chapterError) {
            const message =
              chapterError instanceof Error ? chapterError.message : "Unknown chapter failure.";

            updateChapter(chapter.chapterIndex, {
              status: "failed",
              error: message,
            });

            failureCount += 1;

            if (!successCount && failureCount >= 3) {
              fatalStopReason =
                "Model/gateway appears unavailable (first 3 chapters all failed). Stopped early so you can fix settings and retry.";
              fatalStopRequested = true;
              setError(fatalStopReason);
              setStatusLine("Stopped early: model/gateway unavailable.");
              return;
            }

            if (message === "Run stopped by user.") {
              return;
            }
          } finally {
            completedChapters += 1;
            if (fatalStopRequested) {
              setStatusLine("Stopped early: model/gateway unavailable.");
              continue;
            }
            setStatusLine(
              `Compressing chapters... ${completedChapters}/${pendingChapters.length} current-pass finished (${doneByChapter.size}/${selectedChapters.length} total done).`,
            );
          }
        }
      };

      if (pendingChapters.length) {
        await Promise.all(Array.from({ length: workerCount }, () => runNextChapter()));
      }

      if (fatalStopReason) {
        return;
      }

      if (runController.signal.aborted) {
        setStatusLine("Stopped by user.");
        return;
      }

      let failedChapters = selectedChapters.filter(
        (chapter) => !doneByChapter.has(chapter.chapterIndex),
      );

      if (failedChapters.length) {
        setStatusLine(`Retrying ${failedChapters.length} chapter${failedChapters.length === 1 ? "" : "s"}...`);

        for (const chapter of failedChapters) {
          if (runController.signal.aborted) {
            setStatusLine("Stopped by user.");
            return;
          }

          let chapterRecovered = false;
          let lastError = "Chapter failed after retries.";

          for (let attempt = 1; attempt <= CHAPTER_RETRY_ATTEMPTS; attempt += 1) {
            setStatusLine(
              `Retrying chapter ${chapter.chapterIndex}/${selectedChapters.length} (attempt ${attempt}/${CHAPTER_RETRY_ATTEMPTS})...`,
            );
            updateChapter(chapter.chapterIndex, { status: "running", error: undefined });

            try {
              const payload = await runChapterSummary(chapter, RETRY_CHAPTER_TIMEOUT_MS);

              updateChapter(chapter.chapterIndex, {
                status: "done",
                finalSummary: payload.finalSummary,
                truncated: payload.truncated,
                originalChars: payload.originalChars,
                processedChars: payload.processedChars,
              });

              storeChapterSummary(chapter, payload);
              chapterRecovered = Boolean(payload.finalSummary);

              if (!chapterRecovered) {
                lastError = "Model returned empty chapter output.";
              } else {
                break;
              }
            } catch (retryError) {
              const message =
                retryError instanceof Error ? retryError.message : "Unknown chapter failure.";
              lastError = message;

              if (message === "Run stopped by user.") {
                setStatusLine("Stopped by user.");
                return;
              }
            }
          }

          if (!chapterRecovered) {
            updateChapter(chapter.chapterIndex, {
              status: "failed",
              error: lastError,
            });
          }
        }

        failedChapters = selectedChapters.filter(
          (chapter) => !doneByChapter.has(chapter.chapterIndex),
        );
      }

      if (failedChapters.length) {
        setStatusLine(
          `Running final rescue pass for ${failedChapters.length} remaining chapter${failedChapters.length === 1 ? "" : "s"}...`,
        );

        for (const chapter of failedChapters) {
          if (runController.signal.aborted) {
            setStatusLine("Stopped by user.");
            return;
          }

          let chapterRecovered = false;
          let lastError = "Chapter failed after final rescue pass.";

          for (let attempt = 1; attempt <= FINAL_RESCUE_ATTEMPTS; attempt += 1) {
            setStatusLine(
              `Final rescue chapter ${chapter.chapterIndex}/${selectedChapters.length} (attempt ${attempt}/${FINAL_RESCUE_ATTEMPTS})...`,
            );
            updateChapter(chapter.chapterIndex, { status: "running", error: undefined });

            try {
              const payload = await runChapterSummary(chapter, FINAL_RESCUE_TIMEOUT_MS);
              updateChapter(chapter.chapterIndex, {
                status: "done",
                finalSummary: payload.finalSummary,
                truncated: payload.truncated,
                originalChars: payload.originalChars,
                processedChars: payload.processedChars,
              });

              storeChapterSummary(chapter, payload);
              chapterRecovered = Boolean(payload.finalSummary);
              if (!chapterRecovered) {
                lastError = "Model returned empty chapter output.";
              } else {
                break;
              }
            } catch (retryError) {
              const message =
                retryError instanceof Error ? retryError.message : "Unknown chapter failure.";
              lastError = message;

              if (message === "Run stopped by user.") {
                setStatusLine("Stopped by user.");
                return;
              }
            }
          }

          if (!chapterRecovered) {
            updateChapter(chapter.chapterIndex, {
              status: "failed",
              error: lastError,
            });
          }
        }

        failedChapters = selectedChapters.filter(
          (chapter) => !doneByChapter.has(chapter.chapterIndex),
        );
      }

      if (failedChapters.length) {
        const failedPreview = failedChapters
          .slice(0, 4)
          .map((chapter) => `Chapter ${chapter.chapterIndex}`)
          .join(", ");
        const remainder = failedChapters.length > 4 ? ` +${failedChapters.length - 4} more` : "";

        setError(
          `Run incomplete: ${failedChapters.length}/${selectedChapters.length} chapters failed (${failedPreview}${remainder}). Completed chapters were checkpointed. Press Start Compression again to resume only failed chapters.`,
        );
        setStatusLine("Run incomplete (chapters failed). Not saved.");
        return;
      }

      doneNow.push(
        ...selectedChapters
          .map((chapter) => doneByChapter.get(chapter.chapterIndex))
          .filter(
            (
              value,
            ): value is {
              chapterIndex: number;
              chapterTitle: string;
              summary: string;
              truncated?: boolean;
              originalChars?: number;
              processedChars?: number;
            } => Boolean(value),
          ),
      );

      if (doneNow.length) {
        const orderedDone = doneNow.slice().sort((a, b) => a.chapterIndex - b.chapterIndex);
        let finalSynthesis = "";
        setStatusLine("Synthesizing full book output...");

        const synthesisPayload = await postJsonWithTimeout<
          {
            model?: string;
            bookTitle: string;
            chapterSummaries: Array<{ chapterIndex: number; chapterTitle: string; summary: string }>;
            promptConfig: PromptConfig;
          },
          {
            finalSynthesis?: string;
            error?: string;
          }
        >(
          withBasePath("/api/synthesize-book"),
          {
            model: synthesisModel.trim() || undefined,
            bookTitle: parsed.bookTitle,
            chapterSummaries: orderedDone,
            promptConfig,
          },
          runController.signal,
          SYNTHESIS_TIMEOUT_MS,
        );

        if (synthesisPayload.finalSynthesis) {
          finalSynthesis = synthesisPayload.finalSynthesis;
          setBookSynthesis(synthesisPayload.finalSynthesis);
        }

        setStatusLine("Saving to local library...");
        try {
          const bookId = await saveRunToLibrary({
            bookTitle: parsed.bookTitle,
            detectionMethod: parsed.detectionMethod,
            chapters: orderedDone,
            synthesis: finalSynthesis,
          });
          clearChapterCache(runCacheKey);
          setStatusLine(`Done. Saved as /${bookId}.`);
        } catch (saveError) {
          const message = saveError instanceof Error ? saveError.message : "Unknown save failure.";
          setError(`Compression finished, but saving failed: ${message}`);
          setStatusLine("Done, but failed to save in local library.");
        }
      } else {
        setError("No chapters completed successfully, so synthesis was skipped.");
        setStatusLine("No successful chapters to save.");
      }
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : "Compression failed.";
      setError(message);

      if (message === "Run stopped by user.") {
        setStatusLine("Stopped by user.");
      } else {
        setStatusLine("Failed.");
      }
    } finally {
      setIsRunning(false);
      abortControllerRef.current = null;
    }
  };

  return (
    <div className="page">
      <div className="shell">
        <section className="hero">
          <h1 className="hero__title">Book Compressor</h1>
          <p className="hero__sub">
            Send EPUB files through chat as your main flow. This page is just a simple fallback
            uploader plus local permalinks you can share via export/import.
          </p>
        </section>

        <div className="grid">
          <section className="card">
            <h2 className="card__title">Simple fallback flow</h2>
            <p className="card__subtitle">1) Drop EPUB 2) Start compression 3) Open saved permalink.</p>

            <form onSubmit={handleCompress}>
              <label className="field">
                <span className="field__label">Step 1 — EPUB file</span>
                <div
                  className={`dropzone ${isDropActive ? "dropzone--active" : ""}`}
                  onDragOver={handleDropZoneDragOver}
                  onDragLeave={handleDropZoneDragLeave}
                  onDrop={handleDropZoneDrop}
                >
                  Drag and drop an EPUB here.
                </div>
                <input
                  className="file"
                  type="file"
                  accept=".epub,application/epub+zip"
                  onChange={(event) => {
                    void handleFileSelection(event.target.files?.[0] || null);
                  }}
                />
                <p className="hint">
                  {isInspectingFile
                    ? "Inspecting EPUB..."
                    : epubFile
                      ? `Selected: ${epubFile.name}`
                      : "No file selected yet."}
                </p>
              </label>

              <div className="button-row">
                <button className="button" disabled={isRunning || isInspectingFile} type="submit">
                  {isRunning ? "Compressing..." : "Step 2 — Start Compression"}
                </button>

                <button
                  className="button button--ghost"
                  disabled={!isRunning}
                  type="button"
                  onClick={handleStopRun}
                >
                  Stop
                </button>
              </div>
            </form>

            {savedBookId ? (
              <div className="alert alert--info" style={{ marginTop: 12 }}>
                Step 3 — Saved: <Link href={`/${savedBookId}`}>/{savedBookId}</Link>
              </div>
            ) : null}

            {resumeNotice ? <div className="alert alert--info">{resumeNotice}</div> : null}
            {error ? <div className="alert alert--error">{error}</div> : null}

            <p className="status">Status: {statusLine}</p>
            <div className="progress" aria-label="progress">
              <div className="progress__fill" style={{ width: `${progressPercent}%` }} />
            </div>

            {chapterResults.length ? (
              <details className="prompt-editor" style={{ marginTop: 12 }}>
                <summary className="prompt-editor__summary">Chapter status</summary>
                <div className="chapter-list" style={{ marginBottom: 12 }}>
                  {chapterResults
                    .slice()
                    .sort((a, b) => a.chapterIndex - b.chapterIndex)
                    .map((result) => (
                      <article className="chapter-card" key={`${result.chapterIndex}-${result.chapterTitle}`}>
                        <div className="chapter-card__top">
                          <h3 className="chapter-card__title">
                            Chapter {result.chapterIndex}: {result.chapterTitle}
                          </h3>
                          <span className={statusClass(result.status)}>{result.status}</span>
                        </div>
                        {typeof result.processedChars === "number" ? (
                          <p className="chapter-card__meta">
                            {result.truncated ? "truncated" : "full"} · {result.processedChars.toLocaleString()} chars
                          </p>
                        ) : null}
                        {result.error ? <p className="chapter-card__meta" style={{ color: "#ffc9c9" }}>{result.error}</p> : null}
                      </article>
                    ))}
                </div>
              </details>
            ) : null}

            {chapterResults.length ? (
              <p className="footer-note">
                {successfulChapters.length}/{chapterResults.length} chapters done
                {bookSynthesis ? " + synthesis complete" : ""}.
              </p>
            ) : null}

            <details className="prompt-editor" style={{ marginTop: 14 }}>
              <summary className="prompt-editor__summary">Advanced (optional)</summary>

              <label className="field">
                <span className="field__label">Chapter Model</span>
                <input
                  className="input"
                  type="text"
                  value={chapterModel}
                  onChange={(event) => setChapterModel(event.target.value)}
                  placeholder="(optional) host default if blank"
                />
              </label>

              <label className="field">
                <span className="field__label">Book Synthesis Model</span>
                <input
                  className="input"
                  type="text"
                  value={synthesisModel}
                  onChange={(event) => setSynthesisModel(event.target.value)}
                  placeholder="(optional) host default if blank"
                />
              </label>

              <label className="field">
                <span className="field__label">Detail Level</span>
                <select
                  className="select"
                  value={detailLevel}
                  onChange={(event) => setDetailLevel(event.target.value as DetailLevel)}
                >
                  <option value="tight">Tight</option>
                  <option value="balanced">Balanced</option>
                  <option value="deep">Deep</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">Max Chapters (0 = all)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={1}
                  value={maxChapters}
                  onChange={(event) => setMaxChapters(event.target.value)}
                />
              </label>

              <label className="field">
                <span className="field__label">Parallel Chapter Workers (1-12)</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  value={chapterConcurrency}
                  onChange={(event) => setChapterConcurrency(event.target.value)}
                />
              </label>

              <div className="button-row" style={{ marginTop: 8 }}>
                <button
                  className="button button--ghost"
                  disabled={isRunning || (!chapterResults.length && !bookSynthesis)}
                  type="button"
                  onClick={clearOutput}
                >
                  Clear Output
                </button>
              </div>

              <hr className="library-divider" />
              <h3 className="card__title">Local library</h3>
              <p className="card__subtitle">Saved runs stay on this machine.</p>

              <div className="button-row" style={{ marginBottom: 10 }}>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    void loadLibrary();
                  }}
                  disabled={isLibraryLoading}
                >
                  {isLibraryLoading ? "Refreshing..." : "Refresh"}
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={handleExportLibrary}
                  disabled={isLibraryLoading || !libraryBooks.length}
                >
                  Export All
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    importInputRef.current?.click();
                  }}
                  disabled={isImportingLibrary}
                >
                  {isImportingLibrary ? "Importing..." : "Import"}
                </button>
              </div>

              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(event) => {
                  void handleImportLibraryFile(event.target.files?.[0] || null);
                }}
              />

              {libraryError ? <div className="alert alert--error">{libraryError}</div> : null}
              {libraryNotice ? <div className="alert alert--info">{libraryNotice}</div> : null}

              {isLibraryLoading ? (
                <div className="alert alert--info">Loading local library...</div>
              ) : !libraryBooks.length ? (
                <div className="alert alert--info">No saved books yet.</div>
              ) : (
                <div className="library-list">
                  {libraryBooks.slice(0, 8).map((book) => (
                    <article className="library-item" key={book.id}>
                      <div>
                        <p className="library-item__title">
                          <Link href={`/${book.id}`}>{book.bookTitle}</Link>
                        </p>
                        <p className="library-item__meta">
                          {new Date(book.createdAt).toLocaleString()} · {book.chapterCount} chapters
                          {book.hasSynthesis ? " · synthesis" : ""}
                        </p>
                        <p className="library-item__meta">
                          <code>/{book.id}</code>
                        </p>
                      </div>

                      <div className="library-item__actions">
                        <a className="button button--ghost button-link" href={withBasePath(`/${book.id}`)}>
                          Open
                        </a>
                        <button
                          className="button button--ghost button-link"
                          type="button"
                          onClick={() => {
                            handleExportBook(book.id);
                          }}
                        >
                          Export
                        </button>
                        <button
                          className="button button--ghost"
                          type="button"
                          onClick={() => {
                            void handleDeleteBook(book.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              <div className="button-row" style={{ marginTop: 10 }}>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => {
                    void handleClearAllBooks();
                  }}
                  disabled={isLibraryLoading || !libraryBooks.length}
                >
                  Clear All Data
                </button>
              </div>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}
