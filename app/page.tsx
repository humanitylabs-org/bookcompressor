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

const DEFAULT_BASELINE_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_MODEL_ROUTING = {
  passOneModel: "anthropic/claude-3.5-haiku",
  passTwoModel: "anthropic/claude-3.5-haiku",
  passThreeModel: DEFAULT_BASELINE_MODEL,
  synthesisModel: DEFAULT_BASELINE_MODEL,
};

const SETTINGS_STORAGE_KEY = "book-compressor.settings.v2";
const RUN_STORAGE_KEY = "book-compressor.run.v2";

type ParsedChapter = {
  chapterIndex: number;
  chapterTitle: string;
  chapterText: string;
  charCount: number;
};

type ParsedBook = {
  bookTitle: string;
  chapters: ParsedChapter[];
};

type ChapterStatus = "queued" | "running" | "done" | "failed";

type ChapterResult = {
  chapterIndex: number;
  chapterTitle: string;
  status: ChapterStatus;
  finalSummary?: string;
  passOne?: string;
  passTwo?: string;
  passThree?: string;
  truncated?: boolean;
  originalChars?: number;
  processedChars?: number;
  error?: string;
};

type ModelRouting = {
  passOneModel: string;
  passTwoModel: string;
  passThreeModel: string;
  synthesisModel: string;
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
  selectedPassCount: number;
  approxCostUsd: number | null;
  missingPricingModels: string[];
};

const PROMPT_FIELD_META: Array<{
  key: keyof PromptConfig;
  label: string;
  rows: number;
}> = [
  { key: "passOneSystem", label: "Pass 1 System Prompt", rows: 3 },
  { key: "passOneUser", label: "Pass 1 User Prompt", rows: 10 },
  { key: "passTwoSystem", label: "Pass 2 System Prompt", rows: 3 },
  { key: "passTwoUser", label: "Pass 2 User Prompt", rows: 10 },
  { key: "passThreeSystem", label: "Pass 3 System Prompt", rows: 3 },
  { key: "passThreeUser", label: "Pass 3 User Prompt", rows: 9 },
  { key: "bookSystem", label: "Book Synthesis System Prompt", rows: 3 },
  { key: "bookUser", label: "Book Synthesis User Prompt", rows: 10 },
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

function parsePassCount(value: number): 1 | 2 | 3 {
  if (value === 2 || value === 3) return value;
  return 1;
}

function charsToTokens(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 4));
}

function completionTargets(detailLevel: DetailLevel) {
  if (detailLevel === "tight") {
    return { passOne: 320, passTwo: 260, passThree: 320, synthesis: 1100 };
  }
  if (detailLevel === "deep") {
    return { passOne: 820, passTwo: 620, passThree: 820, synthesis: 1900 };
  }
  return { passOne: 560, passTwo: 420, passThree: 560, synthesis: 1400 };
}

function resolveActiveModels(
  baselineModel: string,
  useAdvancedRouting: boolean,
  modelRouting: ModelRouting,
) {
  if (!useAdvancedRouting) {
    return {
      passOneModel: baselineModel,
      passTwoModel: baselineModel,
      passThreeModel: baselineModel,
      synthesisModel: baselineModel,
    };
  }

  return {
    passOneModel: modelRouting.passOneModel.trim() || baselineModel,
    passTwoModel: modelRouting.passTwoModel.trim() || baselineModel,
    passThreeModel: modelRouting.passThreeModel.trim() || baselineModel,
    synthesisModel: modelRouting.synthesisModel.trim() || baselineModel,
  };
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

  const manifest = new Map<
    string,
    {
      href: string;
      mediaType: string;
    }
  >();

  Array.from(opfDoc.getElementsByTagName("item")).forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") || "";

    if (!id || !href) return;

    manifest.set(id, { href, mediaType });
  });

  const baseDir = opfDirectory(rootfilePath);
  const chapters: ParsedChapter[] = [];
  let chapterCounter = 1;

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
      chapterDoc.querySelector("body")?.textContent || chapterDoc.documentElement?.textContent || "",
    );

    const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
    if (wordCount < 60) continue;

    const chapterTitle = getChapterHeading(chapterDoc) || `Chapter ${chapterCounter}`;

    chapters.push({
      chapterIndex: chapterCounter,
      chapterTitle,
      chapterText: bodyText,
      charCount: bodyText.length,
    });

    chapterCounter += 1;
  }

  if (!chapters.length) {
    throw new Error("No valid chapter content found in this EPUB.");
  }

  return { bookTitle, chapters };
}

