/**
 * Gemini `Schema` → JSON Schema.
 *
 * Every structured-output call in this repo is written once, as a Gemini
 * responseSchema, and that is the right place for it: it sits next to the
 * design-time types it mirrors and it is the only copy. An OpenAI-compatible
 * router wants plain JSON Schema instead, so rather than keep two sets of
 * schemas in step by hand — which is a bug waiting for the first act anyone
 * adds — the one set is translated on the way out.
 *
 * Four things differ and all four have bitten:
 *
 * 1. Gemini's `Type` enum is upper case ('OBJECT'); JSON Schema is lower.
 * 2. Gemini orders object keys with `propertyOrdering`, which JSON Schema has
 *    no concept of, so it is dropped.
 * 3. `nullable: true` becomes a union with 'null'.
 * 4. OpenAI's strict mode refuses any object that does not forbid extra
 *    properties AND list every property as required. Gemini's schemas mark
 *    only the genuinely required ones, so strict mode would reject schemas
 *    that are perfectly valid — which is why strict is left off and the
 *    schema is sent as a plain constraint.
 */
import type { Schema } from '@google/genai';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  format?: string;
}

/** Gemini spells its types in upper case; JSON Schema does not. */
function typeOf(type: unknown): string | undefined {
  if (typeof type !== 'string') return undefined;
  const lower = type.toLowerCase();
  // Gemini's INTEGER is a JSON Schema integer; everything else maps straight.
  return ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(lower)
    ? lower
    : undefined;
}

export function toJsonSchema(schema: Schema): JsonSchema {
  const out: JsonSchema = {};
  const base = typeOf(schema.type);
  if (base) out.type = schema.nullable ? [base, 'null'] : base;
  if (schema.description) out.description = schema.description;
  if (schema.enum?.length) out.enum = [...schema.enum];
  if (schema.format) out.format = schema.format;
  if (typeof schema.minItems === 'number') out.minItems = Number(schema.minItems);
  if (typeof schema.maxItems === 'number') out.maxItems = Number(schema.maxItems);
  if (schema.items) out.items = toJsonSchema(schema.items);

  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    );
    // Not strict: see the note at the top. An object that allowed anything
    // through would let the model invent fields the validator then rejects,
    // so extras are forbidden even though every key is not made required.
    out.additionalProperties = false;
    if (schema.required?.length) out.required = [...schema.required];
  }

  return out;
}

/**
 * The whole `response_format` an OpenAI-compatible endpoint wants.
 *
 * `strict: false` is deliberate. Strict mode demands that `required` list
 * every single property, and these schemas quite correctly mark optional
 * fields optional — turning it on would reject the schema outright rather
 * than constrain the model more tightly.
 */
export function responseFormat(name: string, schema: Schema): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: { name, strict: false, schema: toJsonSchema(schema) },
  };
}
