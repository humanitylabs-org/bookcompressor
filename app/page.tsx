"use client";

import { FormEvent, useMemo, useState } from "react";
import JSZip from "jszip";
import slugify from "slugify";
import type { DetailLevel } from "@/lib/prompts";

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
  truncated?: boolean;
  originalChars?: number;
  processedChars?: number;
  error?: string;
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

function statusClass(status: ChapterStatus): string {
  if (status === "running") return "badge badge--running";
  if (status === "done") return "badge badge--done";
  if (status === "failed") return "badge badge--failed";
  return "badge badge--queued";
}

export default function Home() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [detailLevel, setDetailLevel] = useState<DetailLevel>("balanced");
  const [maxChapters, setMaxChapters] = useState("0");
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [epubFile, setEpubFile] = useState<File | null>(null);

  const [bookTitle, setBookTitle] = useState("");
  const [chapterResults, setChapterResults] = useState<ChapterResult[]>([]);
  const [bookSynthesis, setBookSynthesis] = useState("");

  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState("Idle");

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

  const updateChapter = (chapterIndex: number, updates: Partial<ChapterResult>) => {
    setChapterResults((previous) =>
      previous.map((entry) =>
        entry.chapterIndex === chapterIndex ? { ...entry, ...updates } : entry,
      ),
    );
  };

  const handleCompress = async (event: FormEvent) => {
    event.preventDefault();

    setError(null);
    setBookSynthesis("");

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

    setIsRunning(true);

    try {
      setStatusLine("Parsing EPUB in your browser...");
      const parsed = await parseEpubInBrowser(epubFile);
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
        setStatusLine(`Compressing chapter ${chapter.chapterIndex}/${selectedChapters.length}...`);
        updateChapter(chapter.chapterIndex, { status: "running", error: undefined });

        try {
          const response = await fetch("/api/summarize-chapter", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              apiKey: apiKey.trim(),
              model: model.trim(),
              detailLevel,
              chapterTitle: chapter.chapterTitle,
              chapterText: chapter.chapterText,
              chapterIndex: chapter.chapterIndex,
              totalChapters: selectedChapters.length,
            }),
          });

          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error || "Chapter compression failed.");
          }

          updateChapter(chapter.chapterIndex, {
            status: "done",
            passOne: payload.passOne,
            passTwo: payload.passTwo,
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
        }
      }

      setStatusLine("Creating full-book synthesis from completed chapters...");

      if (doneNow.length) {
        const response = await fetch("/api/synthesize-book", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            apiKey: apiKey.trim(),
            model: model.trim(),
            bookTitle: parsed.bookTitle,
            chapterSummaries: doneNow,
          }),
        });

        const payload = await response.json();
        if (response.ok && payload.finalSynthesis) {
          setBookSynthesis(payload.finalSynthesis);
        } else {
          setError(payload?.error || "Book synthesis failed. Chapter outputs are still available.");
        }
      } else {
        setError("No chapters completed successfully, so book synthesis was skipped.");
      }

      setStatusLine("Done.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Compression failed.";
      setError(message);
      setStatusLine("Failed.");
    } finally {
      setIsRunning(false);
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
      model,
      detailLevel,
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
            Upload an EPUB, run a chapter-by-chapter 3-pass compression pipeline, and download
            structured outputs. This tool uses transient processing only and does not persist your
            book content.
          </p>
        </section>

        <div className="grid">
          <section className="card">
            <h2 className="card__title">Compression Setup</h2>
            <p className="card__subtitle">
              Bring your own OpenRouter key. Nothing is stored in a database and no source file is
              persisted.
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
                <span className="field__label">Model</span>
                <input
                  className="input"
                  type="text"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="openai/gpt-4o-mini"
                />
                <p className="hint">Use any OpenRouter model slug you prefer.</p>
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
                <span className="field__label">EPUB File</span>
                <input
                  className="file"
                  type="file"
                  accept=".epub,application/epub+zip"
                  onChange={(event) => setEpubFile(event.target.files?.[0] || null)}
                />
              </label>

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
                <button className="button" disabled={isRunning} type="submit">
                  {isRunning ? "Compressing..." : "Start Compression"}
                </button>
                <button
                  className="button button--ghost"
                  disabled={isRunning || !successfulChapters.length}
                  type="button"
                  onClick={handleDownloadZip}
                >
                  Download ZIP
                </button>
              </div>
            </form>

            <div className="legal">
              <p>
                <strong>Privacy:</strong> source content is processed transiently and not persisted
                by this app.
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
              {bookTitle ? `Book: ${bookTitle}` : "No book processed yet."}
            </p>

            <p className="status">Status: {statusLine}</p>
            <div className="progress" aria-label="progress">
              <div className="progress__fill" style={{ width: `${progressPercent}%` }} />
            </div>

            {!chapterResults.length ? (
              <div className="alert alert--info">
                Start a run to see chapter-by-chapter compression progress and final outputs.
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
                    {chapter.finalSummary ? <pre className="markdown">{chapter.finalSummary}</pre> : null}
                  </article>
                ))}
              </div>
            )}

            {bookSynthesis ? (
              <>
                <h3 className="card__title" style={{ marginTop: 20 }}>
                  Full Book Compression
                </h3>
                <pre className="markdown">{bookSynthesis}</pre>
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
