import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GameScript, Mechanic, SceneSpec, Verb, World } from '@chapter-quest/shared';
import { bindStage, mapScene, walkable } from '../src/pipeline/mapper.js';
import { mocksDir, repoRoot } from '../src/paths.js';

const read = async <T>(...p: string[]): Promise<T> =>
  JSON.parse(await readFile(join(...p), 'utf8')) as T;

/** The SceneSpecs a real design run actually produced. */
async function realSpecs(): Promise<{ id: string; spec: SceneSpec; verbs: Verb[] }[]> {
  const script = await read<GameScript>(repoRoot, 'server/fixtures/fallback-script.json');
  return script.acts.map((act) => ({
    id: `scene-${act.id}`,
    spec: act.scene,
    verbs: act.verbs,
  }));
}

test('every room a real SceneSpec produces is walkable', async () => {
  for (const { id, spec, verbs } of await realSpecs()) {
    const scene = mapScene(spec, id, { verbs, castIds: ['rane', 'dalvi'] });
    const check = walkable(scene);
    assert.ok(
      check.ok,
      `${spec.name}: cannot reach ${check.unreachable.join(', ')} from the spawn`,
    );
    assert.ok(scene.interactables.length === spec.objects.length, `${spec.name}: lost an object`);
  }
});

test('nothing is placed in a wall or outside the plane', async () => {
  for (const { id, spec, verbs } of await realSpecs()) {
    const scene = mapScene(spec, id, { verbs, castIds: ['rane', 'dalvi'] });
    const inside = (x: number, y: number) =>
      x >= 0 && y >= 0 && x <= scene.width && y <= scene.height;

    for (const it of scene.interactables) {
      assert.ok(inside(it.x, it.y) && inside(it.x + it.w, it.y + it.h), `${it.id} is off-plane`);
    }
    // Objects must not sit on top of each other, or E picks the wrong one.
    for (let i = 0; i < scene.interactables.length; i++) {
      for (let j = i + 1; j < scene.interactables.length; j++) {
        const a = scene.interactables[i]!;
        const b = scene.interactables[j]!;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        assert.ok(apart, `${a.id} and ${b.id} overlap`);
      }
    }
    assert.ok(inside(scene.spawn.x, scene.spawn.y), 'spawn is off-plane');
  }
});

test('the exit lands on the side the spec asked for', async () => {
  const sides: SceneSpec['exitSide'][] = ['north', 'south', 'east', 'west'];
  for (const exitSide of sides) {
    const spec: SceneSpec = {
      name: `Room ${exitSide}`,
      description: 'a room',
      objects: [{ id: 'desk', label: 'a desk', look: 'teak' }],
      exitSide,
    };
    const scene = mapScene(spec, `scene-${exitSide}`, {});
    const exit = scene.exits[0]!;
    const cx = exit.x + exit.w / 2;
    const cy = exit.y + exit.h / 2;
    if (exitSide === 'north') assert.ok(cy < scene.height / 2, 'north exit is not north');
    if (exitSide === 'south') assert.ok(cy > scene.height / 2, 'south exit is not south');
    if (exitSide === 'west') assert.ok(cx < scene.width / 2, 'west exit is not west');
    if (exitSide === 'east') assert.ok(cx > scene.width / 2, 'east exit is not east');
    assert.ok(walkable(scene).ok, `${exitSide}: room is not walkable`);
  }
});

test('the same spec always lays out the same room', async () => {
  const { id, spec, verbs } = (await realSpecs())[0]!;
  const a = mapScene(spec, id, { verbs, castIds: ['rane'] });
  const b = mapScene(spec, id, { verbs, castIds: ['rane'] });
  assert.deepEqual(a, b, 'a world must not rearrange itself between runs');
});

/** The kinematics mechanics, paired with rooms the mapper builds for them. */
async function kinematicsActs() {
  const world = await read<World>(mocksDir, 'world.kinematics.json');
  return world.acts.map((act) => ({
    id: act.id,
    verbs: act.verbs,
    mechanic: act.mechanic as Mechanic,
  }));
}

test('each verb picks the binding it has always meant', async () => {
  const expected: Record<string, string> = { act1: 'needle', act2: 'control', act3: 'aim' };

  for (const act of await kinematicsActs()) {
    const spec: SceneSpec = {
      name: act.id,
      description: 'generated',
      objects: [
        { id: 'board', label: 'a board', look: 'teak' },
        { id: 'lever', label: 'a lever', look: 'iron' },
      ],
      exitSide: 'south',
    };
    const scene = mapScene(spec, `scene-${act.id}`, { verbs: act.verbs });
    const stage = bindStage(scene, act);

    assert.ok(stage, `${act.id}: a formula act with no stage falls back to sliders`);
    assert.equal(stage.bindings[0]?.kind, expected[act.id], `${act.id}: wrong binding`);

    for (const binding of stage.bindings) {
      const used =
        binding.kind === 'aim'
          ? [binding.paramX, binding.paramY]
          : [(binding as { param: string }).param];
      const names = new Set(
        act.mechanic.type === 'formula' ? act.mechanic.params.map((p) => p.name) : [],
      );
      for (const name of used) assert.ok(names.has(name), `${act.id}: bound unknown param ${name}`);
    }
  }
});

/**
 * The lane has to be long enough for the run that wins on it. Measure it too
 * short and the winning stop is drawn off the end of the track, which looks
 * exactly like a bug and is one.
 */
test('a generated lane is long enough for the winning run', async () => {
  const { evaluate, simulate } = await import('@chapter-quest/shared');

  for (const act of await kinematicsActs()) {
    if (act.mechanic.type !== 'formula') continue;
    const spec: SceneSpec = {
      name: act.id,
      description: 'generated',
      objects: [{ id: 'launcher', label: 'a launcher', look: 'timber' }],
      exitSide: 'south',
    };
    const scene = mapScene(spec, `scene-${act.id}`, { verbs: act.verbs });
    const stage = bindStage(scene, act);
    const playback = stage?.playback;
    if (!playback) continue;

    const dials = Object.fromEntries(act.mechanic.params.map((p) => [p.name, p.solution]));
    const run = simulate(act.mechanic.spec, dials, { trace: true });
    const last = run.samples.at(-1)!;
    const landed = evaluate(playback.along, { ...act.mechanic.spec.constants, ...dials, ...last });

    assert.ok(
      landed >= playback.path.fromValue && landed <= playback.path.toValue,
      `${act.id}: winning run reaches ${landed.toFixed(1)}, lane covers ${playback.path.fromValue}…${playback.path.toValue}`,
    );
  }
});

test('a room with no objects at all still works', () => {
  const scene = mapScene(
    { name: 'Empty', description: 'nothing here', objects: [], exitSide: 'north' },
    'scene-empty',
    { castIds: ['rane'] },
  );
  assert.equal(scene.interactables.length, 0);
  assert.ok(walkable(scene).ok, 'an empty room is still a room');
});
