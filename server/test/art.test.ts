import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { CastMember } from '@chapter-quest/shared';

// cache.ts reads this once, at import, so it has to be set before the import
// below. node:test gives each file its own process, so this cannot leak.
const scratch = await mkdtemp(join(tmpdir(), 'chapter-quest-art-'));
process.env.DESIGN_CACHE_DIR = scratch;

const { paintWorld } = await import('../src/pipeline/art.js');
type Painter = Parameters<typeof paintWorld>[1];

after(() => rm(scratch, { recursive: true, force: true }));

const CAST: CastMember[] = [
  { id: 'rane', name: 'Inspector Rane', look: 'a tired man in a wet raincoat', persona: 'dogged' },
  {
    id: 'dalvi',
    name: 'Station Master Dalvi',
    look: 'brass buttons, ink on his fingers',
    persona: 'proud',
    misconception: 'an average describes every moment',
  },
];
const PROPS = [{ id: 'water-tank', label: 'a cast-iron water tank', look: 'rust and rivets' }];

/** Records every call and hands back a tiny valid-enough image. */
function stub(behaviour: (prompt: string) => void = () => {}) {
  const calls: { prompt: string; refs: number }[] = [];
  const paint: Painter = async (prompt, refs) => {
    behaviour(prompt);
    calls.push({ prompt, refs: refs.length });
    return { mimeType: 'image/png', data: 'AA==', bytes: Buffer.from([0x89, 0x50]) };
  };
  return { calls, paint };
}

const request = {
  hash: 'abc123def456abc1',
  artStyle: 'isometric 1950s hill railway, wet slate and teak',
  cast: CAST,
  props: PROPS,
};

test('the style plate is painted first and every later asset is drawn against it', async () => {
  const { calls, paint } = stub();
  const art = await paintWorld({ ...request, hash: 'style0000000000a' }, paint);

  assert.equal(calls.length, 1 + CAST.length * 2 + PROPS.length);
  assert.match(calls[0]!.prompt, /style plate/i, 'the plate has to come first');
  assert.equal(calls[0]!.refs, 0, 'the plate has nothing to match');
  for (const call of calls.slice(1)) {
    assert.equal(call.refs, 1, `"${call.prompt.slice(0, 40)}…" was painted without the plate`);
  }
  assert.ok(
    calls.some((c) => c.prompt.includes('wet slate and teak')),
    'style never reached a prompt',
  );

  assert.ok(art.styleUrl);
  assert.equal(Object.keys(art.portraits).length, CAST.length);
  assert.equal(Object.keys(art.sprites).length, CAST.length);
  assert.equal(art.props['water-tank'], '/api/art/style0000000000a/prop-water-tank.png');
  assert.deepEqual(art.missing, []);
});

test('a second run of the same chapter pays for nothing', async () => {
  const first = stub();
  await paintWorld({ ...request, hash: 'cache00000000001' }, first.paint);
  assert.ok(first.calls.length > 0);

  const second = stub();
  const art = await paintWorld({ ...request, hash: 'cache00000000001' }, second.paint);
  assert.equal(second.calls.length, 0, 'a cached chapter must not call the model again');
  assert.equal(Object.keys(art.props).length, PROPS.length, 'cached assets still come back');

  const fresh = stub();
  await paintWorld({ ...request, hash: 'cache00000000001', fresh: true }, fresh.paint);
  assert.ok(fresh.calls.length > 0, 'fresh must bypass the cache');
});

test('one refused prompt costs one picture, not the world', async () => {
  const { paint } = stub((prompt) => {
    if (prompt.includes('water tank')) throw new Error('safety: refused');
  });
  const art = await paintWorld({ ...request, hash: 'partial000000001' }, paint);

  assert.equal(art.missing.length, 1);
  assert.equal(art.missing[0]!.asset, 'prop-water-tank');
  assert.match(art.missing[0]!.reason, /refused/);
  assert.equal(art.props['water-tank'], undefined, 'a refused prop must not get a url');
  assert.equal(Object.keys(art.portraits).length, CAST.length, 'the cast was still painted');
});

/**
 * The whole point of the stage being optional: no key, wrong model id, API off
 * for the project — the world still has to be playable, on placeholders.
 */
test('a dead image model degrades to placeholders instead of throwing', async () => {
  const paint: Painter = async () => {
    throw new Error('Generative Language API has not been used in project 1076790417704');
  };
  const events: string[] = [];
  const art = await paintWorld(
    { ...request, hash: 'dead000000000001', emit: (e) => events.push(e.message) },
    paint,
  );

  assert.deepEqual(art.portraits, {});
  assert.deepEqual(art.sprites, {});
  assert.deepEqual(art.props, {});
  assert.equal(art.styleUrl, undefined);
  assert.equal(art.missing.length, 1 + CAST.length * 2 + PROPS.length);
  assert.ok(
    events.some((m) => m.includes('placeholder')),
    'the trace has to admit it fell back',
  );
});
