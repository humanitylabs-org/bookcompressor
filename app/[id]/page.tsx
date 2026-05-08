import { notFound } from "next/navigation";
import { getBook } from "@/lib/book-store";
import PermalinkView from "./permalink-view";

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
    <PermalinkView
      book={{
        id: book.id,
        bookTitle: book.bookTitle,
        createdAt: book.createdAt,
        synthesis: book.synthesis || null,
        chapters: book.chapters,
      }}
    />
  );
}
