/**
 * Thin wrapper around @google/genai. Everything that talks to Gemini goes
 * through here so retries, usage counters and the daily cap are in one place.
 *
 * The API key is read from the environment on the server only and is never
 * sent to the client.
 */
import { GoogleGenAI } from '@google/genai';

/**
 * Model IDs come from env so we can swap them without a deploy.
 * TODO: verify these IDs in AI Studio before the demo — a wrong ID fails at
 * call time with a 404, not at startup.
 */
export const MODELS = {
  text: process.env.TEXT_MODEL ?? 'gemini-3.8-flash',
  fast: process.env.FAST_MODEL ?? 'gemini-3.5-flash-lite',
  image: process.env.IMAGE_MODEL ?? 'gemini-nano-banana-2.1',
  embed: process.env.EMBED_MODEL ?? 'gemini-embedding-2',
};

export interface Usage {
  calls: number;
  tokens: number;
  images: number;
}

const usage: Usage = { calls: 0, tokens: 0, images: 0 };
let usageDay = new Date().toISOString().slice(0, 10);

export function getUsage(): Usage {
  rollDay();
  return { ...usage };
}

function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== usageDay) {
    usageDay = today;
    usage.calls = 0;
    usage.tokens = 0;
    usage.images = 0;
  }
}

function dailyCap(): number {
  return Number(process.env.DAILY_CALL_CAP ?? 500);
}

function spendCall(): void {
  rollDay();
  if (usage.calls >= dailyCap()) {
    throw new Error(
      `Daily call cap reached (${usage.calls}/${dailyCap()}). Raise DAILY_CALL_CAP or wait for UTC midnight.`,
    );
  }
  usage.calls += 1;
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

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      spendCall();
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

function countTokens(res: { usageMetadata?: { totalTokenCount?: number } }): void {
  usage.tokens += res.usageMetadata?.totalTokenCount ?? 0;
}

export interface GenerateJsonOptions {
  temperature?: number;
  model?: string;
  systemInstruction?: string;
}

/**
 * Structured output. `schema` is a Gemini responseSchema (OpenAPI subset);
 * the model is constrained to it, so the parse below should not throw.
 */
export async function generateJson<T>(
  prompt: string,
  schema: Record<string, unknown>,
  opts: GenerateJsonOptions = {},
): Promise<T> {
  const res = await withRetry('generateJson', () =>
    gemini().models.generateContent({
      model: opts.model ?? MODELS.text,
      contents: prompt,
      config: {
        temperature: opts.temperature ?? 0.7,
        responseMimeType: 'application/json',
        responseSchema: schema as never,
        ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
      },
    }),
  );
  countTokens(res);
  const text = res.text ?? '';
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `generateJson: model did not return JSON. First 200 chars: ${text.slice(0, 200)}`,
    );
  }
}

export interface GeneratedImage {
  mimeType: string;
  /** base64, as returned by the API */
  data: string;
  bytes: Buffer;
}

export interface ImageRef {
  mimeType: string;
  /** base64 */
  data: string;
}

/**
 * Image generation. `refs` are reference images (character sheets, style
 * plates) passed alongside the prompt to keep scenes and portraits on-model.
 */
export async function generateImage(
  prompt: string,
  refs: ImageRef[] = [],
): Promise<GeneratedImage> {
  const parts: Record<string, unknown>[] = [
    ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
    { text: prompt },
  ];
  const res = await withRetry('generateImage', () =>
    gemini().models.generateContent({
      model: MODELS.image,
      contents: [{ role: 'user', parts }] as never,
      config: { responseModalities: ['IMAGE'] as never },
    }),
  );
  countTokens(res);

  const candidateParts = res.candidates?.[0]?.content?.parts ?? [];
  for (const part of candidateParts) {
    const inline = (part as { inlineData?: { mimeType?: string; data?: string } }).inlineData;
    if (inline?.data) {
      usage.images += 1;
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
  const res = await withRetry('embed', () =>
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
