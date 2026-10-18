import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActSpec, GameScript, Mechanic, ParamBinding, World } from '@chapter-quest/shared';
import { simulate } from '@chapter-quest/shared';
import { bindStage, mapScene } from '../src/pipeline/mapper.js';
import { mocksDir, repoRoot } from '../src/paths.js';

/** Every param the player can actually reach from the stage's bindings. */
function tunable(bindings: ParamBinding[]): Set<string> {
  const names = new Set<string>();
  for (const binding of bindings) {
    if (binding.kind === 'aim') {
      names.add(binding.paramX);
      names.add(binding.paramY);
    } else if ('param' in binding) {
      names.add(binding.param);
    }
  }
  return names;
}

/**
 * The guarantee: an act can be won using only the dials it hands you.
 *
 * It could not. `bindStage` bound `params[0]` and left every other param
 * frozen at its default — and the writers' room writes a second param exactly
 * when the concept is a trade-off, so the second one always had to move. A
 * whole generated backend world shipped with three acts nobody could finish:
 * three dials the player could turn, three they could not, and the win needing
 * both. This is the test that was missing.
 */
function assertWinnable(act: ActSpec, where: string): void {
  const mechanic = act.mechanic as Mechanic | undefined;
  if (mechanic?.type !== 'formula') return;

  const scene = mapScene(act.scene, `scene-${act.id}`, { verbs: act.verbs });
  const stage = bindStage(scene, act);
  assert.ok(stage, `${where}: a formula act with no stage is a slider panel`);

  const reachable = tunable(stage.bindings);
  const frozen = mechanic.params.filter(
    (p) => !reachable.has(p.name) && p.default !== p.solution,
  );
  assert.equal(
    frozen.length,
    0,
    `${where}: ${frozen.map((p) => p.name).join(', ')} must change to win but no binding touches it`,
  );

  // And prove it, by playing the solution through the real evaluator using
  // only the dials the player has.
  const dials = Object.fromEntries(
    mechanic.params.map((p) => [p.name, reachable.has(p.name) ? p.solution : p.default]),
  );
  assert.ok(
    simulate(mechanic.spec, dials).won,
    `${where}: the solution does not win even with every bound dial set to it`,
  );
}

test('every act of a real design run can be won with the dials it gives you', async () => {
  const script = JSON.parse(
    await readFile(join(repoRoot, 'server/fixtures/fallback-script.json'), 'utf8'),
  ) as GameScript;
  for (const act of script.acts) assertWinnable(act, `fallback ${act.id}`);
});

/**
 * The shape that broke it: two params, both needed. Built by hand rather than
 * taken from a fixture, because the fixtures predate the bug and would have
 * gone on passing.
 */
test('a two-dial trade-off binds both dials', () => {
  const act = {
    id: 'act1',
    conceptId: 'queueing',
    title: 'The Weighing Choke',
    goal: 'Clear the queue without over-staffing.',
    verbs: ['tune', 'deduction'] as const,
    scene: {
      name: 'Toll gate',
      description: 'a gate',
      objects: [{ id: 'tally-board', label: 'Tally board', look: 'chalk' }],
      exitSide: 'south' as const,
    },
    mechanic: {
      type: 'formula' as const,
      spec: {
        constants: { arrivals: 90 },
        state: { queue: '0', t: '0' },
        step: {
          queue: 'queue + (arrivals - clerks * rate) * dt',
          t: 't + dt',
        },
        outputs: { endQueue: 'queue' },
        win: 'endQueue <= 0 && clerks <= 12 && rate == 20',
        dt: 1,
        maxTime: 10,
      },
      params: [
        { name: 'rate', min: 0, max: 60, default: 60, solution: 20 },
        { name: 'clerks', min: 1, max: 20, default: 4, solution: 11 },
      ],
    },
  } as unknown as ActSpec;

  const scene = mapScene(act.scene, 'scene-act1', { verbs: [...act.verbs] });
  const stage = bindStage(scene, act)!;
  const reachable = tunable(stage.bindings);
  assert.ok(reachable.has('rate'), 'the first dial is bound');
  assert.ok(reachable.has('clerks'), 'the second dial is bound — this is the one that broke');
  assertWinnable(act, 'two-dial trade-off');
});

/** Three is the ceiling: past that a board stops being an instrument. */
test('a board never grows more than three dials', async () => {
  const world = JSON.parse(
    await readFile(join(mocksDir, 'world.kinematics.json'), 'utf8'),
  ) as World;
  for (const act of world.acts) {
    const needles = (act.stage?.bindings ?? []).filter((b) => b.kind === 'needle');
    assert.ok(needles.length <= 3, `${act.id}: ${needles.length} dials is a spreadsheet`);
  }
});
