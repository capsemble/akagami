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

/**
 * Regression: the build story streamed on the world-forming screen was a single
 * hardcoded RAG trace, so picking the kinematics demo still played 21 seconds of
 * "The Oracle of the Old Library" before dropping you into Ghat 9.
 */
test('each world streams its own build story', async () => {
  const { loadEvents } = await import('../src/mocks.js');

  const kinematics = await loadEvents('world-ghat-9');
  const rag = await loadEvents('world-oracle-library');

  assert.match(kinematics[0]!.message, /Rest and Motion/);
  assert.match(rag[0]!.message, /Retrieval-Augmented/);

  const oracleish = /oracle|\bRAG\b|scroll|satchel|scriptorium/i;
  assert.equal(
    kinematics.filter((e) => oracleish.test(e.message)).length,
    0,
    'the kinematics trace must not mention the RAG world',
  );

  const defaulted = await loadEvents();
  assert.equal(defaulted[0]!.message, kinematics[0]!.message, 'the default trace is kinematics');
});

test('both traces keep their timings and their model chips', async () => {
  const { loadEvents } = await import('../src/mocks.js');
  for (const id of ['world-ghat-9', 'world-oracle-library']) {
    const events = await loadEvents(id);
    assert.equal(events.length, 16, `${id} should still be 16 events`);
    assert.equal(events[events.length - 1]!.ts, 21000, `${id} should still end at 21s`);
    assert.ok(
      events.every((e) => typeof e.model === 'string' && e.model.length > 0),
      `${id} events should all carry a model`,
    );
  }
});

test('every kinematics act can actually be drawn', async () => {
  const { evaluate, simulate } = await import('@chapter-quest/shared');
  const world = await loadWorld('world-ghat-9');

  for (const act of world.acts) {
    if (act.mechanic?.type !== 'formula') continue;
    const { spec, params } = act.mechanic;
    const visual = spec.visual;
    assert.ok(visual, `${act.id} has no visual, so the panel would show numbers only`);
    if (!visual) continue;

    const dials = Object.fromEntries(params.map((p) => [p.name, p.solution]));
    const run = simulate(spec, dials, { trace: true });
    const scope = { ...spec.constants, ...dials, ...run.outputs };

    // Markers and bands are measured against the finished run.
    for (const marker of visual.markers ?? []) {
      assert.ok(
        Number.isFinite(evaluate(marker.value, scope)),
        `${act.id} marker "${marker.label}" does not evaluate`,
      );
    }
    if (visual.band) {
      assert.ok(Number.isFinite(evaluate(visual.band.from, scope)), `${act.id} band.from`);
      assert.ok(Number.isFinite(evaluate(visual.band.to, scope)), `${act.id} band.to`);
    }

    if (visual.kind === 'gauge') {
      assert.ok(Number.isFinite(evaluate(visual.y, scope)), `${act.id} gauge value`);
      continue;
    }

    // Plotted series are evaluated against each sample of the path.
    assert.ok(run.samples.length > 5, `${act.id} traced only ${run.samples.length} samples`);
    for (const sample of run.samples) {
      assert.ok(Number.isFinite(evaluate(visual.x ?? 't', sample)), `${act.id} x expression`);
      assert.ok(Number.isFinite(evaluate(visual.y, sample)), `${act.id} y expression`);
    }
  }
});

test('the winning run of each act ends inside its own target band', async () => {
  const { evaluate, simulate } = await import('@chapter-quest/shared');
  const world = await loadWorld('world-ghat-9');

  for (const act of world.acts) {
    if (act.mechanic?.type !== 'formula') continue;
    const { spec, params } = act.mechanic;
    const band = spec.visual?.band;
    if (!band || spec.visual?.kind === 'gauge') continue;

    const dials = Object.fromEntries(params.map((p) => [p.name, p.solution]));
    const run = simulate(spec, dials, { trace: true });
    const scope = { ...spec.constants, ...dials, ...run.outputs };
    const last = run.samples[run.samples.length - 1]!;

    const axis = band.axis ?? 'y';
    const landed = evaluate(axis === 'x' ? (spec.visual!.x ?? 't') : spec.visual!.y, last);
    const from = evaluate(band.from, scope);
    const to = evaluate(band.to, scope);

    assert.ok(
      landed >= Math.min(from, to) && landed <= Math.max(from, to),
      `${act.id} wins but the plot ends at ${landed.toFixed(2)}, outside the drawn band ${from}..${to}`,
    );
  }
});
