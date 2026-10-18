import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { ACT_SCHEMA, CURRICULUM_SCHEMA, JUDGE_SCHEMA, OUTLINE_SCHEMA } from '../src/schemas.js';
import { responseFormat, toJsonSchema } from '../src/providers/jsonschema.js';
import type { JsonSchema } from '../src/providers/jsonschema.js';

/** Walk every node of a converted schema. */
function walk(node: JsonSchema, visit: (n: JsonSchema) => void): void {
  visit(node);
  if (node.items) walk(node.items, visit);
  for (const child of Object.values(node.properties ?? {})) walk(child, visit);
}

const ALL: [string, Schema][] = [
  ['curriculum', CURRICULUM_SCHEMA],
  ['outline', OUTLINE_SCHEMA],
  ['act', ACT_SCHEMA],
  ['judge', JUDGE_SCHEMA],
];

/**
 * Gemini spells its types in upper case. Leaving one through is the failure
 * that matters here: an OpenAI-compatible endpoint rejects the whole request
 * with a 400, forty seconds into a design run.
 */
test('every type comes out as lower-case JSON Schema', () => {
  const legal = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
  for (const [name, schema] of ALL) {
    walk(toJsonSchema(schema), (node) => {
      if (node.type === undefined) return;
      for (const t of Array.isArray(node.type) ? node.type : [node.type]) {
        assert.ok(legal.includes(t), `${name}: ${t} is not a JSON Schema type`);
      }
    });
  }
});

test('nothing Gemini-only survives the translation', () => {
  for (const [name, schema] of ALL) {
    const json = JSON.stringify(toJsonSchema(schema));
    assert.ok(!json.includes('propertyOrdering'), `${name}: kept propertyOrdering`);
    assert.ok(!json.includes('nullable'), `${name}: kept nullable`);
    assert.ok(!/"type":"[A-Z]/.test(json), `${name}: kept an upper-case type`);
  }
});

test('an object forbids fields nobody asked for', () => {
  for (const [name, schema] of ALL) {
    walk(toJsonSchema(schema), (node) => {
      if (node.properties) {
        assert.equal(node.additionalProperties, false, `${name}: an object lets extras through`);
      }
    });
  }
});

test('the parts that carry meaning survive', () => {
  const converted = toJsonSchema(CURRICULUM_SCHEMA);
  assert.equal(converted.type, 'object');
  assert.ok(converted.properties?.concepts, 'lost the concepts');
  assert.equal(converted.properties?.concepts?.type, 'array');
  const concept = converted.properties?.concepts?.items;
  assert.ok(concept?.properties?.quote, 'lost the verbatim quote field');
  assert.ok((concept?.required ?? []).length > 0, 'lost which fields are required');

  // Enums are the whole reason these schemas are worth sending.
  let enums = 0;
  walk(converted, (node) => {
    if (node.enum?.length) enums++;
  });
  assert.ok(enums > 0, 'lost every enum');
});

test('nullable becomes a union, not a dropped field', () => {
  const schema: Schema = {
    type: Type.OBJECT,
    properties: { note: { type: Type.STRING, nullable: true } },
  };
  assert.deepEqual(toJsonSchema(schema).properties?.note?.type, ['string', 'null']);
});

/**
 * Strict mode demands that `required` list every property. These schemas quite
 * correctly mark optional fields optional, so turning it on would have the
 * endpoint reject the schema outright rather than constrain the model harder.
 */
test('the response_format is one an OpenAI endpoint will take', () => {
  const format = responseFormat('writers_room', OUTLINE_SCHEMA) as {
    type: string;
    json_schema: { name: string; strict: boolean; schema: JsonSchema };
  };
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.name, 'writers_room');
  assert.equal(format.json_schema.strict, false);
  assert.equal(format.json_schema.schema.type, 'object');
  assert.doesNotThrow(() => JSON.stringify(format), 'the format must serialise');
});