export default function Home() {
  const abortControllerRef = useRef<AbortController | null>(null);

  const [apiKey, setApiKey] = useState("");
  const [baselineModel, setBaselineModel] = useState(DEFAULT_BASELINE_MODEL);
  const [detailLevel, setDetailLevel] = useState<DetailLevel>("balanced");
  const [maxChapters, setMaxChapters] = useState("0");
  const [passCount, setPassCount] = useState<1 | 2 | 3>(1);
  const [useAdvancedRouting, setUseAdvancedRouting] = useState(false);
  const [modelRouting, setModelRouting] = useState<ModelRouting>({ ...DEFAULT_MODEL_ROUTING });

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

  const activeModels = useMemo(
    () => resolveActiveModels(baselineModel, useAdvancedRouting, modelRouting),
    [baselineModel, useAdvancedRouting, modelRouting],
  );

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

  const effectiveChapterCount = useMemo(() => {
    if (!parsedBookCache) return 0;
    const chapterLimit = Number(maxChapters);
    if (Number.isFinite(chapterLimit) && chapterLimit > 0) {
      return Math.min(chapterLimit, parsedBookCache.chapters.length);
    }
    return parsedBookCache.chapters.length;
  }, [parsedBookCache, maxChapters]);

  const estimate = useMemo<PreRunEstimate | null>(() => {
    if (!parsedBookCache) return null;

    const chapterLimit = Number(maxChapters);
    const selected =
      Number.isFinite(chapterLimit) && chapterLimit > 0
        ? parsedBookCache.chapters.slice(0, chapterLimit)
        : parsedBookCache.chapters;

    if (!selected.length) return null;

    const calls = selected.length * passCount + 1;
    const targets = completionTargets(detailLevel);

    const buckets: Record<string, { prompt: number; completion: number }> = {};
    const add = (model: string, promptTokens: number, completionTokens: number) => {
      if (!buckets[model]) {
        buckets[model] = { prompt: 0, completion: 0 };
      }
      buckets[model].prompt += promptTokens;
      buckets[model].completion += completionTokens;
    };

    for (const chapter of selected) {
      const chapterTokens = charsToTokens(chapter.charCount);
      const p1Prompt = chapterTokens + 420;
      const p1Completion = targets.passOne;
      add(activeModels.passOneModel, p1Prompt, p1Completion);

      if (passCount >= 2) {
        const p2Prompt = chapterTokens + p1Completion + 380;
        const p2Completion = targets.passTwo;
        add(activeModels.passTwoModel, p2Prompt, p2Completion);
      }

      if (passCount >= 3) {
        const p3Prompt = targets.passOne + targets.passTwo + 320;
        const p3Completion = targets.passThree;
        add(activeModels.passThreeModel, p3Prompt, p3Completion);
      }
    }

    const perChapterOutput = passCount === 1 ? targets.passOne : passCount === 2 ? targets.passTwo : targets.passThree;
    const synthesisPrompt = selected.length * perChapterOutput + 600;
    add(activeModels.synthesisModel, synthesisPrompt, targets.synthesis);

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
      callCount: calls,
      selectedPassCount: passCount,
      approxCostUsd: missing.length ? null : totalCost,
      missingPricingModels: missing,
    };
  }, [parsedBookCache, maxChapters, passCount, detailLevel, activeModels, pricingMap]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as {
        baselineModel?: string;
        detailLevel?: DetailLevel;
        maxChapters?: string;
        passCount?: number;
        useAdvancedRouting?: boolean;
        modelRouting?: Partial<ModelRouting>;
      };

      if (parsed.baselineModel) setBaselineModel(parsed.baselineModel);
      if (parsed.detailLevel) setDetailLevel(parsed.detailLevel);
      if (typeof parsed.maxChapters === "string") setMaxChapters(parsed.maxChapters);
      if (typeof parsed.passCount === "number") setPassCount(parsePassCount(parsed.passCount));
      if (typeof parsed.useAdvancedRouting === "boolean") {
        setUseAdvancedRouting(parsed.useAdvancedRouting);
      }

      if (parsed.modelRouting) {
        setModelRouting((previous) => ({
          ...previous,
          ...parsed.modelRouting,
        }));
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
          baselineModel,
          detailLevel,
          maxChapters,
          passCount,
          useAdvancedRouting,
          modelRouting,
        }),
      );
    } catch {
      // ignore write failures
    }
  }, [baselineModel, detailLevel, maxChapters, passCount, useAdvancedRouting, modelRouting]);

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

  const updateModelRouting = (field: keyof ModelRouting, value: string) => {
    setModelRouting((previous) => ({ ...previous, [field]: value }));
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
      setStatusLine(`Ready. Detected ${parsed.chapters.length} chapters.`);
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

    if (!apiKey.trim()) {
      setError("OpenRouter API key is required.");
      return;
    }

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
              apiKey: string;
              model: string;
              chapterTitle: string;
              chapterText: string;
              chapterIndex: number;
              totalChapters: number;
              detailLevel: DetailLevel;
              passCount: number;
              promptConfig: PromptConfig;
              modelRouting: ModelRouting;
            },
            {
              passOne?: string;
              passTwo?: string;
              passThree?: string;
              finalSummary?: string;
              truncated?: boolean;
              originalChars?: number;
              processedChars?: number;
            }
          >(
            "/api/summarize-chapter",
            {
              apiKey: apiKey.trim(),
              model: baselineModel.trim(),
              chapterTitle: chapter.chapterTitle,
              chapterText: chapter.chapterText,
              chapterIndex: chapter.chapterIndex,
              totalChapters: selectedChapters.length,
              detailLevel,
              passCount,
              promptConfig,
              modelRouting: activeModels,
            },
            runController.signal,
          );

          updateChapter(chapter.chapterIndex, {
            status: "done",
            passOne: payload.passOne,
            passTwo: payload.passTwo,
            passThree: payload.passThree,
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
            apiKey: string;
            model: string;
            bookTitle: string;
            chapterSummaries: Array<{ chapterIndex: number; chapterTitle: string; summary: string }>;
            promptConfig: PromptConfig;
            modelRouting: ModelRouting;
          },
          {
            finalSynthesis?: string;
            error?: string;
          }
        >(
          "/api/synthesize-book",
          {
            apiKey: apiKey.trim(),
            model: baselineModel.trim(),
            bookTitle: parsed.bookTitle,
            chapterSummaries: doneNow,
            promptConfig,
            modelRouting: activeModels,
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
      baselineModel,
      activeModels,
      detailLevel,
      passCount,
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
            Upload an EPUB, run chapter compression in configurable passes, and download
            structured output. Processing is transient and designed without content persistence.
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
              Baseline defaults to Claude Haiku. Use Fast mode for lower cost.
            </p>

            <form onSubmit={handleCompress}>
              <label className="field">
                <span className="field__label">OpenRouter API Key</span>
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-or-v1-..."
                />
              </label>

              <label className="field">
                <span className="field__label">Baseline Model</span>
                <input
                  className="input"
                  type="text"
                  value={baselineModel}
                  onChange={(event) => setBaselineModel(event.target.value)}
                  placeholder={DEFAULT_BASELINE_MODEL}
                />
                <p className="hint">Default: anthropic/claude-haiku-4.5</p>
              </label>

              <div className="field">
                <span className="field__label">Pass Mode</span>
                <select
                  className="select"
                  value={passCount}
                  onChange={(event) => setPassCount(parsePassCount(Number(event.target.value)))}
                >
                  <option value={1}>1 Pass (Fast, cheapest)</option>
                  <option value={2}>2 Passes (Balanced)</option>
                  <option value={3}>3 Passes (Deep quality)</option>
                </select>
              </div>

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
                  <strong>Pre-run estimate:</strong> {estimate.chapterCount} chapters · {estimate.selectedPassCount} pass(es)
                  · about {estimate.callCount} model calls.
                  {estimate.approxCostUsd !== null ? (
                    <> Estimated cost: ~${estimate.approxCostUsd.toFixed(2)}.</>
                  ) : (
                    <> Cost unavailable for one or more selected models.</>
                  )}
                  {estimate.callCount > 80 ? (
                    <>
                      {" "}High-call run detected. Consider lowering max chapters or using fewer passes.
                    </>
                  ) : null}
                </div>
              ) : null}

              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={useAdvancedRouting}
                  onChange={(event) => setUseAdvancedRouting(event.target.checked)}
                />
                <span>Enable advanced per-pass model routing</span>
              </label>

              {useAdvancedRouting ? (
                <div className="prompt-grid" style={{ marginBottom: 14 }}>
                  <label className="field">
                    <span className="field__label">Pass 1 Model</span>
                    <input
                      className="input"
                      type="text"
                      value={modelRouting.passOneModel}
                      onChange={(event) => updateModelRouting("passOneModel", event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Pass 2 Model</span>
                    <input
                      className="input"
                      type="text"
                      value={modelRouting.passTwoModel}
                      onChange={(event) => updateModelRouting("passTwoModel", event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Pass 3 Model</span>
                    <input
                      className="input"
                      type="text"
                      value={modelRouting.passThreeModel}
                      onChange={(event) => updateModelRouting("passThreeModel", event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">Book Synthesis Model</span>
                    <input
                      className="input"
                      type="text"
                      value={modelRouting.synthesisModel}
                      onChange={(event) => updateModelRouting("synthesisModel", event.target.value)}
                    />
                  </label>
                </div>
              ) : null}

              <details className="prompt-editor" open>
                <summary className="prompt-editor__summary">Prompt Modules (Editable Before Run)</summary>
                <p className="hint">
                  Edit prompts for this run. Reloading the page resets prompt text to defaults.
                </p>
                <p className="prompt-vars">
                  Placeholder variables: {"{{chapter_index}}"}, {"{{total_chapters}}"}, {"{{chapter_title}}"},{" "}
                  {"{{target_length}}"}, {"{{chapter_text}}"}, {"{{pass_one_output}}"},{" "}
                  {"{{pass_two_output}}"}, {"{{book_title}}"}, {"{{chapter_summaries}}"}
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
                Start a run to see chapter-by-chapter output. Current mode: {passCount} pass(es).
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
