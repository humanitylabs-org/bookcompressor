import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
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

type RuntimeProvider = "auto" | "hermes" | "openclaw" | "openrouter" | "agent-command";
type ExecutedProvider = Exclude<RuntimeProvider, "auto">;

export type InferenceResult = {
  text: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  provider: ExecutedProvider;
  modelUsed?: string;
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

const DEFAULT_PROVIDER: RuntimeProvider = "auto";
const DEFAULT_TIMEOUT_MS = 300_000;
const PROMPT_RUNTIME_DIR = path.join(process.cwd(), ".runtime", "prompts");
const OPENROUTER_KEY_ENV_CANDIDATES = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_KEY",
  "OPENROUTER_API_TOKEN",
  "AI_API_KEY",
  "LLM_API_KEY",
];

function resolveProvider(): RuntimeProvider {
  const raw = (process.env.BOOK_COMPRESSOR_INFERENCE_PROVIDER || DEFAULT_PROVIDER)
    .trim()
    .toLowerCase();

  if (["hermes", "openclaw", "openrouter", "auto"].includes(raw)) return raw as RuntimeProvider;
  if (["command", "custom", "agent", "agent-command", "agent_command"].includes(raw)) return "agent-command";
  return DEFAULT_PROVIDER;
}

function normalizeModel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function configuredTimeoutMs(): number {
  const configuredTimeout = Number(process.env.BOOK_COMPRESSOR_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
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

function extractHermesText(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .filter((line) => !/^session_id:\s*/i.test(line.trim()));
  const text = lines.join("\n").trim();
  if (!text) throw new Error("Hermes returned empty output.");
  return text;
}

function hasOpenRouterKey(): boolean {
  return OPENROUTER_KEY_ENV_CANDIDATES.some((name) => Boolean(process.env[name]?.trim()));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "Unknown error.");
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { timeout: 10_000, maxBuffer: 256 * 1024 });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code !== "ENOENT";
  }
}

async function callViaHermes({ model, messages }: InferenceCallOptions): Promise<InferenceResult> {
  const prompt = buildPrompt(messages);
  const timeoutMs = configuredTimeoutMs();
  const requestedModel = normalizeModel(model);
  const args = [
    "chat",
    "-q",
    prompt,
    "-Q",
    "--ignore-rules",
    "--max-turns",
    "1",
    "--source",
    "bookcompressor",
  ];

  const hermesProvider = process.env.BOOK_COMPRESSOR_HERMES_PROVIDER?.trim();
  if (hermesProvider) args.push("--provider", hermesProvider);
  if (requestedModel) args.push("--model", requestedModel);

  try {
    const { stdout } = await execFileAsync("hermes", args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs + 30_000,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
    });

    return {
      text: extractHermesText(stdout),
      provider: "hermes",
      modelUsed: requestedModel,
    };
  } catch (error) {
    throw new Error(`Hermes inference failed: ${stringifyError(error)}`);
  }
}

async function callViaOpenClawGateway({
  model,
  messages,
}: InferenceCallOptions): Promise<InferenceResult> {
  const prompt = buildPrompt(messages);
  const promptId = randomUUID();
  const promptPath = path.join(PROMPT_RUNTIME_DIR, `prompt-${promptId}.txt`);
  const requestedModel = normalizeModel(model);
  const timeoutMs = configuredTimeoutMs();
  const timeoutSeconds = Math.max(30, Math.ceil(timeoutMs / 1000));

  await fs.mkdir(PROMPT_RUNTIME_DIR, { recursive: true });
  await fs.writeFile(promptPath, prompt, "utf8");

  const agentMessage = [
    "Use the read tool to read this file first:",
    promptPath,
    "",
    "Then execute the task exactly as written in that file.",
    "Return only the requested output text, with no preface or commentary.",
  ].join("\n");

  const args = [
    "agent",
    "--json",
    "--thinking",
    "off",
    "--verbose",
    "off",
    "--session-id",
    `bookcompressor-gateway-${promptId}`,
    "--message",
    agentMessage,
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
      throw new Error(payload.error || "OpenClaw gateway agent run returned no text output.");
    }

    return {
      text,
      provider: "openclaw",
      modelUsed: payload.result?.meta?.agentMeta?.model || payload.meta?.agentMeta?.model || requestedModel,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown inference error.";
    throw new Error(`OpenClaw gateway-agent inference failed: ${detail}`);
  } finally {
    await fs.rm(promptPath, { force: true }).catch(() => {
      // non-fatal cleanup failure
    });
  }
}

async function callViaOpenClawAgentLocal({
  model,
  messages,
}: InferenceCallOptions): Promise<InferenceResult> {
  const prompt = buildPrompt(messages);
  const promptId = randomUUID();
  const promptPath = path.join(PROMPT_RUNTIME_DIR, `prompt-${promptId}.txt`);
  const requestedModel = normalizeModel(model);
  const timeoutMs = configuredTimeoutMs();
  const timeoutSeconds = Math.max(30, Math.ceil(timeoutMs / 1000));

  await fs.mkdir(PROMPT_RUNTIME_DIR, { recursive: true });
  await fs.writeFile(promptPath, prompt, "utf8");

  const agentMessage = [
    "Use the read tool to read this file first:",
    promptPath,
    "",
    "Then execute the task exactly as written in that file.",
    "Return only the requested output text, with no preface or commentary.",
  ].join("\n");

  const args = [
    "agent",
    "--local",
    "--json",
    "--thinking",
    "off",
    "--verbose",
    "off",
    "--session-id",
    `bookcompressor-${promptId}`,
    "--message",
    agentMessage,
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
  } finally {
    await fs.rm(promptPath, { force: true }).catch(() => {
      // non-fatal cleanup failure
    });
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

function splitArgs(input: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) args.push(match[1] ?? match[2] ?? match[3] ?? "");
  return args;
}

function parseAgentArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return ["{prompt}"];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
  } catch {
    // Fall back to a small shell-like splitter for simple commands.
  }
  return splitArgs(raw);
}

