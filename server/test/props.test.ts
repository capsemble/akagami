import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GameScript, PropKind, Scene, SceneObject } from '@chapter-quest/shared';
import { propFootprint, propKindFor, propLabel, propTint } from '@chapter-quest/shared';
import { mapScene } from '../src/pipeline/mapper.js';
import { mocksDir, repoRoot } from '../src/paths.js';

const PROP = { w: 180, h: 110, height: 120 };

/**
 * The props in the hand-written scenes. These are the six the player has in
 * front of them in the kinematics world, and each one is the whole reason its
 * silhouette exists — if the brake lever stops being a lever, the act turns
 * back into an unlabelled block.
 */
test('every prop in the kinematics world is drawn as what it is', async () => {
  const expected: Record<string, PropKind> = {
    'deduction-board': 'board',
    'signed-timetable': 'document',
    'brake-lever': 'lever',
    'water-tank': 'tank',
    'satchel-launcher': 'launcher',
    'far-ledge': 'ledge',
  };

  for (const file of ['scene-signal-box', 'scene-falling-grade', 'scene-gorge']) {
    const scene = JSON.parse(
      await readFile(join(mocksDir, 'scenes', `${file}.json`), 'utf8'),
    ) as Scene;
    for (const target of scene.interactables) {
      const want = expected[target.id];
      assert.ok(want, `${file}: ${target.id} is not in the table — add it`);
      assert.equal(propKindFor(target), want, `${target.id} drew as the wrong thing`);
    }
  }
});

/** The same table, against objects a design run actually wrote. */
test('the props a real design run names all get a silhouette', async () => {
  const script = JSON.parse(
    await readFile(join(repoRoot, 'server/fixtures/fallback-script.json'), 'utf8'),
  ) as GameScript;
  const objects = script.acts.flatMap((act) => act.scene.objects);
  const expected: Record<string, PropKind> = {
    'cutting-frame': 'console',
    'torn-pile': 'document',
    satchel: 'crate',
    'rank-ledger': 'document',
    'claim-board': 'board',
    'blue-flame': 'lamp',
  };

  for (const object of objects) {
    assert.equal(propKindFor(object), expected[object.id], `${object.id} drew as the wrong thing`);
  }
});

/**
 * The near-misses, which are the whole reason the matcher is not a substring
 * test. Every one of these was wrong at some point while the table was written.
 */
test('a near-miss word does not steal a prop', () => {
  const cases: [SceneObject, PropKind][] = [
    // "ledger" starts with "ledge". It put the rank ledger on a stone slab.
    [{ id: 'rank-ledger', label: 'Rank ledger', look: 'open on the desk' }, 'document'],
    // A lever is a lever even where there are also dials to read.
    [{ id: 'brake-lever', label: 'Brake lever', look: 'iron, beside a row of gauges' }, 'lever'],
    // The look is decoration; the name says what the thing is.
    [{ id: 'satchel', label: "The Oracle's satchel", look: 'brass count-dial' }, 'crate'],
    // Plurals still hit.
    [{ id: 'torn-pile', label: 'Torn scrolls', look: 'under lead bars' }, 'document'],
    [{ id: 'west-shelves', label: 'Shelves', look: 'oak' }, 'shelf'],
  ];
  for (const [object, want] of cases) {
    assert.equal(propKindFor(object), want, `${object.id} drew as the wrong thing`);
  }
});

test('an unrecognised prop is still varied, and stable', () => {
  const odd = ['glim', 'thrum', 'vorp', 'quex', 'zand', 'brel', 'phax', 'nuld'];
  const kinds = odd.map((id) => propKindFor({ id }));
  assert.ok(new Set(kinds).size > 1, 'every unknown prop drew as the same thing');
  for (const id of odd) {
    assert.equal(propKindFor({ id }), propKindFor({ id }), `${id} is not stable`);
  }
});

test('a plate says something a player can read', () => {
  assert.equal(propLabel({ id: 'brake-lever' }), 'Brake lever');
  assert.equal(propLabel({ id: 'x', label: 'the signed timetable' }), 'Signed timetable');
  assert.equal(propLabel({ id: 'x', label: '  ' }), 'X', 'a blank label falls back to the id');
});

test('a material in the look picks the colour', () => {
  const iron = propTint({ id: 'a', look: 'cast iron and soot' });
  const oak = propTint({ id: 'a', look: 'oak, waxed' });
  assert.notEqual(iron, oak, 'iron and oak came out the same colour');
  // No material named, so the kind decides — and two kinds must not collide.
  assert.notEqual(propTint({ id: 'a-lamp' }), propTint({ id: 'a-crate' }));
});

/**
 * The footprint and the drawing have to agree. The renderer draws a board
 * across the full width of its rect, so if the mapper handed a board a square
 * rect the art would be a board squashed into a crate's footprint.
 */
test('a prop is given the footprint its shape needs', () => {
  const board = propFootprint({ id: 'claim-board' }, PROP);
  const pillar = propFootprint({ id: 'stone-pillar' }, PROP);
  assert.ok(board.w > board.h * 2, 'a board should be wide and shallow');
  assert.ok(Math.abs(pillar.w - pillar.h) < pillar.w * 0.3, 'a pillar should be roughly square');
  assert.ok(pillar.height > board.h, 'a pillar should stand taller than a board is deep');

  for (const id of ['a', 'bb', 'ccc', 'dddd']) {
    const size = propFootprint({ id }, PROP);
    assert.ok(size.w > 0 && size.h > 0 && size.height > 0, `${id} got a zero footprint`);
  }
});

/** And the mapper has to actually use it, or none of the above reaches the screen. */
test('the mapper sizes a generated room from the prop shapes', () => {
  const scene = mapScene(
    {
      name: 'Mixed',
      description: 'a room with two very different things in it',
      objects: [
        { id: 'claim-board', label: 'Claim board', look: 'cork' },
        { id: 'water-tank', label: 'Water tank', look: 'riveted iron' },
      ],
      exitSide: 'south',
    },
    'scene-mixed',
    { castIds: ['rane'] },
  );

  const board = scene.interactables.find((it) => it.id === 'claim-board')!;
  const tank = scene.interactables.find((it) => it.id === 'water-tank')!;
  assert.ok(board.w > tank.w, 'the board should be the wider of the two');
  assert.ok(board.h < tank.h, 'the board should be the shallower of the two');
  assert.ok((tank.height ?? 0) > (board.height ?? 0) * 0.9, 'the tank should stand tall');
  assert.equal(board.label, 'Claim board', 'the label has to survive the mapper');
  assert.equal(tank.look, 'riveted iron', 'the look has to survive the mapper');
});
