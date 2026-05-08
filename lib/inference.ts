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
  provider: "openclaw" | "openrouter";
  modelUsed?: string;
};

type OpenClawModelRunPayload = {
  ok?: boolean;
  model?: string;
  outputs?: Array<{
    text?: string;
  }>;
  error?: string;
};

const DEFAULT_PROVIDER = "openclaw";

function resolveProvider(): "openclaw" | "openrouter" {
  const raw = (process.env.BOOK_COMPRESSOR_INFERENCE_PROVIDER || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();

  if (raw === "openrouter") return "openrouter";
  return "openclaw";
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

function parseOpenClawModelRunOutput(stdout: string): OpenClawModelRunPayload {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("OpenClaw inference returned empty output.");
  }

  try {
    return JSON.parse(trimmed) as OpenClawModelRunPayload;
  } catch {
    throw new Error(`OpenClaw inference returned non-JSON output: ${trimmed.slice(0, 240)}`);
  }
}

async function callViaOpenClawGateway({
  model,
  messages,
}: InferenceCallOptions): Promise<InferenceResult> {
  const prompt = buildPrompt(messages);

  const args = ["capability", "model", "run", "--gateway", "--json", "--prompt", prompt];
  const requestedModel = normalizeModel(model);
  if (requestedModel) {
    args.push("--model", requestedModel);
  }

  const timeoutMs = Number(process.env.BOOK_COMPRESSOR_AI_TIMEOUT_MS || 300_000);

  try {
    const { stdout } = await execFileAsync("openclaw", args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });

    const payload = parseOpenClawModelRunOutput(stdout);
    const text = payload.outputs?.find((entry) => typeof entry.text === "string")?.text?.trim();

    if (!payload.ok || !text) {
      throw new Error(payload.error || "OpenClaw inference returned no text output.");
    }

    return {
      text,
      provider: "openclaw",
      modelUsed: payload.model || requestedModel,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown inference error.";
    throw new Error(`OpenClaw inference failed: ${detail}`);
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

  return callViaOpenClawGateway(options);
}

