import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mechanic, ParamSpec, SceneSpec, SimSpec, Verb } from '@chapter-quest/shared';
import { Run, gradeRun, simulate, winningBand } from '@chapter-quest/shared';
import { bindStage, controlledDuring, mapScene } from '../src/pipeline/mapper.js';

// The three acts of the Newton world, verbatim from its cached script. They
// cover the three cases that matter: a balance held live (the cage), a choice
// made before the run (the lorry's mass), and a brake point driven live (the
// siding).

const cage: SimSpec = {
  constants: { massTons: 18, g: 10, v0: 2 },
  state: { y: '0', v: 'v0' },
  step: { v: 'v + (massTons * g - cableTension) / massTons * dt', y: 'y + v * dt' },
  outputs: { finalSpeed: 'v', speedDrift: 'v - v0' },
  win: 'speedDrift >= -0.2 && speedDrift <= 0.2',
  dt: 0.05,
  maxTime: 5,
};
const cageParams: ParamSpec[] = [
  { name: 'cableTension', min: 120, max: 220, default: 144, solution: 180 },
];

const lorry: SimSpec = {
  constants: { netForceKn: 18, v0: 6, targetV: 12 },
  state: { v: 'v0', x: '0' },
  step: { v: 'v + (netForceKn / lorryMassTonnes) * dt', x: 'x + v * dt' },
  outputs: { finalV: 'v', impliedAccel: 'netForceKn / lorryMassTonnes' },
  win: 'finalV >= targetV - 0.3 && finalV <= targetV + 0.3',
  dt: 0.05,
  maxTime: 10,
};
const lorryParams: ParamSpec[] = [
  { name: 'lorryMassTonnes', min: 10, max: 40, default: 15, solution: 30 },
];

const siding: SimSpec = {
  constants: { massTonne: 20, v0: 10, dragKn: 30, scaleNear: 96, scaleFar: 104 },
  state: { x: '0', v: 'v0' },
  step: { v: 'v + ((winchPullKn - dragKn) / massTonne) * dt', x: 'x + v * dt' },
  outputs: { stopX: 'x' },
  win: 'v <= 0.05 && stopX >= scaleNear && stopX <= scaleFar',
  dt: 0.05,
  maxTime: 40,
  until: 'v <= 0',
};
const sidingParams: ParamSpec[] = [
  { name: 'winchPullKn', min: 0, max: 30, default: 5, solution: 20 },
];

const room: SceneSpec = {
  name: 'Siding',
  description: 'A wet siding.',
  objects: [{ id: 'winch', label: 'Winch', look: 'cast iron' }],
  exitSide: 'south',
};

const formula = (spec: SimSpec, params: ParamSpec[]): Mechanic => ({
  type: 'formula',
  spec,
  params,
});

