import { NextResponse } from "next/server";
import { getBook, listBooks } from "@/lib/book-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const items = await listBooks();
    const books = (
      await Promise.all(
        items.map(async (item) => {
          const book = await getBook(item.id);
          return book;
        }),
      )
    ).filter(Boolean);

    const payload = {
      format: "book-compressor-library.v1",
      exportedAt: new Date().toISOString(),
      count: books.length,
      books,
    };

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="bookcompressor-library-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export library.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
