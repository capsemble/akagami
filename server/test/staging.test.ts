/**
 * How a generated act is staged: what moves, which way, and what SPACE does.
 *
 * Every `drive` act used to be a locomotive on rails with SPACE bound to the
 * first param and called a brake. A service lift going up 80 m was a train
 * rolling 80 m across the floor, and holding SPACE changed the lift's mass.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mechanic, SceneSpec, SimSpec } from '@chapter-quest/shared';
import { bindStage, mapScene, stepsFor } from '../src/pipeline/mapper.js';

const room = (objects: SceneSpec['objects']) =>
  mapScene({ name: 'Yard', description: 'A yard', objects, exitSide: 'east' }, 'scene-staging', {
    verbs: ['drive'],
  });

const formula = (spec: SimSpec, params: Extract<Mechanic, { type: 'formula' }>['params']) =>
  ({ type: 'formula', spec, params }) as Mechanic;

/** The lift exactly as the writers' room produced it from physics.md. */
const LIFT = formula(
  {
    constants: { targetHeight: 80, trueMass: 600 },
    state: { y: '0', v: '0' },
    step: { v: 'v + (netForce / liftMass) * dt', y: 'y + v * dt' },
    outputs: { finalHeight: 'y', accel: 'netForce / liftMass' },
    win: 'liftMass == trueMass && finalHeight >= targetHeight - 3 && finalHeight <= targetHeight + 3',
    dt: 0.05,
    maxTime: 8,
  },
  [
    { name: 'liftMass', min: 300, max: 900, default: 300, solution: 600, when: 'before' },
    { name: 'netForce', min: 300, max: 3000, default: 1500, solution: 1500, when: 'during' },
  ],
);

const SLIDE = formula(
  {
    constants: { mass: 100, muK: 0.2, g: 10 },
    state: { x: '0', v: '0.01' },
    step: { v: 'v + ((winchForce - muK * mass * g) / mass) * dt', x: 'x + v * dt' },
    outputs: { stopX: 'x' },
    win: 'stopX >= 14 && stopX <= 16',
    dt: 0.02,
    maxTime: 15,
    until: 'v <= 0',
  },
  [{ name: 'winchForce', min: 250, max: 750, default: 300, solution: 500, when: 'during' }],
);

test('a lift goes up a shaft, SPACE is the thrust, and the mass is set at the board', () => {
  const scene = room([
    { id: 'throttle', label: 'Thruster force throttle', look: 'brass lever' },
    { id: 'lift', label: 'Loaded service lift', look: 'iron cage' },
  ]);
  const act = { verbs: ['tune', 'drive'] as const, mechanic: LIFT, title: 'The Service Lift' };
  const stage = bindStage(scene, { ...act, verbs: [...act.verbs] })!;
  const control = stage.bindings.find((b) => b.kind === 'control');
  assert.equal(
    control?.kind === 'control' && control.param,
    'netForce',
    'SPACE is on the wrong param',
  );
  assert.ok(
    stage.bindings.some((b) => b.kind === 'needle' && b.param === 'liftMass'),
    'the mass has no dial',
  );
  assert.equal(stage.playback?.actor, 'body');
  assert.equal(stage.playback?.shaft, true, 'a height was laid along the floor');
  assert.equal(stage.playback?.descends, undefined);
  const lift = scene.interactables.find((it) => it.id === 'lift')!;
  assert.equal(
    stage.playback?.path.from.x,
    Math.round(lift.x + lift.w / 2),
    'the shaft is not at the lift',
  );

  const steps = stepsFor(stage, scene).join(' ');
  assert.doesNotMatch(steps, /brake/i, 'a thrust was described as a brake');
  assert.match(steps, /net force/);
  assert.match(steps, /set the lift mass/);
});

test('something lowered goes down its shaft', () => {
  const scene = room([{ id: 'winch', label: 'Hoist winch', look: 'drum' }]);
  const stage = bindStage(scene, {
    verbs: ['drive'],
    mechanic: LIFT,
    title: 'The Pit',
    goal: 'Lower the descending coal cage at a steady speed.',
  });
  assert.equal(stage?.playback?.shaft, true);
  assert.equal(stage?.playback?.descends, true);
});

test('a load dragged across a floor slides on a lane from where it stands, not a train', () => {
  const scene = room([
    { id: 'cable-winch', label: 'Motorized cable winch', look: 'motor' },
    { id: 'diamond-case', label: '100 kg diamond case', look: 'steel case' },
  ]);
  const stage = bindStage(scene, {
    verbs: ['drive'],
    mechanic: SLIDE,
    title: 'The Corridor Slide',
  })!;
  assert.equal(stage.playback?.actor, 'body');
  assert.equal(stage.playback?.track, 'lane');
  assert.ok(!stage.playback?.shaft);
  const control = stage.bindings[0];
  assert.equal(control?.kind === 'control' && control.label, 'winch force');
  const steps = stepsFor(stage, scene).join(' ');
  assert.doesNotMatch(steps, /brake/i);
});

test('rails are kept for the things that run on them', () => {
  const scene = room([{ id: 'brake-lever', label: 'Wagon brake', look: 'iron lever' }]);
  const stage = bindStage(scene, {
    verbs: ['drive'],
    mechanic: formula(
      {
        constants: { decel: 2 },
        state: { x: '0', v: '20' },
        step: { v: 'v - brake * decel * dt', x: 'x + v * dt' },
        outputs: { stopX: 'x' },
        win: 'stopX >= 90 && stopX <= 110',
        dt: 0.05,
        maxTime: 60,
        until: 'v <= 0',
      },
      [{ name: 'brake', min: 0, max: 1, default: 0, solution: 1, when: 'during' }],
    ),
    title: 'The Runaway Wagon',
    goal: 'Stop the wagon in the siding.',
  })!;
  assert.equal(stage.playback?.actor, 'train');
  assert.match(stepsFor(stage, scene).join(' '), /Hold SPACE to brake/);
});

test('a lever written with forces and arms from a sliding pivot is a beam', () => {
  const scene = room([{ id: 'beam', label: 'Locking beam', look: 'steel' }]);
  const stage = bindStage(scene, {
    verbs: ['plant_marker', 'tune'],
    mechanic: formula(
      {
        constants: { boltForce: 750, beamLength: 6, inertia: 300 },
        state: { angle: '0', omega: '0' },
        step: {
          omega:
            'omega + ((bagForce * (beamLength - pivotDist) - boltForce * pivotDist) / inertia) * dt',
          angle: 'angle + omega * dt',
        },
        outputs: {
          boltTorque: 'boltForce * pivotDist',
          bagTorque: 'bagForce * (beamLength - pivotDist)',
          netTorque: 'bagTorque - boltTorque',
        },
        win: 'netTorque >= -15 && netTorque <= 15 && angle >= -0.15 && angle <= 0.15',
        dt: 0.05,
        maxTime: 4,
      },
      [
        { name: 'pivotDist', min: 0.5, max: 4.5, default: 3, solution: 1, when: 'before' },
        { name: 'bagForce', min: 50, max: 250, default: 150, solution: 150, when: 'during' },
      ],
    ),
  });
  const balance = stage?.balance;
  assert.ok(balance, 'the lever was staged as something else');
  assert.equal(stage.playback, undefined);
  assert.equal(balance.pivot, 'pivotDist');
  const at = Object.fromEntries(balance.loads.map((l) => [l.mass, l.at]));
  assert.deepEqual(at, { boltForce: '0', bagForce: 'beamLength' });
  assert.ok(
    balance.loads.every((l) => l.force),
    'forces in newtons were drawn as kilograms',
  );
});
