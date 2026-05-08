import { NextResponse } from "next/server";
import { deleteBook, getBook } from "@/lib/book-store";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const book = await getBook(id);
    if (!book) {
      return NextResponse.json({ error: "Book not found." }, { status: 404 });
    }
    return NextResponse.json({ book });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load book.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const deleted = await deleteBook(id);
    if (!deleted) {
      return NextResponse.json({ error: "Book not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete book.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