const close = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: ${actual} is not within ${tolerance} of ${expected}`,
  );

/** Drive a run frame by frame at 60 fps, the way the scene does. */
function drive(
  spec: SimSpec,
  start: Record<string, number>,
  hand: (run: Run) => Record<string, number>,
) {
  const run = new Run(spec, start);
  let frames = 0;
  while (!run.done && frames < 60 * 120) {
    run.advance(1 / 60, hand(run));
    frames++;
  }
  return run.finish();
}

// --- the medal band --------------------------------------------------------

test('the winning span is measured off the solution, not parsed from the win', () => {
  const band = winningBand(siding, sidingParams, 'stopX');
  assert.ok(band, 'the siding has a band');
  close(band.from, 96, 0.01, 'near edge');
  close(band.to, 104, 0.01, 'far edge');

  const drift = winningBand(cage, cageParams, 'speedDrift');
  assert.ok(drift, 'the cage has a band');
  close(drift.from, -0.2, 0.001, 'low edge');
  close(drift.to, 0.2, 0.001, 'high edge');
});

test('an output the verdict does not turn on has no band', () => {
  // Judged on the state directly: sliding stopX changes nothing, so a medal
  // for it would be a medal for nothing.
  const blind: SimSpec = { ...siding, win: 'v <= 0.05 && x >= scaleNear && x <= scaleFar' };
  assert.equal(winningBand(blind, sidingParams, 'stopX'), null);
  assert.equal(winningBand(siding, sidingParams, 'notAnOutput'), null);
});

test('medals ring the middle of the band, and a miss says by how much', () => {
  const band = { from: 96, to: 104 };
  assert.equal(gradeRun(100, band).medal, 'gold');
  assert.equal(gradeRun(98, band).medal, 'silver');
  assert.equal(gradeRun(96.5, band).medal, 'bronze');
  assert.deepEqual([gradeRun(105, band).medal, gradeRun(105, band).miss], [null, 1]);
  assert.deepEqual([gradeRun(90, band).medal, gradeRun(90, band).miss], [null, -6]);
});

// --- which dials stay in hand ----------------------------------------------

test('a control goes live; the situation stays a choice', () => {
  assert.equal(
    controlledDuring(cageParams[0]!, cage),
    true,
    'cable tension is a hand on the brake',
  );
  assert.equal(
    controlledDuring(sidingParams[0]!, siding),
    true,
    'winch pull is a hand on the winch',
  );
  assert.equal(
    controlledDuring(lorryParams[0]!, lorry),
    false,
    'a lorry does not change mass mid-run',
  );
  const claimed = { name: 'claimedClerkRate', min: 0, max: 10, default: 2, solution: 5 };
  const queue: SimSpec = { ...siding, step: { x: 'x + claimedClerkRate * dt', v: 'v' } };
  assert.equal(controlledDuring(claimed, queue), false, 'a claimed figure is not a control');
});

test("the act writer's word beats the name, but never the physics", () => {
  const mass = { ...lorryParams[0]!, when: 'during' as const };
  assert.equal(controlledDuring(mass, lorry), true, 'told it is a control, it is one');
  const tension = { ...cageParams[0]!, when: 'before' as const };
  assert.equal(controlledDuring(tension, cage), false, 'told it is a choice, it is one');
  // A "control" no step equation reads would do nothing while the run plays.
  const idle = {
    name: 'brakeForce',
    min: 0,
    max: 10,
    default: 1,
    solution: 5,
    when: 'during' as const,
  };
  assert.equal(controlledDuring(idle, siding), false);
});

test('the Newton world binds two acts to drive and one to choose', () => {
  const live = (spec: SimSpec, params: ParamSpec[], verbs: Verb[]) => {
    const stage = bindStage(mapScene(room, 'scene-x', { verbs }), {
      verbs,
      mechanic: formula(spec, params),
    });
    assert.ok(stage?.playback, 'something moves, so there is a route');
    return stage.bindings.map((b) => (b.kind === 'needle' ? Boolean(b.live) : null));
  };
  assert.deepEqual(live(cage, cageParams, ['tune', 'deduction']), [true]);
  assert.deepEqual(live(lorry, lorryParams, ['deduction', 'tune']), [false]);
  assert.deepEqual(live(siding, sidingParams, ['tune', 'intercept']), [true]);
});

// --- a live act can always be won ------------------------------------------

test('a live lever left at the solution plays the run the validator scored', () => {
  for (const [spec, params] of [
    [cage, cageParams],
    [siding, sidingParams],
  ] as const) {
    const solution = Object.fromEntries(params.map((p) => [p.name, p.solution]));
    const driven = drive(spec, solution, () => solution);
    const scored = simulate(spec, solution);
    assert.equal(driven.won, true);
    assert.equal(driven.won, scored.won);
    for (const [name, value] of Object.entries(scored.outputs)) {
      close(driven.outputs[name]!, value, 1e-9, name);
    }
  }
});

test('driving it is a real game: coast, then brake at the right moment, and it lands', () => {
  // Pull 30 kN cancels the 30 kN of drag, so she coasts at 10 m/s. Let go and
  // she sheds 1.5 m/s², stopping 33 m later. Let go at 68 m: a stop at ~101 m.
  const release = (at: number) =>
    drive(siding, { winchPullKn: 30 }, (run) => ({
      winchPullKn: (run.scope.x as number) < at ? 30 : 0,
    }));

  const timed = release(68);
  assert.equal(timed.won, true, `released at 68 m, stopped at ${timed.outputs.stopX}`);
  assert.equal(gradeRun(timed.outputs.stopX!, { from: 96, to: 104 }).medal, 'gold');

  const late = release(80);
  assert.equal(late.won, false, 'let go 12 m late and she overruns the scale');
  assert.ok(late.outputs.stopX! > 104);
});

test('the cage can be caught and steadied by hand, not only by knowing 180', () => {
  // Start slack, let her gather speed, then over-brake back down and settle on
  // the weight. The verdict only asks where the drift ends, so a correction
  // counts — which is what holding a load steady actually is.
  const caught = drive(cage, { cableTension: 150 }, (run) => {
    const t = run.time;
    const v = run.scope.v as number;
    if (t < 1) return { cableTension: 150 };
    if (v > 2.02) return { cableTension: 200 };
    return { cableTension: 180 };
  });
  assert.equal(caught.won, true, `drift ended at ${caught.outputs.speedDrift}`);
});
