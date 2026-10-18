/**
 * The Impossible Machine: a lever that has to lift a crate onto a platform.
 *
 * The level is data — a SimSpec and a balance stage in mocks/world.machine.json
 * — so these tests check the data the game actually ships: that its physics is
 * the textbook physics, that its win is the stated objective and nothing else,
 * and that what the game says after a run matches what the run did.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Act, Mechanic, SimSpec, World } from '@chapter-quest/shared';
import { checkBalance, explainBalance, simulate } from '@chapter-quest/shared';
import { mocksDir } from '../src/paths.js';

const world = JSON.parse(await readFile(join(mocksDir, 'world.machine.json'), 'utf8')) as World;
type Formula = Extract<Mechanic, { type: 'formula' }>;
const acts = world.acts.map((act) => ({ act, mechanic: act.mechanic as Formula }));

/** The closed form, written out independently of the spec's expressions. */
function expected(spec: SimSpec, v: Record<string, number>) {
  const c = { ...spec.constants, ...v } as Record<string, number>;
  const H = c.fulcrumHeight!;
  const dCrate = c.xCrate! - c.pivot!;
  const dWeight = c.pivot! - c.xWeight!;
  const crateTorque = c.crateMass! * c.g! * dCrate;
  const weightTorque = c.counterweight! * c.g! * dWeight;
  // At rest the crate's end is on the floor; if it moves, it swings until the
  // counterweight's end is: sin θ = H / (distance from the fulcrum to that end).
  const moves = weightTorque > crateTorque;
  const height = moves
    ? H + dCrate * (H / (c.pivot! - c.beamStart!))
    : H - dCrate * (H / (c.beamEnd! - c.pivot!));
  return {
    crateTorque,
    weightTorque,
    moves,
    height,
    wins: moves && height >= c.platformH! - 0.0005,
  };
}

const values = (mechanic: Formula, pick: 'default' | 'solution') =>
  Object.fromEntries(mechanic.params.map((p) => [p.name, p[pick]]));

test('every setting on the grid wins exactly when the closed form says it should', () => {
  for (const { act, mechanic } of acts) {
    const heights = act.id === 'act2' ? [0.4, 0.5, 0.6, 0.7, 0.8] : [undefined];
    let checked = 0;
    for (let pivot = 1.5; pivot <= 3.7 + 1e-9; pivot += 0.05) {
      for (let counterweight = 20; counterweight <= 80; counterweight += 2) {
        for (const fulcrumHeight of heights) {
          const v = { pivot, counterweight, ...(fulcrumHeight ? { fulcrumHeight } : {}) };
          const run = simulate(mechanic.spec, v);
          const want = expected(mechanic.spec, v);
          assert.equal(run.won, want.wins, `${act.id} ${JSON.stringify(v)}`);
          checked++;
        }
      }
    }
    assert.ok(checked > 1000);
  }
});

test('torques are m · g · d about the fulcrum, and the final height is the geometry', () => {
  for (const { mechanic } of acts) {
    for (const pick of ['default', 'solution'] as const) {
      const v = values(mechanic, pick);
      const run = simulate(mechanic.spec, v);
      const want = expected(mechanic.spec, v);
      assert.ok(Math.abs(run.outputs.crateTorque! - want.crateTorque) < 1e-9);
      assert.ok(Math.abs(run.outputs.weightTorque! - want.weightTorque) < 1e-9);
      assert.ok(Math.abs(run.outputs.netTorque! - (want.weightTorque - want.crateTorque)) < 1e-9);
      assert.ok(Math.abs(run.outputs.crateHeight! - want.height) < 1e-9, `${pick}: height`);
    }
  }
});

test('the defaults lift the crate but not far enough; the stored solution delivers it', () => {
  for (const { act, mechanic } of acts) {
    const start = simulate(mechanic.spec, values(mechanic, 'default'));
    assert.equal(start.won, false, `${act.id} is won before the player touches it`);
    assert.ok(
      start.outputs.netTorque! > 0,
      'the first attempt should move, so there is something to watch',
    );
    const solved = simulate(mechanic.spec, values(mechanic, 'solution'));
    assert.equal(solved.won, true, `${act.id}'s solution does not win`);
  }
});

test('not enough torque means nothing moves at all', () => {
  const { mechanic } = acts[0]!;
  const v = { pivot: 2.0, counterweight: 20 };
  const run = simulate(mechanic.spec, v, { trace: true });
  const first = run.samples[0]!.s!;
  const last = run.samples[run.samples.length - 1]!.s!;
  assert.ok(run.outputs.netTorque! < 0);
  assert.equal(last, first, 'the beam moved without the torque to move it');
  assert.equal(run.won, false);
});

test('the stage is valid, binds every param, and is the one the player is shown', () => {
  for (const { act, mechanic } of acts) {
    const stage = (act as Act).stage!;
    assert.deepEqual(checkBalance(stage.balance!, mechanic.spec, mechanic.params), []);
    const bound = new Set(stage.bindings.map((b) => (b.kind === 'aim' ? b.paramX : b.param)));
    for (const p of mechanic.params)
      assert.ok(bound.has(p.name), `${act.id}: ${p.name} has no control`);
    assert.equal(stage.balance!.target?.cargo, 'crateMass');
  }
});

test('a broken balance config is caught, not drawn', () => {
  const { act, mechanic } = acts[0]!;
  const balance = act.stage!.balance!;
  const problems = checkBalance(
    {
      ...balance,
      tilt: 'nope',
      target: { ...balance.target!, output: 'missing', cargo: 'ghost' },
      loads: [...balance.loads, { label: 'stray', mass: '50', at: '9' }],
    },
    mechanic.spec,
    mechanic.params,
  );
  assert.ok(problems.some((p) => p.includes('tilt')));
  assert.ok(problems.some((p) => p.includes('missing')));
  assert.ok(problems.some((p) => p.includes('ghost')));
  assert.ok(problems.some((p) => p.includes('off the beam')));
});

test('what the game says after a run matches what the run did', () => {
  const say = (act: (typeof acts)[number], v: Record<string, number>) => {
    const run = simulate(act.mechanic.spec, v, { trace: true });
    const last = run.samples[run.samples.length - 1]!;
    return {
      run,
      text: explainBalance(act.act.stage!.balance!, act.mechanic.spec, v, {
        won: run.won,
        tilt: Math.asin(last.s!),
        outputs: last,
      }),
    };
  };
  const [one, two] = acts as [(typeof acts)[number], (typeof acts)[number]];

  const stuck = say(one, { pivot: 2.0, counterweight: 20 });
  assert.match(stuck.text, /nothing moves/);
  assert.doesNotMatch(stuck.text, /lifted/);

  const short = say(one, values(one.mechanic, 'default'));
  assert.match(short.text, /only rose to 0\.64 m/);
  assert.match(short.text, /move the fulcrum away/);
  // Act one has no control for the fulcrum's height: never suggest one.
  assert.doesNotMatch(short.text, /higher/);
  assert.match(say(two, values(two.mechanic, 'default')).text, /build the fulcrum higher/);

  const won = say(one, values(one.mechanic, 'solution'));
  assert.equal(won.run.won, true);
  assert.match(won.text, /0\.85 m/);
  assert.match(won.text, /trades force for distance/);
});
