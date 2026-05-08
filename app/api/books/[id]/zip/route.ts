import { NextResponse } from "next/server";
import { buildBookZip, getBook } from "@/lib/book-store";

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

    const { buffer, filename } = await buildBookZip(book);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build ZIP.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

