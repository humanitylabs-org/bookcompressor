import type { MetadataRoute } from "next";

function normalizeBasePath(input: string | undefined): string {
  const raw = (input || "").trim();
  if (!raw || raw === "/") return "";
  const clean = raw.replace(/^\/+|\/+$/g, "");
  return clean ? `/${clean}` : "";
}

export default function manifest(): MetadataRoute.Manifest {
  const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH || "/bookcompressor");
  const scopedRoot = basePath ? `${basePath}/` : "/";

  return {
    name: "Book Compressor",
    short_name: "BookComp",
    description:
      "Chat-first EPUB compression with host-managed AI inference, local permalinks, and web upload fallback.",
    id: scopedRoot,
    start_url: scopedRoot,
    scope: scopedRoot,
    display: "standalone",
    background_color: "#0b0b0d",
    theme_color: "#0b0b0d",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}

