import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callOpenRouter } from "@/lib/openrouter";

const execFileAsync = promisify(execFile);

export type InferenceMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type InferenceCallOptions = {
  model?: string;
  messages: InferenceMessage[];
  temperature?: number;
  maxTokens?: number;
};

export type InferenceResult = {
  text: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  provider: "hermes" | "openrouter";
  modelUsed?: string;
};

const DEFAULT_PROVIDER = "hermes";
const DEFAULT_TIMEOUT_MS = 300_000;

function resolveProvider(): "hermes" | "openrouter" {
  const raw = (process.env.BOOK_COMPRESSOR_INFERENCE_PROVIDER || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();

  if (raw === "openrouter") return "openrouter";
  return "hermes";
}

function normalizeModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function buildPrompt(messages: InferenceMessage[]): string {
  const blocks = messages
    .filter((entry) => entry.content?.trim())
    .map((entry) => `### ${entry.role.toUpperCase()}\n${entry.content.trim()}`)
    .join("\n\n");

  return [
    "Use the SYSTEM instructions as authoritative. Then complete the USER request.",
    "Return only the requested output.",
    "",
    blocks,
  ].join("\n");
}

async function callViaHermes({
  model,
  messages,
}: InferenceCallOptions): Promise<InferenceResult> {
  const prompt = buildPrompt(messages);
  const requestedModel = normalizeModel(model);
  const hermesBin = process.env.BOOK_COMPRESSOR_HERMES_BIN?.trim() || "hermes";

  const configuredTimeout = Number(process.env.BOOK_COMPRESSOR_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;

  const args = [
    "chat",
    "-Q",
    "--ignore-rules",
    "-t",
    "safe",
    "--source",
    "tool",
    "--reasoning",
    "none",
    "--max-turns",
    "1",
    "--in",
    process.cwd(),
    "-q",
    prompt,
  ];

  if (requestedModel) {
    args.push("--model", requestedModel);
  }

  try {
    const { stdout } = await execFileAsync(hermesBin, args, {
      cwd: process.cwd(),
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs + 30_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });

    const text = stdout.trim();
    if (!text) {
      throw new Error("Hermes returned no text output.");
    }

    return {
      text,
      provider: "hermes",
      modelUsed: requestedModel,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown inference error.";
    throw new Error(`Hermes inference failed: ${detail}`);
  }
}

async function callViaOpenRouter({
  model,
  messages,
  temperature,
  maxTokens,
}: InferenceCallOptions): Promise<InferenceResult> {
  const fallbackModel =
    process.env.BOOK_COMPRESSOR_OPENROUTER_DEFAULT_MODEL || "anthropic/claude-haiku-4.5";

  const response = await callOpenRouter({
    model: normalizeModel(model) || fallbackModel,
    messages,
    temperature,
    maxTokens,
  });

  return {
    text: response.text,
    usage: response.usage,
    provider: "openrouter",
    modelUsed: normalizeModel(model) || fallbackModel,
  };
}

export async function callInference(options: InferenceCallOptions): Promise<InferenceResult> {
  const provider = resolveProvider();

  if (provider === "openrouter") {
    return callViaOpenRouter(options);
  }

  return callViaHermes(options);
}
