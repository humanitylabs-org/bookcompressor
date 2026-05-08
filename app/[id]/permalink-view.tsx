"use client";

import Link from "next/link";
import { ReactNode, TouchEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { withBasePath } from "@/lib/base-path";

type Chapter = {
  chapterIndex: number;
  chapterTitle: string;
  summary: string;
  truncated?: boolean;
  originalChars?: number;
  processedChars?: number;
};

type BookPermalinkData = {
  id: string;
  bookTitle: string;
  createdAt: string;
  chapters: Chapter[];
  synthesis?: string | null;
};

type Props = {
  book: BookPermalinkData;
};

type NavEntry =
  | {
      key: "synthesis";
      kind: "synthesis";
      label: string;
    }
  | {
      key: string;
      kind: "chapter";
      label: string;
      chapter: Chapter;
    };

const EDGE_SWIPE_TRIGGER_PX = 60;
const EDGE_START_ZONE_PX = 28;
const CLOSE_SWIPE_TRIGGER_PX = 60;

function flattenText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";

  if (Array.isArray(node)) {
    return node.map((part) => flattenText(part)).join(" ");
  }

  const children = (node as { props?: { children?: ReactNode } }).props?.children;
  return flattenText(children);
}

export default function PermalinkView({ book }: Props) {
  const edgeTouchRef = useRef<{ x: number; y: number; tracking: boolean } | null>(null);
  const drawerTouchRef = useRef<{ x: number; y: number; tracking: boolean } | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);

  const navEntries = useMemo<NavEntry[]>(() => {
    const items: NavEntry[] = [];

    if (book.synthesis?.trim()) {
      items.push({ key: "synthesis", kind: "synthesis", label: "Book synthesis" });
    }

    const sorted = [...book.chapters].sort((a, b) => a.chapterIndex - b.chapterIndex);
    sorted.forEach((chapter) => {
      items.push({
        key: `chapter-${chapter.chapterIndex}`,
        kind: "chapter",
        label: `Chapter ${chapter.chapterIndex}`,
        chapter,
      });
    });

    return items;
  }, [book.chapters, book.synthesis]);

  const [selectedKey, setSelectedKey] = useState<string>(navEntries[0]?.key || "synthesis");

  const selectedIndex = navEntries.findIndex((entry) => entry.key === selectedKey);
  const selectedEntry = selectedIndex >= 0 ? navEntries[selectedIndex] : navEntries[0] || null;
  const prevEntry = selectedIndex > 0 ? navEntries[selectedIndex - 1] : null;
  const nextEntry =
    selectedIndex >= 0 && selectedIndex < navEntries.length - 1 ? navEntries[selectedIndex + 1] : null;

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [drawerOpen]);

  const handlePageTouchStart = (event: TouchEvent) => {
    if (drawerOpen) return;
    const touch = event.touches[0];
    if (!touch) return;
    if (touch.clientX > EDGE_START_ZONE_PX) return;
    edgeTouchRef.current = { x: touch.clientX, y: touch.clientY, tracking: true };
  };

  const handlePageTouchMove = (event: TouchEvent) => {
    const start = edgeTouchRef.current;
    if (!start?.tracking) return;
    const touch = event.touches[0];
    if (!touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = Math.abs(touch.clientY - start.y);
    if (deltaY > Math.abs(deltaX)) {
      edgeTouchRef.current = null;
      return;
    }

    if (deltaX >= EDGE_SWIPE_TRIGGER_PX) {
      setDrawerOpen(true);
      edgeTouchRef.current = null;
    }
  };

  const handlePageTouchEnd = () => {
    edgeTouchRef.current = null;
  };

  const handleDrawerTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    drawerTouchRef.current = { x: touch.clientX, y: touch.clientY, tracking: true };
  };

  const handleDrawerTouchMove = (event: TouchEvent) => {
    const start = drawerTouchRef.current;
    if (!start?.tracking) return;
    const touch = event.touches[0];
    if (!touch) return;

    const deltaX = touch.clientX - start.x;
    const deltaY = Math.abs(touch.clientY - start.y);
    if (deltaY > Math.abs(deltaX)) {
      drawerTouchRef.current = null;
      return;
    }

    if (deltaX <= -CLOSE_SWIPE_TRIGGER_PX) {
      setDrawerOpen(false);
      drawerTouchRef.current = null;
    }
  };

  const handleDrawerTouchEnd = () => {
    drawerTouchRef.current = null;
  };

  const selectEntry = (key: string) => {
    setSelectedKey(key);
    setDrawerOpen(false);
  };

  const markdownComponents = {
    blockquote: ({ children }: { children?: ReactNode }) => {
      const text = flattenText(children).replace(/\s+/g, " ").trim();
      const isAiNote = /^⚠️\s*AI Note:/i.test(text);
      const isFactCheck = /^🔴\s*Fact Check:/i.test(text);

      if (isAiNote || isFactCheck) {
        return <blockquote className="bcv-ai-note">{children}</blockquote>;
      }

      return <blockquote>{children}</blockquote>;
    },
  };

  return (
    <div
      className="bcv-page"
      onTouchStart={handlePageTouchStart}
      onTouchMove={handlePageTouchMove}
      onTouchEnd={handlePageTouchEnd}
    >
      <header className="bcv-header">
        <div className="bcv-header__left">
          <button
            className="bcv-hamburger"
            type="button"
            aria-label="Open chapters"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <span />
            <span />
            <span />
          </button>

          <h1 className="bcv-title">{book.bookTitle}</h1>
          <p className="bcv-subtitle">
            Saved {new Date(book.createdAt).toLocaleString()} · {book.chapters.length} chapters
          </p>
        </div>

        <div className="bcv-header__actions">
          <Link className="bcv-link" href="/">
            Back to Library
          </Link>
          <a className="bcv-link" href={withBasePath(`/api/books/${book.id}/export`)}>
            Export JSON
          </a>
        </div>
      </header>

      <div className="bcv-shell">
        <div
          className={`bcv-backdrop ${drawerOpen ? "bcv-backdrop--visible" : ""}`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden={!drawerOpen}
        />

        <aside
          className={`bcv-sidebar ${drawerOpen ? "bcv-sidebar--open" : ""}`}
          onTouchStart={handleDrawerTouchStart}
          onTouchMove={handleDrawerTouchMove}
          onTouchEnd={handleDrawerTouchEnd}
        >
          {book.synthesis?.trim() ? (
            <button
              className={`bcv-nav-item ${selectedEntry?.key === "synthesis" ? "bcv-nav-item--active" : ""}`}
              type="button"
              onClick={() => selectEntry("synthesis")}
            >
              <span>Book synthesis</span>
            </button>
          ) : null}

          <div className="bcv-sidebar__label">Chapters</div>
          <div className="bcv-nav-list">
            {book.chapters
              .slice()
              .sort((a, b) => a.chapterIndex - b.chapterIndex)
              .map((chapter) => {
                const key = `chapter-${chapter.chapterIndex}`;
                return (
                  <button
                    key={key}
                    className={`bcv-nav-item ${selectedEntry?.key === key ? "bcv-nav-item--active" : ""}`}
                    type="button"
                    onClick={() => selectEntry(key)}
                  >
                    <span className="bcv-nav-item__index">{chapter.chapterIndex}</span>
                    <span className="bcv-nav-item__title">{chapter.chapterTitle}</span>
                  </button>
                );
              })}
          </div>
        </aside>

        <main className="bcv-main">
          <section className="bcv-main__meta">
            <h2>{selectedEntry?.kind === "chapter" ? selectedEntry.chapter.chapterTitle : "Book synthesis"}</h2>
            <p>
              {selectedIndex + 1} of {navEntries.length}
              {selectedEntry?.kind === "chapter" ? ` · chapter ${selectedEntry.chapter.chapterIndex}` : ""}
            </p>
          </section>

          {selectedEntry?.kind === "chapter" ? (
            <>
              <section className="bcv-main__heading">
                <h3>
                  Chapter {selectedEntry.chapter.chapterIndex}: {selectedEntry.chapter.chapterTitle}
                </h3>
              </section>

              <article className="bcv-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                  components={markdownComponents}
                >
                  {selectedEntry.chapter.summary}
                </ReactMarkdown>
              </article>
            </>
          ) : (
            <article className="bcv-markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                components={markdownComponents}
              >
                {book.synthesis || "No synthesis available for this run."}
              </ReactMarkdown>
            </article>
          )}

          <section className="bcv-main__pager">
            <button
              className="bcv-pager-btn"
              type="button"
              disabled={!prevEntry}
              onClick={() => {
                if (!prevEntry) return;
                selectEntry(prevEntry.key);
              }}
            >
              ← Previous
            </button>

            <button
              className="bcv-pager-btn"
              type="button"
              disabled={!nextEntry}
              onClick={() => {
                if (!nextEntry) return;
                selectEntry(nextEntry.key);
              }}
            >
              Next →
            </button>
          </section>
        </main>
      </div>
    </div>
  );
}
