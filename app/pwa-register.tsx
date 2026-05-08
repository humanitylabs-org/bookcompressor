"use client";

import { useEffect } from "react";

function normalizeBasePath(input: string | undefined): string {
  const raw = (input || "").trim();
  if (!raw || raw === "/") return "";
  const clean = raw.replace(/^\/+|\/+$/g, "");
  return clean ? `/${clean}` : "";
}

export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
    const swUrl = `${basePath}/sw.js`;
    const scope = `${basePath || ""}/`;

    navigator.serviceWorker.register(swUrl, { scope }).catch(() => {
      // non-fatal
    });
  }, []);

  return null;
}

