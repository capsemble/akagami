import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SceneSpec, Verb } from '@chapter-quest/shared';
import { mapScene, walkable } from '../src/pipeline/mapper.js';

// The exit is a gate now: shut until the act is won, then the only way on. A
// gate you can back straight through is not a journey, so the player arrives
// on the far side of the room and has to cross it — past the act — to leave.

const sides: SceneSpec['exitSide'][] = ['north', 'south', 'east', 'west'];
const shapes: { name: string; verbs: Verb[] }[] = [
  { name: 'room', verbs: ['tune'] },
  { name: 'hall', verbs: ['drive'] },
];

for (const shape of shapes) {
  for (const exitSide of sides) {
    test(`a ${shape.name} with its gate to the ${exitSide} is crossed to be left`, () => {
      const spec: SceneSpec = {
        name: `A ${shape.name}`,
        description: 'Somewhere with a way out.',
        objects: [
          { id: 'lever', label: 'Lever', look: 'iron' },
          { id: 'board', label: 'Board', look: 'chalk' },
        ],
        exitSide,
      };
      const scene = mapScene(spec, `scene-${shape.name}-${exitSide}`, { verbs: shape.verbs });
      const exit = scene.exits[0]!;
      const away = Math.hypot(
        scene.spawn.x - (exit.x + exit.w / 2),
        scene.spawn.y - (exit.y + exit.h / 2),
      );
      const diagonal = Math.hypot(scene.width, scene.height);

      // A third of the room, not one step: the spawn used to sit ~200 px from
      // the door. A wide hall caps it — the props hold the far corners and the
      // lane holds the middle — so this is a floor, not an ideal.
      assert.ok(
        away >= diagonal * 0.3,
        `spawn is ${Math.round(away)} px from the gate in a ${Math.round(diagonal)} px room`,
      );
      assert.ok(
        !scene.interactables.some(
          (it) =>
            scene.spawn.x >= it.x &&
            scene.spawn.x <= it.x + it.w &&
            scene.spawn.y >= it.y &&
            scene.spawn.y <= it.y + it.h,
        ),
        'the player arrives standing in a prop',
      );
      assert.ok(walkable(scene).ok, 'the gate cannot be reached from where the player arrives');
    });
  }
}
