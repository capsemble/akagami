import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mechanic, ParamSpec, SceneSpec, SimSpec } from '@chapter-quest/shared';
import { simulate } from '@chapter-quest/shared';
import { settleUnbound } from '../src/pipeline/balance.js';
import { bindStage, mapScene, stepsFor } from '../src/pipeline/mapper.js';

/** The rooms these acts are played in: a hall, two props, nothing special. */
const SPEC: SceneSpec = {
  name: 'Inspection table',
  description: 'A long table under a lamp',
  objects: [
    { id: 'bat', label: 'The spliced bat', look: 'willow and lead tape' },
    { id: 'knife-edge', label: 'Knife-edge', look: 'brass prism' },
  ],
  exitSide: 'east',
};
const scene = mapScene(SPEC, 'scene-balance', { verbs: ['plant_marker'] });

/** A bat balanced on a knife-edge, exactly as the writers' room wrote one. */
const KNIFE: { spec: SimSpec; params: ParamSpec[] } = {
  spec: {
    constants: { m1: 300, x1: 20, m2: 900, x2: 60 },
    state: { angle: '0', omega: '0' },
    step: {
      omega: 'omega + ((m1 * x1 + m2 * x2) / (m1 + m2) - knifePos) * 2.5 * dt',
      angle: 'angle + omega * dt',
    },
    outputs: { comX: '(m1 * x1 + m2 * x2) / (m1 + m2)', finalTilt: 'angle' },
    win: 'finalTilt >= -2 && finalTilt <= 2 && knifePos >= comX - 1 && knifePos <= comX + 1',
    dt: 0.05,
    maxTime: 4,
    until: 'angle > 25 || angle < -25',
  },
  params: [{ name: 'knifePos', min: 20, max: 60, default: 40, solution: 50, when: 'during' }],
};

/** A roller frame on its axle: a fixed front torque against a counterweight on an arm. */
const ROLLER: { spec: SimSpec; params: ParamSpec[] } = {
  spec: {
    constants: { frontTorque: 48, frameBias: 12, inertia: 30, damping: 1.2 },
    state: { angle: '0', omega: '0' },
    step: {
      omega:
        'omega + ((frontTorque + frameBias - counterMass * armLength) / inertia - damping * omega) * dt',
      angle: 'angle + omega * dt',
    },
    outputs: {
      netTorque: 'frontTorque + frameBias - counterMass * armLength',
      finalAngle: 'angle',
    },
    win: 'netTorque >= -1.5 && netTorque <= 1.5 && finalAngle >= -0.05 && finalAngle <= 0.05',
    dt: 0.05,
    maxTime: 10,
    until: 'angle > 0.6 || angle < -0.6',
  },
  params: [
    { name: 'counterMass', min: 10, max: 50, default: 20, solution: 40, when: 'before' },
    { name: 'armLength', min: 0.2, max: 2.5, default: 0.6, solution: 1.5, when: 'during' },
  ],
};

const formula = (m: { spec: SimSpec; params: ParamSpec[] }): Mechanic => ({
  type: 'formula',
  ...m,
});

test('a centre-of-mass act is staged as a beam, not a train on a rail', () => {
  const stage = bindStage(scene, {
    verbs: ['plant_marker'],
    mechanic: formula(KNIFE),
    dialogue: [{ line: 'Between twenty and sixty centimetres.' }],
  });
  const balance = stage?.balance;
  assert.ok(balance, 'no balance was recognised');
  assert.equal(stage.playback, undefined, 'it still drives something along a path');
  assert.equal(balance.pivot, 'knifePos');
  assert.equal(balance.tilt, 'angle');
  assert.equal(balance.tiltUnit, 'deg');
  assert.equal(balance.com, 'comX');
  assert.equal(balance.beam.unit, 'cm');
  assert.deepEqual(
    balance.loads.map((l) => [l.mass, l.at]),
    [
      ['m1', 'x1'],
      ['m2', 'x2'],
    ],
  );
  // Every load and the whole range of the knife-edge fit on the beam.
  assert.ok(balance.beam.fromValue <= 20 && balance.beam.toValue >= 60);
  assert.equal(
    stage.readout?.label,
    'centre of mass',
    'a centre of mass was reported as a distance',
  );
});

test('a torque act puts the counterweight behind the axle and the fixed torque in front', () => {
  const balance = bindStage(scene, { verbs: ['tune'], mechanic: formula(ROLLER) })?.balance;
  assert.ok(balance);
  assert.equal(balance.tiltUnit, 'rad');
  const counter = balance.loads.find((l) => l.mass === 'counterMass');
  assert.equal(counter?.at, '-armLength', 'a subtracted torque is on the other side of the pivot');
  const moment = balance.loads.find((l) => l.moment);
  assert.equal(moment?.moment, 'frontTorque + frameBias');
  assert.ok(Number(moment?.at) > 0);
});

test('every param of a balance gets a dial, so none is left frozen', () => {
  const stage = bindStage(scene, { verbs: ['tune'], mechanic: formula(ROLLER) });
  assert.deepEqual(
    stage?.bindings.map((b) => (b.kind === 'needle' ? b.param : b.kind)),
    ['counterMass', 'armLength'],
  );
  assert.ok(stepsFor(stage, scene)[0]!.includes('beam'));
});

test('a plain kinematics run is not mistaken for a balance', () => {
  const stage = bindStage(scene, {
    verbs: ['drive'],
    mechanic: {
      type: 'formula',
      spec: {
        constants: { mass: 1000, decel: 2 },
        state: { x: '0', v: 'u0' },
        step: { x: 'x + v * dt', v: 'max(0, v - (brake * decel) * dt)' },
        outputs: { stop: 'x' },
        win: 'stop >= 100 && stop <= 120',
        dt: 0.05,
        maxTime: 60,
      },
      params: [{ name: 'brake', min: 0, max: 1, default: 0, solution: 1 }],
    },
  });
  assert.equal(stage?.balance, undefined);
});

test('an act whose stage cannot reach a param still has a winning setting', () => {
  // Bind only the mass, as the marker stage used to: the arm sits at 0.6, and
  // 50 × 0.6 = 30 can never cancel 60.
  const stage = {
    bindings: [
      {
        kind: 'marker' as const,
        param: 'counterMass',
        path: { from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, fromValue: 10, toValue: 50 },
      },
    ],
  };
  const before = formula(ROLLER);
  const after = settleUnbound(before, stage);
  assert.equal(after.type, 'formula');
  if (after.type !== 'formula') return;
  const arm = after.params.find((p) => p.name === 'armLength')!;
  assert.equal(arm.default, arm.solution, 'the unbound arm was not held at a winnable value');
  assert.ok(simulate(after.spec, { counterMass: 40, armLength: arm.default }).won);
  // And a stage that binds everything is left exactly as it was.
  const full = bindStage(scene, { verbs: ['tune'], mechanic: before });
  assert.equal(settleUnbound(before, full), before);
});
