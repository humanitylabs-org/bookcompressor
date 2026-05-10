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
  const scopedAsset = (asset: string) => `${scopedRoot}${asset.replace(/^\/+/, "")}`;

  return {
    name: "Book Compressor",
    short_name: "Book Compressor",
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
        src: scopedAsset("icon-192.png"),
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: scopedAsset("icon-512.png"),
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: scopedAsset("icon.svg"),
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
