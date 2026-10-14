/**
 * Thin wrapper around @google/genai. Everything that talks to Gemini goes
 * through here so retries, usage counters and the daily cap are in one place.
 *
 * The API key is read from the environment on the server only and is never
 * sent to the client.
 */
import { GoogleGenAI } from '@google/genai';
import type { Part, Schema } from '@google/genai';
import type { AgentEvent } from '@chapter-quest/shared';

/**
 * Model IDs come from env so we can swap them without a deploy.
 * TODO: verify these IDs in AI Studio before the demo — a wrong ID fails at
 * call time with a 404, not at startup.
 */
export const MODELS = {
  design: process.env.DESIGN_MODEL ?? 'gemini-4-argon',
  text: process.env.TEXT_MODEL ?? 'gemini-3.8-flash',
  fast: process.env.FAST_MODEL ?? 'gemini-3.5-flash-lite',
  image: process.env.IMAGE_MODEL ?? 'gemini-nano-banana-2.1',
  embed: process.env.EMBED_MODEL ?? 'gemini-embedding-2',
};

/**
 * Which model a text call gets. 'design' is the slow, expensive one we only
 * spend on building a world: the curriculum agent, the writers' room and the
 * draft judge.
 *
 * The Oracle (RAG answers) must never use DESIGN_MODEL. The lessons need a
 * model that visibly gets distracted at k=8 and can fall for injection in
 * unsafe mode.
 */
export type ModelRole = 'design' | 'text' | 'fast';

const ROLE_MODEL: Record<ModelRole, () => string> = {
  design: () => MODELS.design,
  text: () => MODELS.text,
  fast: () => MODELS.fast,
};

/** How long we wait on a design call before falling back to TEXT_MODEL. */
const DESIGN_TIMEOUT_MS = 60_000;

type AgentEventListener = (event: AgentEvent) => void;
const agentListeners = new Set<AgentEventListener>();

/**
 * The wrapper reports things worth putting in the build trace — today only the
 * design→text fallback. Wire this to the SSE stream when the real pipeline lands.
 */
export function onAgentEvent(listener: AgentEventListener): () => void {
  agentListeners.add(listener);
  return () => agentListeners.delete(listener);
}

function emitAgentEvent(event: AgentEvent): void {
  for (const listener of agentListeners) listener(event);
}

export interface Usage {
  calls: number;
  tokens: number;
  images: number;
}

const usage: Usage = { calls: 0, tokens: 0, images: 0 };
/** Same counters, split by model ID, so we can see where the budget went. */
const usageByModel = new Map<string, Usage>();
let usageDay = new Date().toISOString().slice(0, 10);

export function getUsage(): Usage {
  rollDay();
  return { ...usage };
}

export function getUsageByModel(): Record<string, Usage> {
  rollDay();
  return Object.fromEntries([...usageByModel].map(([model, u]) => [model, { ...u }]));
}

function forModel(model: string): Usage {
  let entry = usageByModel.get(model);
  if (!entry) {
    entry = { calls: 0, tokens: 0, images: 0 };
    usageByModel.set(model, entry);
  }
  return entry;
}

function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== usageDay) {
    usageDay = today;
    usage.calls = 0;
    usage.tokens = 0;
    usage.images = 0;
    usageByModel.clear();
  }
}

function dailyCap(): number {
  return Number(process.env.DAILY_CALL_CAP ?? 500);
}

/** Design calls are the expensive ones, so they get their own budget. */
function designDailyCap(): number {
  return Number(process.env.DESIGN_DAILY_CAP ?? 200);
}

function spendCall(model: string): void {
  rollDay();
  if (usage.calls >= dailyCap()) {
    throw new Error(
      `Daily call cap reached (${usage.calls}/${dailyCap()}). Raise DAILY_CALL_CAP or wait for UTC midnight.`,
    );
  }
  if (model === MODELS.design) {
    const designCalls = forModel(model).calls;
    if (designCalls >= designDailyCap()) {
      throw new Error(
        `Design model cap reached (${designCalls}/${designDailyCap()} on ${model}). Raise DESIGN_DAILY_CAP or wait for UTC midnight.`,
      );
    }
  }
  usage.calls += 1;
  forModel(model).calls += 1;
}

let client: GoogleGenAI | null = null;

