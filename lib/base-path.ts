function normalizeBasePath(input: string | undefined): string {
  const raw = (input || "").trim();
  if (!raw || raw === "/") return "";

  const withoutSlashes = raw.replace(/^\/+|\/+$/g, "");
  return withoutSlashes ? `/${withoutSlashes}` : "";
}

export const APP_BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

export function withBasePath(path: string): string {
  if (!path.startsWith("/")) {
    throw new Error("withBasePath expects an absolute path starting with '/'.");
  }

  return `${APP_BASE_PATH}${path}`;
}

