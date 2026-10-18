import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Curriculum } from '@chapter-quest/shared';
import { writersRoomPrompt } from '../src/prompts.js';
import { REGISTERS, registersFor } from '../src/registers.js';

test('every register is filled in', () => {
  const ids = new Set<string>();
  for (const register of REGISTERS) {
    for (const [field, value] of Object.entries(register)) {
      assert.ok(
        typeof value === 'string' && value.trim().length > 0,
        `${register.id}: ${field} is empty`,
      );
    }
    assert.ok(!ids.has(register.id), `duplicate register id ${register.id}`);
    ids.add(register.id);
  }
  assert.ok(REGISTERS.length >= 4, 'too few genres to give the judge a choice');
});

test('a chapter always opens on the same two films', () => {
  for (const hash of ['abc123', 'ffffffff', '0', 'a-very-long-chapter-hash-value']) {
    assert.deepEqual(registersFor(hash), registersFor(hash), `${hash} is not stable`);
  }
});

/**
 * The two drafts must differ, or the judge is picking between set dressing.
 * This was the whole reason the register exists.
 */
test('the two drafts are never the same film', () => {
  for (let i = 0; i < 400; i++) {
    const [a, b] = registersFor(`chapter-${i}`);
    assert.notEqual(a.id, b.id, `chapter-${i} got the same register twice`);
  }
});

test('no register is unreachable', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const [a, b] = registersFor(`chapter-${i}`);
    seen.add(a.id);
    seen.add(b.id);
  }
  for (const register of REGISTERS) {
    assert.ok(seen.has(register.id), `${register.id} is never picked`);
  }
});

const CURRICULUM: Curriculum = {
  title: 'Convolutional Networks',
  concepts: [
    {
      id: 'stride',
      name: 'Stride',
      kind: 'formula',
      quote: 'the filter moves by the stride',
      page: 3,
      keyRule: 'Stride sets how far the filter steps.',
      misconceptions: ['Stride changes what the filter sees, not how often it looks.'],
    },
  ],
} as unknown as Curriculum;

/**
 * The brief has to carry the genre AND the rule that keeps the room writing its
 * own people. A register that quietly invited real film characters would put
 * someone else's property into every generated world.
 */
test('the brief names the film and tells the room to write its own characters', () => {
  const register = REGISTERS[0]!;
  const { system, prompt } = writersRoomPrompt(CURRICULUM, 'A', register);

  assert.ok(system.includes(register.name), 'the brief never names the register');
  assert.ok(system.includes(register.world), 'the brief drops the setting');
  assert.ok(system.includes(register.look), 'the brief drops the art direction');
  assert.match(system, /ORIGINAL characters/, 'the brief does not ask for original characters');
  assert.match(system, /Do not\s+name, quote or reproduce characters from real films/);
  assert.ok(prompt.includes(register.name), 'the user turn never names the register');
});

test('the chapter still outranks the genre', () => {
  const { system } = writersRoomPrompt(CURRICULUM, 'B', REGISTERS[1]!);
  assert.match(system, /the concept wins and the genre bends/);
  assert.match(system, /come from the chapter, unchanged/);
});
