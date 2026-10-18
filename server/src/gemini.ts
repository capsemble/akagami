/**
 * The model layer. Everything that talks to a model goes through here, so
 * retries, usage counters and the daily cap live in one place.
 *
 * Two providers sit underneath. **Google** talks to @google/genai directly.
 * **FastRouter** is one OpenAI-compatible endpoint in front of a couple of
 * hundred models from every lab, and it is here because the Google keys this
 * project started on ran out of free-tier quota — a chapter that cannot be
 * turned into a world is not a demo. Which one is used is decided once, at the
 * bottom of this comment's worth of config, and nothing above it knows or cares.
 *
 * The file is still called gemini.ts because four modules import it by that
 * name and a rename is churn, not progress.
 *
 * API keys are read from the environment on the server only and never sent to
 * the client.
 */
import { GoogleGenAI } from '@google/genai';
import type { Part, Schema } from '@google/genai';
import type { AgentEvent } from '@chapter-quest/shared';
import * as fastrouter from './providers/fastrouter.js';

export type Provider = 'google' | 'fastrouter';

/**
 * Which backend the models come from.
 *
 * Set MODEL_PROVIDER to force it. Otherwise: a FastRouter key means FastRouter,
 * because nobody sets that key by accident, and the Google path only works
 * while that project still has quota.
 */
export const PROVIDER: Provider =
  (process.env.MODEL_PROVIDER as Provider | undefined) ??
  (fastrouter.hasKey() ? 'fastrouter' : 'google');

/**
 * Model IDs come from env so we can swap them without a deploy; these are the
 * defaults per provider.
 *
 * The FastRouter picks are not uniform, because the roles are not.
 *
 * `design` gets Argon, the same model the Google path used and the one every
 * prompt and gold exemplar in prompts.ts was written against. It is six times
 * the price of the cheap tier and it only runs when a world is being built:
 * measured on the real prompts that is about 37k in and 8k out, so roughly
 * sixteen cents a world — sixty-odd worlds for ten dollars, which is not the
 * thing to economise on.
 *
 * `text` and `fast` run per turn once a world is open, so volume matters there
 * and they stay cheap. The Oracle deliberately gets the *weaker* text model:
 * the RAG lessons need something that visibly gets distracted at k=8, and a
 * model too good to be confused teaches nothing.
 *
 * Note FastRouter's own catalogue reports `structured_outputs: false` for every
 * Google model, and it is wrong — Argon honours `response_format: json_schema`
 * through the router. `npm run models -- --probe` checks by making the call
 * rather than by reading the catalogue.
 */
const DEFAULTS: Record<Provider, Record<'design' | 'text' | 'fast' | 'image' | 'embed', string>> = {
  google: {
    design: 'gemini-4-argon',
    text: 'gemini-3.8-flash',
    fast: 'gemini-3.5-flash-lite',
    image: 'gemini-nano-banana-2.1',
    embed: 'gemini-embedding-2',
  },
  fastrouter: {
    design: 'google/gemini-4-argon',
    text: 'google/gemini-3.8-flash',
    fast: 'google/gemini-3.5-flash-lite',
    image: 'google/gemini-nano-banana-2.1',
    embed: 'google/gemini-embedding-001',
  },
};

export const MODELS = {
  design: process.env.DESIGN_MODEL ?? DEFAULTS[PROVIDER].design,
  text: process.env.TEXT_MODEL ?? DEFAULTS[PROVIDER].text,
  fast: process.env.FAST_MODEL ?? DEFAULTS[PROVIDER].fast,
  image: process.env.IMAGE_MODEL ?? DEFAULTS[PROVIDER].image,
  embed: process.env.EMBED_MODEL ?? DEFAULTS[PROVIDER].embed,
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
/**
 * Why a call failed, because the two recoverable reasons want very different
 * patience. A capacity spike ("this model is currently experiencing high
 * demand") clears in seconds to a minute, so waiting is the correct response.
 * A spent daily quota will not clear today, so waiting only delays the
 * fallback to another model. Treating both as one three-second retry meant a
 * design run died on a 503 that would have cleared on the next attempt.
 */
export type FailureKind = 'overload' | 'quota' | 'fatal';

export function classifyFailure(err: unknown): FailureKind {
  const e = err as { status?: number; code?: number; message?: string };
  const status = e?.status ?? e?.code;
  const message = e?.message ?? '';
  if (status === 429 || /\b429\b|RESOURCE_EXHAUSTED/i.test(message)) return 'quota';
  if (
    (typeof status === 'number' && status >= 500) ||
    /\b(500|502|503|504)\b|UNAVAILABLE|high demand/i.test(message)
  ) {
    return 'overload';
  }
  return 'fatal';
}

/** Attempts and backoff per failure kind. */
export function retryPlan(kind: FailureKind, attempt: number): { retry: boolean; waitMs: number } {
  if (kind === 'overload') {
    // ~40s of patience in total, which covers the spikes we actually see.
    return attempt < 5
      ? { retry: true, waitMs: Math.min(12_000, 1000 * 2 ** attempt) }
      : { retry: false, waitMs: 0 };
  }
  if (kind === 'quota') {
    // One quick retry in case it was a per-minute limit, then hand over to the
    // fallback model: a per-day limit is not going to clear while we wait.
    return attempt < 1 ? { retry: true, waitMs: 800 } : { retry: false, waitMs: 0 };
  }
  return { retry: false, waitMs: 0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, model: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      spendCall(model);
      return await fn();
    } catch (err) {
      const kind = classifyFailure(err);
      const { retry, waitMs } = retryPlan(kind, attempt);
      if (!retry) throw err;
      const jitter = Math.floor(Math.random() * 250);
      console.warn(
        `[gemini] ${label} ${kind} on ${model} (attempt ${attempt + 1}), retrying in ${waitMs + jitter}ms`,
      );
      await sleep(waitMs + jitter);
    }
  }
}

