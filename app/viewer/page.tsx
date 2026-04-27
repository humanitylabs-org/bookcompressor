"use client";

import { useMemo, useState } from "react";
import JSZip from "jszip";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

type ViewerChapter = {
  id: string;
  index: number;
  title: string;
  filename: string;
  content: string;
};

type SummaryChapter = {
  chapterIndex?: number;
  chapterTitle?: string;
  summary?: string;
};

type SummaryPayload = {
  bookTitle?: string;
  chapters?: SummaryChapter[];
  generatedAt?: string;
};

function extractChapterIndex(filename: string): number {
  const base = filename.split("/").pop() || "";
  const match = base.match(/^(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function titleFromMarkdown(content: string): string | null {
  const heading = content.match(/^#\s+Chapter\s+\d+\s*:\s*(.+)$/im);
  if (heading?.[1]) return heading[1].trim();

  const genericHeading = content.match(/^#\s+(.+)$/im);
  if (genericHeading?.[1]) return genericHeading[1].trim();

  return null;
}

function titleFromFilename(filename: string): string {
  const base = filename.split("/").pop()?.replace(/\.md$/i, "") || filename;
  const withoutPrefix = base.replace(/^\d+[-_]?/, "");
  return withoutPrefix
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || base;
}

export default function ViewerPage() {
  const [bookTitle, setBookTitle] = useState("");
  const [chapters, setChapters] = useState<ViewerChapter[]>([]);
  const [bookCompression, setBookCompression] = useState("");
  const [summaryMeta, setSummaryMeta] = useState<SummaryPayload | null>(null);
  const [selectedChapterId, setSelectedChapterId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const selectedChapterIndex = useMemo(
    () => chapters.findIndex((chapter) => chapter.id === selectedChapterId),
    [chapters, selectedChapterId],
  );

  const selectedChapter = selectedChapterIndex >= 0 ? chapters[selectedChapterIndex] : null;

  const prevChapter = selectedChapterIndex > 0 ? chapters[selectedChapterIndex - 1] : null;
  const nextChapter =
    selectedChapterIndex >= 0 && selectedChapterIndex < chapters.length - 1
      ? chapters[selectedChapterIndex + 1]
      : null;

  const handleZipUpload = async (file: File | null) => {
    if (!file) return;

    setIsLoading(true);
    setError(null);

    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());

      const summaryFile = zip.file("summary.json");
      let summary: SummaryPayload | null = null;
      if (summaryFile) {
        try {
          summary = JSON.parse(await summaryFile.async("text")) as SummaryPayload;
        } catch {
          summary = null;
        }
      }

      const bookCompressionFile = zip.file("book-compression.md");
      const compressionContent = bookCompressionFile
        ? await bookCompressionFile.async("text")
        : "";

      const chapterFiles = Object.keys(zip.files)
        .filter((path) => path.startsWith("chapters/") && path.toLowerCase().endsWith(".md"))
        .sort((a, b) => extractChapterIndex(a) - extractChapterIndex(b) || a.localeCompare(b));

      const summaryMap = new Map<number, string>();
      if (summary?.chapters?.length) {
        summary.chapters.forEach((chapter) => {
          if (typeof chapter.chapterIndex === "number" && chapter.chapterTitle) {
            summaryMap.set(chapter.chapterIndex, chapter.chapterTitle);
          }
        });
      }

      const loadedChapters: ViewerChapter[] = [];
      for (const path of chapterFiles) {
        const chapterFile = zip.file(path);
        if (!chapterFile) continue;

        const content = await chapterFile.async("text");
        const index = extractChapterIndex(path);

        const resolvedTitle =
          summaryMap.get(index) || titleFromMarkdown(content) || titleFromFilename(path);

        loadedChapters.push({
          id: path,
          index: Number.isFinite(index) ? index : loadedChapters.length + 1,
          title: resolvedTitle,
          filename: path,
          content,
        });
      }

      if (!loadedChapters.length && !compressionContent) {
        throw new Error("This ZIP does not contain viewer-compatible markdown files.");
      }

      setBookTitle(summary?.bookTitle || file.name.replace(/\.zip$/i, "") || "Book Compression");
      setSummaryMeta(summary);
      setBookCompression(compressionContent);
      setChapters(loadedChapters);
      setSelectedChapterId(loadedChapters[0]?.id || null);
      setMobileMenuOpen(false);
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Failed to parse ZIP.";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="bcv-page">
      <header className="bcv-header">
        <div className="bcv-header__left">
          <h1 className="bcv-title">Book Compressor Viewer</h1>
          <p className="bcv-subtitle">Upload a result ZIP and browse chapters beautifully.</p>
        </div>

        <div className="bcv-header__actions">
          <Link className="bcv-link" href="/">
            Back to Compressor
          </Link>

          <label className="bcv-upload-btn">
            {isLoading ? "Loading ZIP..." : "Upload ZIP"}
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                void handleZipUpload(event.target.files?.[0] || null);
              }}
              disabled={isLoading}
            />
          </label>
        </div>
      </header>

      {error ? <div className="bcv-alert bcv-alert--error">{error}</div> : null}

      {!chapters.length && !bookCompression ? (
        <section className="bcv-empty">
          <p>Upload the ZIP produced by Book Compressor to start viewing.</p>
          <p className="bcv-empty__hint">
            Expected files: <code>summary.json</code>, <code>chapters/*.md</code>,
            <code> book-compression.md</code>
          </p>
        </section>
      ) : (
        <div className="bcv-shell">
          <button
            className="bcv-mobile-toggle"
            type="button"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            {mobileMenuOpen ? "Close Chapters" : "Open Chapters"}
          </button>

          <aside className={`bcv-sidebar ${mobileMenuOpen ? "bcv-sidebar--open" : ""}`}>
            <button
              className={`bcv-nav-item ${selectedChapterId === null ? "bcv-nav-item--active" : ""}`}
              type="button"
              onClick={() => {
                setSelectedChapterId(null);
                setMobileMenuOpen(false);
              }}
            >
              <span>Book Compression</span>
            </button>

            <div className="bcv-sidebar__label">Chapters</div>
            <div className="bcv-nav-list">
              {chapters.map((chapter) => (
                <button
                  key={chapter.id}
                  className={`bcv-nav-item ${chapter.id === selectedChapterId ? "bcv-nav-item--active" : ""}`}
                  type="button"
                  onClick={() => {
                    setSelectedChapterId(chapter.id);
                    setMobileMenuOpen(false);
                  }}
                >
                  <span className="bcv-nav-item__index">{chapter.index}</span>
                  <span className="bcv-nav-item__title">{chapter.title}</span>
                </button>
              ))}
            </div>
          </aside>

          <main className="bcv-main">
            <section className="bcv-main__meta">
              <h2>{bookTitle || "Book Compression"}</h2>
              <p>
                {chapters.length} chapter{chapters.length === 1 ? "" : "s"}
                {summaryMeta?.generatedAt
                  ? ` · generated ${new Date(summaryMeta.generatedAt).toLocaleString()}`
                  : ""}
              </p>
            </section>

            {selectedChapter ? (
              <>
                <section className="bcv-main__heading">
                  <h3>
                    Chapter {selectedChapter.index}: {selectedChapter.title}
                  </h3>
                </section>

                <article className="bcv-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                    {selectedChapter.content}
                  </ReactMarkdown>
                </article>

                <section className="bcv-main__pager">
                  <button
                    className="bcv-pager-btn"
                    type="button"
                    disabled={!prevChapter}
                    onClick={() => {
                      if (!prevChapter) return;
                      setSelectedChapterId(prevChapter.id);
                    }}
                  >
                    ← Previous
                  </button>

                  <button
                    className="bcv-pager-btn"
                    type="button"
                    disabled={!nextChapter}
                    onClick={() => {
                      if (!nextChapter) return;
                      setSelectedChapterId(nextChapter.id);
                    }}
                  >
                    Next →
                  </button>
                </section>
              </>
            ) : (
              <article className="bcv-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {bookCompression || "No book-compression.md content available in this ZIP."}
                </ReactMarkdown>
              </article>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
