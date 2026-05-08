import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { getBook } from "@/lib/book-store";

type PageProps = {
  params: Promise<{
    id: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function BookPermalinkPage({ params }: PageProps) {
  const { id } = await params;
  const book = await getBook(id);

  if (!book) {
    notFound();
  }

  return (
    <div className="page">
      <div className="shell">
        <section className="hero">
          <h1 className="hero__title">{book.bookTitle}</h1>
          <p className="hero__sub">
            Saved on {new Date(book.createdAt).toLocaleString()} · {book.chapters.length} chapters
          </p>
          <div className="hero__actions">
            <Link className="button button--ghost button-link" href="/">
              Back to Library
            </Link>
            <a className="button button-link" href={`/api/books/${book.id}/zip`}>
              Download ZIP
            </a>
          </div>
        </section>

        <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
          {book.synthesis?.trim() ? (
            <section className="card">
              <h2 className="card__title">Book Synthesis</h2>
              <article className="bcv-markdown bcv-inline-markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {book.synthesis}
                </ReactMarkdown>
              </article>
            </section>
          ) : null}

          <section className="card">
            <h2 className="card__title">Chapter Walkthroughs</h2>
            <div className="chapter-list">
              {book.chapters.map((chapter) => (
                <article key={`${book.id}-${chapter.chapterIndex}`} className="chapter-card">
                  <div className="chapter-card__top">
                    <h3 className="chapter-card__title">
                      Chapter {chapter.chapterIndex}: {chapter.chapterTitle}
                    </h3>
                    <span className="badge badge--done">done</span>
                  </div>
                  <article className="bcv-markdown bcv-inline-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                      {chapter.summary}
                    </ReactMarkdown>
                  </article>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

