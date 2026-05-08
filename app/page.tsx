"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import JSZip from "jszip";
import slugify from "slugify";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { DEFAULT_PROMPT_CONFIG } from "@/lib/prompts";
import type { DetailLevel, PromptConfig } from "@/lib/prompts";
import { withBasePath } from "@/lib/base-path";

const DEFAULT_BASELINE_MODEL = "anthropic/claude-haiku-4.5";

const SETTINGS_STORAGE_KEY = "book-compressor.settings.v3";
const RUN_STORAGE_KEY = "book-compressor.run.v3";

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

type PricingMap = Record<
  string,
  {
    prompt: number;
    completion: number;
  }
>;

type PreRunEstimate = {
  chapterCount: number;
  callCount: number;
  approxCostUsd: number | null;
  missingPricingModels: string[];
};

const PROMPT_FIELD_META: Array<{
  key: keyof PromptConfig;
  label: string;
  rows: number;
}> = [
  { key: "chapterSystem", label: "Chapter System Prompt", rows: 8 },
  { key: "chapterUser", label: "Chapter User Prompt", rows: 14 },
  { key: "bookSystem", label: "Book Synthesis System Prompt", rows: 6 },
  { key: "bookUser", label: "Book Synthesis User Prompt", rows: 14 },
];

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

function statusClass(status: ChapterStatus): string {
  if (status === "running") return "badge badge--running";
  if (status === "done") return "badge badge--done";
  if (status === "failed") return "badge badge--failed";
  return "badge badge--queued";
}

function charsToTokens(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 4));
}

function completionTargets(detailLevel: DetailLevel) {
  if (detailLevel === "tight") return { chapter: 1100, synthesis: 1800 };
  if (detailLevel === "deep") return { chapter: 3500, synthesis: 3500 };
  return { chapter: 2100, synthesis: 2400 };
}

