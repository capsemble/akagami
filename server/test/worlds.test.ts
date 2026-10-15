import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_WORLD_ID, loadWorld } from '../src/mocks.js';

/**
 * Regression: both world routes used to call loadWorld() with no argument, so
 * every id resolved to the RAG world and the kinematics demo was unreachable in
 * live mode.
 */
test('the default world is the kinematics demo', async () => {
  const world = await loadWorld();
  assert.equal(world.id, DEFAULT_WORLD_ID);
  assert.equal(world.title, 'The Ghost of Ghat 9');
});

test('a world id resolves to that world, not the default', async () => {
  const rag = await loadWorld('world-oracle-library');
  assert.equal(rag.title, 'The Oracle of the Old Library');

  const kinematics = await loadWorld('world-ghat-9');
  assert.equal(kinematics.title, 'The Ghost of Ghat 9');
});

test('short demo names resolve to the same fixtures as ids', async () => {
  assert.equal((await loadWorld('rag')).id, (await loadWorld('world-oracle-library')).id);
  assert.equal((await loadWorld('kinematics')).id, (await loadWorld('world-ghat-9')).id);
});

test('an unknown world is an error, not a silent fallback', async () => {
  await assert.rejects(() => loadWorld('world-does-not-exist'), /unknown world/);
});

test('every act points at a scene that exists, in both worlds', async () => {
  const { loadScene } = await import('../src/mocks.js');
  for (const id of ['world-ghat-9', 'world-oracle-library']) {
    const world = await loadWorld(id);
    for (const act of world.acts) {
      const scene = await loadScene(act.sceneId);
      assert.equal(scene.id, act.sceneId, `${id} ${act.id} -> ${act.sceneId}`);
    }
  }
});

test('the kinematics acts all carry a formula mechanic with sane dials', async () => {
  const world = await loadWorld('world-ghat-9');
  assert.equal(world.acts.length, 3);
  for (const act of world.acts) {
    assert.equal(act.mechanic?.type, 'formula', `${act.id} should be a formula act`);
    if (act.mechanic?.type !== 'formula') continue;
    for (const param of act.mechanic.params) {
      assert.ok(param.min < param.max, `${act.id}.${param.name} has an empty range`);
      assert.ok(
        param.default >= param.min && param.default <= param.max,
        `${act.id}.${param.name} default is outside its range`,
      );
      assert.ok(
        param.solution >= param.min && param.solution <= param.max,
        `${act.id}.${param.name} solution is outside its range`,
      );
      assert.notEqual(param.default, param.solution, `${act.id}.${param.name} starts solved`);
    }
  }
});