export function gemini(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set (see .env.example)');
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

/** 429 and 5xx are worth another go; 400s are our bug and are not retried. */
function isRetryable(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string };
  const status = e?.status ?? e?.code;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(e?.message ?? '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(
  label: string,
  model: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      spendCall(model);
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) break;
      const backoff = 500 * 2 ** i + Math.floor(Math.random() * 250);
      console.warn(
        `[gemini] ${label} failed (attempt ${i + 1}/${attempts}), retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function countTokens(model: string, res: { usageMetadata?: { totalTokenCount?: number } }): void {
  const tokens = res.usageMetadata?.totalTokenCount ?? 0;
  usage.tokens += tokens;
  forModel(model).tokens += tokens;
}

/** Rejects if the call has not come back in `ms`. */
function withTimeout<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export interface ImageRef {
  mimeType: string;
  /** base64 */
  data: string;
}

export interface GenerateJsonOptions {
  temperature?: number;
  /** Explicit model ID; wins over `role`. */
  model?: string;
  /** Which model tier to use. Defaults to 'text'. */
  role?: ModelRole;
  systemInstruction?: string;
  /** Agent name used if a design call has to fall back. */
  agent?: string;
  /** Files sent inline alongside the prompt, e.g. the source PDF. */
  files?: ImageRef[];
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `generateJson: model did not return JSON. First 200 chars: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Structured output. `schema` is a Gemini responseSchema (OpenAPI subset);
 * the model is constrained to it, so the parse below should not throw.
 *
 * With `role: 'design'` the call gets a 60 s ceiling and exactly one retry on
 * TEXT_MODEL, because a world that builds slowly is still better than no world.
 */
export async function generateJson<T>(
  prompt: string,
  schema: Schema,
  opts: GenerateJsonOptions = {},
): Promise<T> {
  const role: ModelRole = opts.role ?? 'text';
  const model = opts.model ?? ROLE_MODEL[role]();

  const parts: Part[] = [
    ...(opts.files ?? []).map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data } })),
    { text: prompt },
  ];

  const call = (modelId: string) =>
    gemini().models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts }],
      config: {
        temperature: opts.temperature ?? 0.7,
        responseMimeType: 'application/json',
        responseSchema: schema,
        ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
      },
    });

  if (role === 'design') {
    try {
      spendCall(model);
      const res = await withTimeout(DESIGN_TIMEOUT_MS, `design call on ${model}`, call(model));
      countTokens(model, res);
      return parseJson<T>(res.text ?? '');
    } catch (err) {
      // Trimmed: the SDK's error message is a full JSON blob and this lands in the trace panel.
      const raw = err instanceof Error ? err.message : String(err);
      const reason = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
      console.warn(`[gemini] ${model} failed (${reason}) — falling back to ${MODELS.text}`);
      emitAgentEvent({
        ts: Date.now(),
        agent: opts.agent ?? 'Design agent',
        kind: 'fallback',
        message: `${model} failed (${reason}). Retrying once on ${MODELS.text}.`,
        model: MODELS.text,
      });
      spendCall(MODELS.text);
      const res = await call(MODELS.text);
      countTokens(MODELS.text, res);
      return parseJson<T>(res.text ?? '');
    }
  }

  const res = await withRetry('generateJson', model, () => call(model));
  countTokens(model, res);
  return parseJson<T>(res.text ?? '');
}

export interface GeneratedImage {
  mimeType: string;
  /** base64, as returned by the API */
  data: string;
  bytes: Buffer;
}

/**
 * Image generation. `refs` are reference images (character sheets, style
 * plates) passed alongside the prompt to keep scenes and portraits on-model.
 */
export async function generateImage(
  prompt: string,
  refs: ImageRef[] = [],
): Promise<GeneratedImage> {
  const parts: Part[] = [
    ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
    { text: prompt },
  ];
  const res = await withRetry('generateImage', MODELS.image, () =>
    gemini().models.generateContent({
      model: MODELS.image,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['IMAGE'] },
    }),
  );
  countTokens(MODELS.image, res);

  const candidateParts = res.candidates?.[0]?.content?.parts ?? [];
  for (const part of candidateParts) {
    const inline = (part as { inlineData?: { mimeType?: string; data?: string } }).inlineData;
    if (inline?.data) {
      usage.images += 1;
      forModel(MODELS.image).images += 1;
      return {
        mimeType: inline.mimeType ?? 'image/png',
        data: inline.data,
        bytes: Buffer.from(inline.data, 'base64'),
      };
    }
  }
  throw new Error(
    'generateImage: no image part in response (check IMAGE_MODEL supports image output)',
  );
}

export interface EmbedOptions {
  /** Prepended to every input, e.g. 'query: ' vs 'passage: '. */
  taskPrefix?: string;
  dims?: number;
  taskType?: string;
}

export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  const { taskPrefix = '', dims = 768, taskType } = opts;
  const contents = texts.map((t) => `${taskPrefix}${t}`);
  const res = await withRetry('embed', MODELS.embed, () =>
    gemini().models.embedContent({
      model: MODELS.embed,
      contents,
      config: {
        outputDimensionality: dims,
        ...(taskType ? { taskType } : {}),
      },
    }),
  );
  const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length !== texts.length) {
    throw new Error(`embed: asked for ${texts.length} vectors, got ${vectors.length}`);
  }
  return vectors;
}
