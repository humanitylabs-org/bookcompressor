import type { NextConfig } from "next";

function normalizeBasePath(input: string | undefined): string {
  const raw = (input || "").trim();
  if (!raw || raw === "/") return "";

  const withoutSlashes = raw.replace(/^\/+|\/+$/g, "");
  return withoutSlashes ? `/${withoutSlashes}` : "";
}

const resolvedBasePath = normalizeBasePath(
  process.env.NEXT_PUBLIC_BASE_PATH || process.env.BOOK_COMPRESSOR_BASE_PATH || "/bookcompressor",
);

const nextConfig: NextConfig = {
  basePath: resolvedBasePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: resolvedBasePath,
  },
};

export default nextConfig;
