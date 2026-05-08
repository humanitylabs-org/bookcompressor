import { NextResponse } from "next/server";
import slugify from "slugify";
import { getBook } from "@/lib/book-store";

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

    const safeName =
      slugify(book.bookTitle || "book", {
        lower: true,
        strict: true,
        trim: true,
      }) || "book";

    const payload = {
      format: "book-compressor-book.v1",
      exportedAt: new Date().toISOString(),
      book,
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}-${book.id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export book.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
