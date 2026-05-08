import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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

type OpenClawAgentRunPayload = {
  status?: string;
  error?: string;
  payloads?: Array<{
    text?: string | null;
  }>;
  meta?: {
    agentMeta?: {
      model?: string;
    };
  };
  result?: {
    payloads?: Array<{
      text?: string | null;
    }>;
    finalAssistantVisibleText?: string;
    finalAssistantRawText?: string;
    meta?: {
      agentMeta?: {
        model?: string;
      };
    };
  };
};

const DEFAULT_PROVIDER = "openclaw";
const DEFAULT_TIMEOUT_MS = 300_000;

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

function parseJsonOutput<T>(stdout: string, contextLabel: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`${contextLabel} returned empty output.`);
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // fall through to explicit error below
      }
    }

    throw new Error(`${contextLabel} returned non-JSON output: ${trimmed.slice(0, 240)}`);
  }
}

function parseOpenClawModelRunOutput(stdout: string): OpenClawModelRunPayload {
  return parseJsonOutput<OpenClawModelRunPayload>(stdout, "OpenClaw inference");
}

function parseOpenClawAgentRunOutput(stdout: string): OpenClawAgentRunPayload {
  return parseJsonOutput<OpenClawAgentRunPayload>(stdout, "OpenClaw agent run");
}

function firstTextOutput(
  outputs?: Array<{
    text?: string | null;
  }>,
): string | undefined {
  return outputs?.find((entry) => typeof entry?.text === "string" && entry.text.trim())?.text?.trim();
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

  const configuredTimeout = Number(process.env.BOOK_COMPRESSOR_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;

  try {
    const { stdout } = await execFileAsync("openclaw", args, {
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
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

async function callViaOpenClawAgentLocal({
  model,
  messages,
}: InferenceCallOptions): Promise<InferenceResult> {
  const prompt = buildPrompt(messages);
  const requestedModel = normalizeModel(model);

  const configuredTimeout = Number(process.env.BOOK_COMPRESSOR_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  const timeoutSeconds = Math.max(30, Math.ceil(timeoutMs / 1000));

  const args = [
    "agent",
    "--local",
    "--json",
    "--session-id",
    `bookcompressor-${randomUUID()}`,
    "--message",
    prompt,
    "--timeout",
    String(timeoutSeconds),
  ];

  if (requestedModel) {
    args.push("--model", requestedModel);
  }

  try {
    const { stdout } = await execFileAsync("openclaw", args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs + 30_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });

    const payload = parseOpenClawAgentRunOutput(stdout);
    const text =
      firstTextOutput(payload.result?.payloads) ||
      firstTextOutput(payload.payloads) ||
      payload.result?.finalAssistantVisibleText?.trim() ||
      payload.result?.finalAssistantRawText?.trim();

    if (!text) {
      throw new Error(payload.error || "OpenClaw agent run returned no text output.");
    }

    return {
      text,
      provider: "openclaw",
      modelUsed: payload.result?.meta?.agentMeta?.model || payload.meta?.agentMeta?.model || requestedModel,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown inference error.";
    throw new Error(`OpenClaw local-agent inference failed: ${detail}`);
  }
}

async function callViaOpenClaw(options: InferenceCallOptions): Promise<InferenceResult> {
  try {
    return await callViaOpenClawAgentLocal(options);
  } catch (localError) {
    try {
      return await callViaOpenClawGateway(options);
    } catch (gatewayError) {
      const localDetail = localError instanceof Error ? localError.message : "Unknown local-agent error.";
      const gatewayDetail =
        gatewayError instanceof Error ? gatewayError.message : "Unknown gateway inference error.";
      throw new Error(
        `OpenClaw inference failed. Local-agent error: ${localDetail} | Gateway error: ${gatewayDetail}`,
      );
    }
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

  return callViaOpenClaw(options);
}
