import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Point } from '@chapter-quest/shared';
import { DEFAULT_WORLD_ID, loadScene, loadWorld } from '../src/mocks.js';

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

test('every dialogue line names a real cast member and respects the limits', async () => {
  for (const id of ['world-ghat-9', 'world-oracle-library']) {
    const world = await loadWorld(id);
    const cast = new Map(world.cast.flatMap((c) => [[c.name, c] as const, [c.id, c] as const]));

    for (const act of world.acts) {
      const lines = act.dialogue ?? [];
      assert.ok(lines.length > 0, `${id} ${act.id} has no dialogue, so the cast never speaks`);
      assert.ok(lines.length <= 6, `${id} ${act.id} has ${lines.length} lines, max 6`);

      for (const [i, line] of lines.entries()) {
        const member = cast.get(line.speaker);
        assert.ok(member, `${id} ${act.id}[${i}]: "${line.speaker}" is not in the cast`);
        const words = line.line.trim().split(/\s+/).length;
        assert.ok(words <= 25, `${id} ${act.id}[${i}]: ${words} words, max 25`);
        assert.ok(
          member && member.portraits[line.mood ?? 'neutral'],
          `${id} ${act.id}[${i}]: no ${line.mood ?? 'neutral'} portrait for ${line.speaker}`,
        );
      }
    }
  }
});

/**
 * A staged act is played in the scene, so its bindings have to agree with the
 * scene's geometry and with the simulation at the same time. Nothing else
 * checks that: a path that runs through a wall, or a target band painted past
 * the end of the track, type-checks perfectly and is only wrong on screen.
 */
test('every staged act binds to params that exist', async () => {
  const world = await loadWorld('world-ghat-9');

  for (const act of world.acts) {
    assert.ok(act.stage, `${act.id} has no stage, so it falls back to the slider panel`);
    if (!act.stage || act.mechanic?.type !== 'formula') continue;
    const names = new Set(act.mechanic.params.map((p) => p.name));

    for (const binding of act.stage.bindings) {
      const used = binding.kind === 'aim' ? [binding.paramX, binding.paramY] : [binding.param];
      for (const name of used) {
        assert.ok(names.has(name), `${act.id}: binding names "${name}", which is not a param`);
      }
    }
    assert.equal(
      act.stage.bindings.length,
      act.mechanic.params.length === 2 && act.stage.bindings[0]?.kind === 'aim'
        ? 1
        : act.mechanic.params.length,
      `${act.id}: every param needs somewhere in the world to come from`,
    );
  }
});

test('nothing a staged act asks you to reach is inside a wall', async () => {
  const world = await loadWorld('world-ghat-9');

  const inside = (rect: { x: number; y: number; w: number; h: number }, p: Point) =>
    p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;

  for (const act of world.acts) {
    if (!act.stage) continue;
    const scene = await loadScene(act.sceneId);

    // A control is held, not walked to, so it has nowhere to be.
    const reach: [string, Point][] = [];
    for (const binding of act.stage.bindings) {
      if (binding.kind === 'control') continue;
      if (binding.kind === 'marker') {
        reach.push([`${binding.param} path start`, binding.path.from]);
        reach.push([`${binding.param} path end`, binding.path.to]);
      } else {
        reach.push([binding.kind, binding.at]);
      }
    }

    for (const [what, point] of reach) {
      assert.ok(
        point.x >= 0 && point.x <= scene.width && point.y >= 0 && point.y <= scene.height,
        `${act.id}: ${what} is outside ${scene.id}`,
      );
      const wall = scene.blocked.find((rect) => inside(rect, point));
      assert.ok(!wall, `${act.id}: ${what} is inside a wall of ${scene.id}`);
    }

    for (const id of Object.keys(act.stage.readables ?? {})) {
      assert.ok(
        scene.interactables.some((it) => it.id === id),
        `${act.id}: readable "${id}" is not an interactable in ${scene.id}`,
      );
    }
  }
});