async function postJsonWithTimeout<TPayload, TResult>(
  url: string,
  payload: TPayload,
  externalSignal: AbortSignal,
  timeoutMs = 180_000,
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

  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [epubFile, setEpubFile] = useState<File | null>(null);
  const [parsedBookCache, setParsedBookCache] = useState<ParsedBook | null>(null);
  const [parsedFileKey, setParsedFileKey] = useState("");
  const [isInspectingFile, setIsInspectingFile] = useState(false);

  const [promptConfig, setPromptConfig] = useState<PromptConfig>({
    ...DEFAULT_PROMPT_CONFIG,
  });

  const [bookTitle, setBookTitle] = useState("");
  const [chapterResults, setChapterResults] = useState<ChapterResult[]>([]);
  const [bookSynthesis, setBookSynthesis] = useState("");

  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("Idle");
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);

  const [pricingMap, setPricingMap] = useState<PricingMap>({});

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

    const targets = completionTargets(detailLevel);
    const buckets: Record<string, { prompt: number; completion: number }> = {};
    const add = (model: string, promptTokens: number, completionTokens: number) => {
      if (!buckets[model]) buckets[model] = { prompt: 0, completion: 0 };
      buckets[model].prompt += promptTokens;
      buckets[model].completion += completionTokens;
    };

    for (const chapter of selected) {
      const chapterTokens = charsToTokens(chapter.charCount);
      add(chapterModel, chapterTokens + 600, targets.chapter);
    }

    const synthesisPrompt = selected.length * targets.chapter + 600;
    add(synthesisModel, synthesisPrompt, targets.synthesis);

    let totalCost = 0;
    const missing: string[] = [];

    for (const [model, tokenUsage] of Object.entries(buckets)) {
      const pricing = pricingMap[model];
      if (!pricing) {
        missing.push(model);
        continue;
      }
      totalCost += tokenUsage.prompt * pricing.prompt;
      totalCost += tokenUsage.completion * pricing.completion;
    }

    return {
      chapterCount: selected.length,
      callCount: selected.length + 1,
      approxCostUsd: missing.length ? null : totalCost,
      missingPricingModels: missing,
    };
  }, [parsedBookCache, maxChapters, detailLevel, chapterModel, synthesisModel, pricingMap]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as {
        chapterModel?: string;
        synthesisModel?: string;
        detailLevel?: DetailLevel;
        maxChapters?: string;
      };

      if (parsed.chapterModel) setChapterModel(parsed.chapterModel);
      if (parsed.synthesisModel) setSynthesisModel(parsed.synthesisModel);
      if (parsed.detailLevel) setDetailLevel(parsed.detailLevel);
      if (typeof parsed.maxChapters === "string") setMaxChapters(parsed.maxChapters);
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
        }),
      );
    } catch {
      // ignore write failures
    }
  }, [chapterModel, synthesisModel, detailLevel, maxChapters]);

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

  useEffect(() => {
    let cancelled = false;

    const loadPricing = async () => {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models");
        if (!response.ok) return;
        const payload = (await response.json()) as {
          data?: Array<{
            id?: string;
            pricing?: {
              prompt?: string;
              completion?: string;
            };
          }>;
        };

        if (cancelled || !Array.isArray(payload.data)) return;

        const nextMap: PricingMap = {};
        payload.data.forEach((model) => {
          const id = model.id;
          const prompt = Number(model.pricing?.prompt || 0);
          const completion = Number(model.pricing?.completion || 0);
          if (!id || !prompt || !completion) return;
          nextMap[id] = { prompt, completion };
        });

        setPricingMap(nextMap);
      } catch {
        // ignore pricing fetch failures
      }
    };

    void loadPricing();

    return () => {
      cancelled = true;
    };
  }, []);

  const updateChapter = (chapterIndex: number, updates: Partial<ChapterResult>) => {
    setChapterResults((previous) =>
      previous.map((entry) =>
        entry.chapterIndex === chapterIndex ? { ...entry, ...updates } : entry,
      ),
    );
  };

  const updatePromptField = (field: keyof PromptConfig, value: string) => {
    setPromptConfig((previous) => ({ ...previous, [field]: value }));
  };

  const resetPromptsToDefault = () => {
    setPromptConfig({ ...DEFAULT_PROMPT_CONFIG });
  };

  const clearOutput = () => {
    setBookTitle("");
    setChapterResults([]);
    setBookSynthesis("");
    setResumeNotice(null);
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

      setChapterResults(
        selectedChapters.map((chapter) => ({
          chapterIndex: chapter.chapterIndex,
          chapterTitle: chapter.chapterTitle,
          status: "queued",
        })),
      );

      const doneNow: Array<{ chapterIndex: number; chapterTitle: string; summary: string }> = [];

      for (const chapter of selectedChapters) {
        if (runController.signal.aborted) break;

        setStatusLine(`Compressing chapter ${chapter.chapterIndex}/${selectedChapters.length}...`);
        updateChapter(chapter.chapterIndex, { status: "running", error: undefined });

        try {
          const payload = await postJsonWithTimeout<
            {
              model: string;
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
              model: chapterModel.trim() || DEFAULT_BASELINE_MODEL,
              chapterTitle: chapter.chapterTitle,
              chapterText: chapter.chapterText,
              chapterIndex: chapter.chapterIndex,
              totalChapters: selectedChapters.length,
              detailLevel,
              promptConfig,
            },
            runController.signal,
          );

          updateChapter(chapter.chapterIndex, {
            status: "done",
            finalSummary: payload.finalSummary,
            truncated: payload.truncated,
            originalChars: payload.originalChars,
            processedChars: payload.processedChars,
          });

          if (payload.finalSummary) {
            doneNow.push({
              chapterIndex: chapter.chapterIndex,
              chapterTitle: chapter.chapterTitle,
              summary: payload.finalSummary,
            });
          }
        } catch (chapterError) {
          const message =
            chapterError instanceof Error ? chapterError.message : "Unknown chapter failure.";

          updateChapter(chapter.chapterIndex, {
            status: "failed",
            error: message,
          });

          if (message === "Run stopped by user.") {
            break;
          }
        }
      }

      if (runController.signal.aborted) {
        setStatusLine("Stopped by user.");
        return;
      }

      if (doneNow.length) {
        setStatusLine("Synthesizing full book output...");

        const synthesisPayload = await postJsonWithTimeout<
          {
            model: string;
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
            model: synthesisModel.trim() || DEFAULT_BASELINE_MODEL,
            bookTitle: parsed.bookTitle,
            chapterSummaries: doneNow,
            promptConfig,
          },
          runController.signal,
        );

        if (synthesisPayload.finalSynthesis) {
          setBookSynthesis(synthesisPayload.finalSynthesis);
        }
      } else {
        setError("No chapters completed successfully, so synthesis was skipped.");
      }

      setStatusLine("Done.");
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

  const handleDownloadZip = async () => {
    if (!successfulChapters.length) return;

    const zip = new JSZip();
    const safeBookName = slugify(bookTitle || "book-compression", {
      lower: true,
      strict: true,
      trim: true,
    });

    const summaryJson = {
      generatedAt: new Date().toISOString(),
      bookTitle,
      chapterModel,
      synthesisModel,
      detailLevel,
      detectionMethod: parsedBookCache?.detectionMethod || null,
      chapters: successfulChapters.map((chapter) => ({
        chapterIndex: chapter.chapterIndex,
        chapterTitle: chapter.chapterTitle,
        summary: chapter.finalSummary,
        truncated: chapter.truncated || false,
        originalChars: chapter.originalChars,
        processedChars: chapter.processedChars,
      })),
      synthesis: bookSynthesis || null,
    };

    zip.file("summary.json", JSON.stringify(summaryJson, null, 2));

    const chaptersFolder = zip.folder("chapters");
    successfulChapters.forEach((chapter) => {
      const slug = slugify(chapter.chapterTitle, {
        lower: true,
        strict: true,
        trim: true,
      });

      const filename = `${String(chapter.chapterIndex).padStart(2, "0")}-${slug || "chapter"}.md`;
      const markdown = `# Chapter ${chapter.chapterIndex}: ${chapter.chapterTitle}\n\n${chapter.finalSummary || ""}\n`;
      chaptersFolder?.file(filename, markdown);
    });

    const synthesisDoc = bookSynthesis
      ? `# ${bookTitle || "Book Compression"}\n\n${bookSynthesis}\n`
      : "# Book Compression\n\nNo synthesis available.\n";

    zip.file("book-compression.md", synthesisDoc);

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeBookName || "book-compression"}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page">
      <div className="shell">
        <section className="hero">
          <h1 className="hero__title">Book Compressor</h1>
          <p className="hero__sub">
            Upload an EPUB, get a Vajra-style walkthrough for every chapter plus a book-level
            synthesis, and download as a viewer-ready ZIP. Processing is transient — content is
            not persisted.
          </p>
          <div className="hero__actions">
            <Link className="button button--ghost button-link" href="/viewer">
              Open Viewer
            </Link>
          </div>
        </section>

        <div className="grid">
          <section className="card">
            <h2 className="card__title">Compression Setup</h2>
            <p className="card__subtitle">
              Uses your device's shared OpenRouter key. Defaults to Claude Haiku 4.5; switch
              models if you want richer output.
            </p>

            <div className="alert alert--info" style={{ marginBottom: 14 }}>
              This app reads the OpenRouter key from environment config (not from this form).
            </div>

            <form onSubmit={handleCompress}>
              <label className="field">
                <span className="field__label">Chapter Model</span>
                <input
                  className="input"
                  type="text"
                  value={chapterModel}
                  onChange={(event) => setChapterModel(event.target.value)}
                  placeholder={DEFAULT_BASELINE_MODEL}
                />
                <p className="hint">
                  Used for every chapter walkthrough. Try anthropic/claude-sonnet-4.6 for richer
                  prose.
                </p>
              </label>

              <label className="field">
                <span className="field__label">Book Synthesis Model</span>
                <input
                  className="input"
                  type="text"
                  value={synthesisModel}
                  onChange={(event) => setSynthesisModel(event.target.value)}
                  placeholder={DEFAULT_BASELINE_MODEL}
                />
                <p className="hint">Used once at the end to synthesize the per-chapter walkthroughs.</p>
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
                <p className="hint">Default is 0 (process all detected chapters).</p>
              </label>

              <label className="field">
                <span className="field__label">EPUB File</span>
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
                    : parsedBookCache
                      ? `Detected ${parsedBookCache.chapters.length} chapters.`
                      : "Select a file to pre-calculate chapter count before running."}
                </p>
              </label>

              {estimate ? (
                <div className="alert alert--info">
                  <strong>Pre-run estimate:</strong> {estimate.chapterCount} chapters · about{" "}
                  {estimate.callCount} model calls (1 per chapter + 1 synthesis).
                  {estimate.approxCostUsd !== null ? (
                    <> Estimated cost: ~${estimate.approxCostUsd.toFixed(2)}.</>
                  ) : (
                    <> Cost unavailable for one or more selected models.</>
                  )}
                  {estimate.chapterCount > 50 ? (
                    <> High chapter count — consider lowering max chapters.</>
                  ) : null}
                </div>
              ) : null}

              <details className="prompt-editor" open>
                <summary className="prompt-editor__summary">Prompt Modules (Editable Before Run)</summary>
                <p className="hint">
                  Edit prompts for this run. Reloading the page resets prompt text to defaults.
                </p>
                <p className="prompt-vars">
                  Placeholder variables: {"{{chapter_index}}"}, {"{{total_chapters}}"},{" "}
                  {"{{chapter_title}}"}, {"{{target_length}}"}, {"{{chapter_text}}"},{" "}
                  {"{{book_title}}"}, {"{{chapter_summaries}}"}
                </p>
                <div className="button-row" style={{ marginBottom: 12 }}>
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={resetPromptsToDefault}
                  >
                    Reset Prompts to Defaults
                  </button>
                </div>

                <div className="prompt-grid">
                  {PROMPT_FIELD_META.map((field) => (
                    <label className="field" key={field.key}>
                      <span className="field__label">{field.label}</span>
                      <textarea
                        className="textarea"
                        rows={field.rows}
                        value={promptConfig[field.key]}
                        onChange={(event) => updatePromptField(field.key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </details>

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={rightsConfirmed}
                  onChange={(event) => setRightsConfirmed(event.target.checked)}
                />
                <span>
                  I confirm I have legal rights or permission to process this content.
                </span>
              </label>

              {error ? <div className="alert alert--error">{error}</div> : null}

              <div className="button-row">
                <button className="button" disabled={isRunning || isInspectingFile} type="submit">
                  {isRunning ? "Compressing..." : "Start Compression"}
                </button>

                <button
                  className="button button--ghost"
                  disabled={!isRunning}
                  type="button"
                  onClick={handleStopRun}
                >
                  Stop
                </button>

                <button
                  className="button button--ghost"
                  disabled={isRunning || !successfulChapters.length}
                  type="button"
                  onClick={handleDownloadZip}
                >
                  Download ZIP
                </button>

                <button
                  className="button button--ghost"
                  disabled={isRunning || (!chapterResults.length && !bookSynthesis)}
                  type="button"
                  onClick={clearOutput}
                >
                  Clear Output
                </button>
              </div>

              <p className="hint" style={{ marginTop: 12 }}>
                After downloading a ZIP, open <Link href="/viewer">/viewer</Link> for a chapter
                sidebar + mobile-friendly reading layout.
              </p>
            </form>

            <div className="legal">
              <p>
                <strong>Privacy:</strong> source content is processed transiently and not persisted
                by this app.
              </p>
              <p>
                <strong>Runtime:</strong> if you refresh, in-flight processing stops. Checkpointed
                output is restored from local browser storage.
              </p>
              <p>
                <strong>Legal:</strong> do not upload material unless you have rights or permission
                to process it.
              </p>
            </div>
          </section>

          <section className="card">
            <h2 className="card__title">Run Output</h2>
            <p className="card__subtitle">
              {bookTitle ? `Book: ${bookTitle}` : "No book processed yet."} This preview follows
              the same markdown rendering style as the Viewer.
            </p>

            {resumeNotice ? <div className="alert alert--info">{resumeNotice}</div> : null}

            <p className="status">Status: {statusLine}</p>
            <div className="progress" aria-label="progress">
              <div className="progress__fill" style={{ width: `${progressPercent}%` }} />
            </div>

            {!chapterResults.length ? (
              <div className="alert alert--info">
                Start a run to see chapter-by-chapter output.
              </div>
            ) : (
              <div className="chapter-list">
                {chapterResults.map((chapter) => (
                  <article key={chapter.chapterIndex} className="chapter-card">
                    <div className="chapter-card__top">
                      <h3 className="chapter-card__title">
                        Chapter {chapter.chapterIndex}: {chapter.chapterTitle}
                      </h3>
                      <span className={statusClass(chapter.status)}>{chapter.status}</span>
                    </div>

                    <p className="chapter-card__meta">
                      {chapter.processedChars
                        ? `${chapter.processedChars.toLocaleString()} chars processed`
                        : "Waiting for processing"}
                      {chapter.truncated ? " · input trimmed for model context" : ""}
                    </p>

                    {chapter.error ? <pre className="markdown">Error: {chapter.error}</pre> : null}
                    {chapter.finalSummary ? (
                      <article className="bcv-markdown bcv-inline-markdown">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                          {chapter.finalSummary}
                        </ReactMarkdown>
                      </article>
                    ) : null}
                  </article>
                ))}
              </div>
            )}

            {bookSynthesis ? (
              <>
                <h3 className="card__title" style={{ marginTop: 20 }}>
                  Full Book Compression
                </h3>
                <article className="bcv-markdown bcv-inline-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {bookSynthesis}
                  </ReactMarkdown>
                </article>
              </>
            ) : null}

            <p className="footer-note">
              Output ZIP includes summary.json, chapter markdown files, and book-compression.md.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