/** What a call cost, however it was made. */
export interface Completion {
  text: string;
  tokens: number;
}

/** A schema name an OpenAI-compatible endpoint will accept. */
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'result';

function spendTokens(model: string, tokens: number): void {
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

  // One shape out of both providers: the text that came back and what it cost.
  const call = async (modelId: string): Promise<Completion> => {
    if (PROVIDER === 'fastrouter') {
      return fastrouter.json({
        model: modelId,
        prompt,
        schema,
        schemaName: opts.agent ? slug(opts.agent) : 'result',
        ...(opts.systemInstruction ? { system: opts.systemInstruction } : {}),
        temperature: opts.temperature ?? 0.7,
        ...(opts.files?.length ? { files: opts.files } : {}),
      });
    }
    const res = await gemini().models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts }],
      config: {
        temperature: opts.temperature ?? 0.7,
        responseMimeType: 'application/json',
        responseSchema: schema,
        ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
      },
    });
    return { text: res.text ?? '', tokens: res.usageMetadata?.totalTokenCount ?? 0 };
  };

  if (role === 'design') {
    // Both attempts go through withRetry. Without it the design role was the
    // one path in this file with no retry at all: a single 503 on the fallback
    // model ended the call, and with it the writers' room and the whole run.
    const attempt = (modelId: string) =>
      withRetry(`design on ${modelId}`, modelId, () =>
        withTimeout(DESIGN_TIMEOUT_MS, `design call on ${modelId}`, call(modelId)),
      );

    try {
      const res = await attempt(model);
      spendTokens(model, res.tokens);
      return parseJson<T>(res.text);
    } catch (err) {
      // Trimmed: the SDK's error message is a full JSON blob and this lands in the trace panel.
      const raw = err instanceof Error ? err.message : String(err);
      const reason = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
      console.warn(`[gemini] ${model} failed (${reason}) — falling back to ${MODELS.text}`);
      emitAgentEvent({
        ts: Date.now(),
        agent: opts.agent ?? 'Design agent',
        kind: 'fallback',
        message: `${model} failed (${reason}). Falling back to ${MODELS.text}.`,
        model: MODELS.text,
      });
      const res = await attempt(MODELS.text);
      spendTokens(MODELS.text, res.tokens);
      return parseJson<T>(res.text);
    }
  }

  const res = await withRetry('generateJson', model, () => call(model));
  spendTokens(model, res.tokens);
  return parseJson<T>(res.text);
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
  const painted = await withRetry('generateImage', MODELS.image, async () => {
    if (PROVIDER === 'fastrouter') {
      return fastrouter.image(MODELS.image, prompt, refs);
    }
    const parts: Part[] = [
      ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
      { text: prompt },
    ];
    const res = await gemini().models.generateContent({
      model: MODELS.image,
      contents: [{ role: 'user', parts }],
      config: { responseModalities: ['IMAGE'] },
    });
    const tokens = res.usageMetadata?.totalTokenCount ?? 0;
    for (const part of res.candidates?.[0]?.content?.parts ?? []) {
      const inline = (part as { inlineData?: { mimeType?: string; data?: string } }).inlineData;
      if (inline?.data) {
        return { mimeType: inline.mimeType ?? 'image/png', data: inline.data, tokens };
      }
    }
    throw new Error(
      'generateImage: no image part in response (check IMAGE_MODEL supports image output)',
    );
  });

  spendTokens(MODELS.image, painted.tokens);
  usage.images += 1;
  forModel(MODELS.image).images += 1;
  return {
    mimeType: painted.mimeType,
    data: painted.data,
    bytes: Buffer.from(painted.data, 'base64'),
  };
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

  const vectors = await withRetry('embed', MODELS.embed, async () => {
    if (PROVIDER === 'fastrouter') {
      const res = await fastrouter.embed(MODELS.embed, contents, dims);
      spendTokens(MODELS.embed, res.tokens);
      return res.vectors;
    }
    const res = await gemini().models.embedContent({
      model: MODELS.embed,
      contents,
      config: {
        outputDimensionality: dims,
        ...(taskType ? { taskType } : {}),
      },
    });
    return (res.embeddings ?? []).map((e) => e.values ?? []);
  });

  if (vectors.length !== texts.length) {
    throw new Error(`embed: asked for ${texts.length} vectors, got ${vectors.length}`);
  }
  return vectors;
}