test('a winning run ends inside the span the scene paints', async () => {
  const { evaluate, simulate } = await import('@chapter-quest/shared');
  const world = await loadWorld('world-ghat-9');

  for (const act of world.acts) {
    const playback = act.stage?.playback;
    if (!playback || act.mechanic?.type !== 'formula') continue;
    const { spec, params } = act.mechanic;
    const band = spec.visual?.band;
    assert.ok(band, `${act.id} plays a run out but has no band to paint as the target`);
    if (!band) continue;

    const dials = Object.fromEntries(params.map((p) => [p.name, p.solution]));
    const run = simulate(spec, dials, { trace: true });
    const scope = { ...spec.constants, ...dials, ...run.outputs };

    const low = Math.min(playback.path.fromValue, playback.path.toValue);
    const high = Math.max(playback.path.fromValue, playback.path.toValue);
    for (const edge of [evaluate(band.from, scope), evaluate(band.to, scope)]) {
      assert.ok(
        edge >= low && edge <= high,
        `${act.id}: the target band at ${edge} falls off a path running ${low}…${high}`,
      );
    }

    // The same expression the scene moves the actor with.
    const last = run.samples.at(-1);
    assert.ok(last, `${act.id}: a traced run with no samples cannot be acted out`);
    const landed = evaluate(playback.along, { ...scope, ...last });
    assert.ok(
      landed >= evaluate(band.from, scope) && landed <= evaluate(band.to, scope),
      `${act.id}: the winning run ends at ${landed}, outside the span the floor shows`,
    );
    if (playback.lift) {
      assert.ok(
        Number.isFinite(evaluate(playback.lift, { ...scope, ...last })),
        `${act.id}: lift does not evaluate, so the flight has no height`,
      );
    }
  }
});

/**
 * The live acts step `Run` by the frame while `simulate` drives it in a loop.
 * If those two ever disagree, the act you played and the act the validator
 * scored are different games.
 */
test('a run driven step by step matches the one simulate() runs', async () => {
  const { Run, simulate } = await import('@chapter-quest/shared');
  const world = await loadWorld('world-ghat-9');

  for (const act of world.acts) {
    if (act.mechanic?.type !== 'formula') continue;
    const { spec, params } = act.mechanic;
    const dials = Object.fromEntries(params.map((p) => [p.name, p.solution]));

    const closed = simulate(spec, dials);
    const run = new Run(spec, dials);
    while (run.step());
    const driven = run.finish();

    assert.equal(driven.steps, closed.steps, `${act.id}: step counts differ`);
    assert.equal(driven.won, closed.won, `${act.id}: verdicts differ`);
    for (const [name, value] of Object.entries(closed.outputs)) {
      assert.ok(
        Math.abs(driven.outputs[name]! - value) < 1e-9,
        `${act.id}: ${name} is ${driven.outputs[name]} driven, ${value} simulated`,
      );
    }
  }
});

/**
 * The concept Act II exists to teach, asserted: braking later slides the whole
 * stop down the hill and never shortens it. If a rebalance ever breaks this,
 * the act still "works" but stops meaning anything.
 */
test('braking later moves the stop, it does not shorten it', async () => {
  const { Run } = await import('@chapter-quest/shared');
  const world = await loadWorld('world-ghat-9');
  const act = world.acts.find((a) => a.stage?.bindings.some((b) => b.kind === 'control'));
  assert.ok(act, 'no driven act to check');
  if (!act || act.mechanic?.type !== 'formula') return;

  const control = act.stage!.bindings.find((b) => b.kind === 'control')!;
  if (control.kind !== 'control') return;
  const { spec } = act.mechanic;

  /** Roll until `brakeAt`, then hold the brake all the way down. */
  const brakeAt = (distance: number) => {
    const run = new Run(spec, { [control.param]: 0 });
    while (!run.done) {
      run.set(control.param, (run.scope.x as number) >= distance ? control.held : 0);
      run.step();
    }
    return run.scope.x as number;
  };

  const early = brakeAt(60);
  const late = brakeAt(90);

  assert.ok(late > early, 'braking later must stop further down the hill');
  assert.ok(
    Math.abs(late - early - 30) < 1,
    `moving the brake 30 m later moved the stop by ${(late - early).toFixed(1)} m, not 30`,
  );
  assert.ok(
    Math.abs(late - 90 - (early - 60)) < 1,
    `the braking distance itself changed: ${(early - 60).toFixed(1)} m then ${(late - 90).toFixed(1)} m`,
  );

  // And the act is actually winnable by judging it, not only by the declared dial.
  const won = brakeAt(90);
  assert.ok(
    won >= spec.constants.sidingMouth! && won <= spec.constants.sidingEnd!,
    `braking at 90 m stops at ${won.toFixed(1)} m, outside the siding`,
  );
});
