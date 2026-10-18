/**
 * FastRouter — one OpenAI-compatible endpoint in front of a couple of hundred
 * models from every major lab.
 *
 * It exists here for a boring, decisive reason: the Google keys this project
 * started on ran out of free-tier quota, and a chapter that cannot be turned
 * into a world is not a demo. Routing through one endpoint also means a model
 * that is overloaded or retired is an env var away from being swapped, rather
 * than a code change.
 *
 * Three calls are needed and all three are plain HTTP, so there is no SDK:
 * chat completions with a JSON schema, image generation, and embeddings.
 * `fetch` is built in, the request shapes are stable, and a dependency that
 * wraps three POSTs is a dependency that breaks three POSTs.
 *
 * The key is read from the environment on the server and never leaves it.
 */
import type { Schema } from '@google/genai';
import { responseFormat } from './jsonschema.js';

const BASE = process.env.FASTROUTER_BASE_URL ?? 'https://go.fastrouter.ai/api/v1';

export interface InlineFile {
  mimeType: string;
  /** base64 */
  data: string;
}

export interface JsonCall {
  model: string;
  prompt: string;
  schema: Schema;
  /** A name for the schema, which some providers put in the error message. */
  schemaName?: string;
  system?: string;
  temperature?: number;
  files?: InlineFile[];
}

export interface Completion {
  text: string;
  tokens: number;
}

function key(): string {
  const value = process.env.FASTROUTER_API_KEY;
  if (!value) throw new Error('FASTROUTER_API_KEY is not set (see .env.example)');
  return value;
}

export const hasKey = (): boolean => Boolean(process.env.FASTROUTER_API_KEY);

/**
 * One POST, with the status text folded into the error.
 *
 * A router's failures arrive as HTTP codes, and the layer above classifies
 * them by message to decide whether to wait or to give up — so the code has to
 * survive into the message. "429" has to still be there when `classifyFailure`
 * reads it, or a spent quota is retried for forty seconds.
 */
async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
      // FastRouter uses these for its own activity dashboard.
      'HTTP-Referer': 'https://github.com/chapter-quest',
      'X-Title': 'Chapter Quest',
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`fastrouter ${res.status} ${res.statusText} on ${path}: ${detail}`);
  }
  return (await res.json()) as T;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

/** A chat completion constrained to a schema. */
export async function json(call: JsonCall): Promise<Completion> {
  // A file rides along as an image_url part, which is how every
  // OpenAI-compatible endpoint takes inline bytes.
  const content: unknown[] = [
    ...(call.files ?? []).map((f) => ({
      type: 'image_url',
      image_url: { url: `data:${f.mimeType};base64,${f.data}` },
    })),
    { type: 'text', text: call.prompt },
  ];

  const res = await post<ChatResponse>('/chat/completions', {
    model: call.model,
    messages: [
      ...(call.system ? [{ role: 'system', content: call.system }] : []),
      { role: 'user', content },
    ],
    temperature: call.temperature ?? 0.7,
    response_format: responseFormat(call.schemaName ?? 'result', call.schema),
  });

  if (res.error?.message) throw new Error(`fastrouter: ${res.error.message}`);
  const text = res.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('fastrouter: empty completion');
  return { text, tokens: res.usage?.total_tokens ?? 0 };
}

interface ImageResponse {
  choices?: {
    message?: {
      content?: string | null;
      images?: { image_url?: { url?: string } }[];
    };
  }[];
  data?: { b64_json?: string; url?: string }[];
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

export interface ImageResult {
  mimeType: string;
  /** base64 */
  data: string;
  tokens: number;
}

/**
 * An image.
 *
 * Routers disagree about where the bytes go: some return an `images` array on
 * the chat message, some an OpenAI `data[].b64_json`, some a bare data URI in
 * the content. All three are accepted, because which one you get depends on
 * the model behind the route and that is not worth pinning down per model.
 */
export async function image(
  model: string,
  prompt: string,
  refs: InlineFile[] = [],
): Promise<ImageResult> {
  const content: unknown[] = [
    ...refs.map((r) => ({
      type: 'image_url',
      image_url: { url: `data:${r.mimeType};base64,${r.data}` },
    })),
    { type: 'text', text: prompt },
  ];

  const res = await post<ImageResponse>('/chat/completions', {
    model,
    messages: [{ role: 'user', content }],
    modalities: ['image', 'text'],
  });
  if (res.error?.message) throw new Error(`fastrouter: ${res.error.message}`);

  const tokens = res.usage?.total_tokens ?? 0;
  const fromDataUri = (uri: string): ImageResult | null => {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(uri);
    return match ? { mimeType: match[1]!, data: match[2]!, tokens } : null;
  };

  const inline = res.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (inline) {
    const parsed = fromDataUri(inline);
    if (parsed) return parsed;
  }
  const b64 = res.data?.[0]?.b64_json;
  if (b64) return { mimeType: 'image/png', data: b64, tokens };
  const content0 = res.choices?.[0]?.message?.content;
  if (content0) {
    const parsed = fromDataUri(content0.trim());
    if (parsed) return parsed;
  }
  throw new Error(`fastrouter: no image in response from ${model}`);
}

interface EmbedResponse {
  data?: { embedding?: number[] }[];
  usage?: { total_tokens?: number };
  error?: { message?: string };
}

export async function embed(
  model: string,
  inputs: string[],
  dims?: number,
): Promise<{ vectors: number[][]; tokens: number }> {
  const res = await post<EmbedResponse>('/embeddings', {
    model,
    input: inputs,
    // Only some models accept it; sending it to one that does not is a 400,
    // so it goes only when the caller actually asked for a size.
    ...(dims ? { dimensions: dims } : {}),
  });
  if (res.error?.message) throw new Error(`fastrouter: ${res.error.message}`);
  const vectors = (res.data ?? []).map((d) => d.embedding ?? []);
  return { vectors, tokens: res.usage?.total_tokens ?? 0 };
}