function replacePlaceholders(value: string, replacements: Record<string, string>): string {
  return value.replace(/\{(prompt|promptFile|model|timeoutSeconds)\}/g, (_match, key: string) => replacements[key] || "");
}

function parseAgentCommandOutput(stdout: string): string {
  const mode = (process.env.BOOK_COMPRESSOR_AGENT_OUTPUT_MODE || "stdout").trim().toLowerCase();
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Agent command returned empty output.");

  if (["last-line", "last_nonempty_line", "last-nonempty-line"].includes(mode)) {
    const last = trimmed.split(/\r?\n/).filter((line) => line.trim()).at(-1)?.trim();
    if (!last) throw new Error("Agent command returned no non-empty output line.");
    return last;
  }

  if (mode === "json") {
    const parsed = parseJsonOutput<{ text?: string; output?: string; content?: string }>(trimmed, "Agent command");
    const text = parsed.text || parsed.output || parsed.content;
    if (!text?.trim()) throw new Error("Agent command JSON did not contain text, output, or content.");
    return text.trim();
  }

  return trimmed;
}

async function callViaAgentCommand({ model, messages }: InferenceCallOptions): Promise<InferenceResult> {
  const command = process.env.BOOK_COMPRESSOR_AGENT_COMMAND?.trim();
  if (!command) {
    throw new Error("BOOK_COMPRESSOR_AGENT_COMMAND is required when using agent-command provider.");
  }

  const prompt = buildPrompt(messages);
  const promptId = randomUUID();
  const promptPath = path.join(PROMPT_RUNTIME_DIR, `prompt-${promptId}.txt`);
  const requestedModel = normalizeModel(model) || "";
  const timeoutMs = configuredTimeoutMs();
  const timeoutSeconds = String(Math.max(30, Math.ceil(timeoutMs / 1000)));

  await fs.mkdir(PROMPT_RUNTIME_DIR, { recursive: true });
  await fs.writeFile(promptPath, prompt, "utf8");

  const replacements = {
    prompt,
    promptFile: promptPath,
    model: requestedModel,
    timeoutSeconds,
  };
  const args = parseAgentArgs(process.env.BOOK_COMPRESSOR_AGENT_ARGS).map((arg) =>
    replacePlaceholders(arg, replacements),
  );

  try {
    const { stdout } = await execFileAsync(command, args, {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs + 30_000,
      env: {
        ...process.env,
        BOOK_COMPRESSOR_PROMPT: prompt,
        BOOK_COMPRESSOR_PROMPT_FILE: promptPath,
        BOOK_COMPRESSOR_MODEL: requestedModel,
      },
    });

    return {
      text: parseAgentCommandOutput(stdout),
      provider: "agent-command",
      modelUsed: requestedModel || undefined,
    };
  } catch (error) {
    throw new Error(`Agent command inference failed: ${stringifyError(error)}`);
  } finally {
    await fs.rm(promptPath, { force: true }).catch(() => {
      // non-fatal cleanup failure
    });
  }
}

async function callViaAuto(options: InferenceCallOptions): Promise<InferenceResult> {
  const errors: string[] = [];

  const attempts: Array<[ExecutedProvider, () => Promise<InferenceResult>, () => Promise<boolean> | boolean]> = [
    ["agent-command", () => callViaAgentCommand(options), () => Boolean(process.env.BOOK_COMPRESSOR_AGENT_COMMAND?.trim())],
    ["hermes", () => callViaHermes(options), () => commandExists("hermes")],
    ["openclaw", () => callViaOpenClaw(options), () => commandExists("openclaw")],
    ["openrouter", () => callViaOpenRouter(options), () => hasOpenRouterKey()],
  ];

  for (const [name, run, enabled] of attempts) {
    if (!(await enabled())) continue;
    try {
      return await run();
    } catch (error) {
      errors.push(`${name}: ${stringifyError(error)}`);
    }
  }

  throw new Error(
    [
      "No Book Compressor inference provider succeeded.",
      "Set BOOK_COMPRESSOR_INFERENCE_PROVIDER to hermes, openclaw, openrouter, or agent-command.",
      "For custom agents, also set BOOK_COMPRESSOR_AGENT_COMMAND and optionally BOOK_COMPRESSOR_AGENT_ARGS.",
      errors.length ? `Attempted providers: ${errors.join(" | ")}` : "No supported provider was detected.",
    ].join(" "),
  );
}

export async function callInference(options: InferenceCallOptions): Promise<InferenceResult> {
  const provider = resolveProvider();

  if (provider === "hermes") return callViaHermes(options);
  if (provider === "openrouter") return callViaOpenRouter(options);
  if (provider === "agent-command") return callViaAgentCommand(options);
  if (provider === "openclaw") return callViaOpenClaw(options);

  return callViaAuto(options);
}
