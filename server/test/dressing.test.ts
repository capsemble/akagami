import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Decoration, Scene, SceneSpec } from '@chapter-quest/shared';
import { DRESSING, dressScene, dressingAsset, dressingTagsFor } from '@chapter-quest/shared';
import { mapScene, walkable } from '../src/pipeline/mapper.js';

const SPEC: SceneSpec = {
  name: 'Ravine Mouth Toll-Gate',
  description: 'A narrow stone gate choked with bullock carts.',
  objects: [
    { id: 'tally-board', label: 'Gate Tally Board', look: 'Slate board with brass pegs.' },
    { id: 'weighing-scale', label: 'Bullock Cart Scale', look: 'Heavy timber platform on chains.' },
  ],
  exitSide: 'east',
};

const room = (id = 'scene-act1'): Scene =>
  mapScene(SPEC, id, { verbs: ['tune'], castIds: ['bansi', 'munshi-kedar'] });

/**
 * The guarantee the whole layer rests on. Dressing is scenery: it may look
 * like anything, but it may not be anything. The moment a decoration produces
 * a collider, every room in the library needs re-testing for reachability and
 * a tree can strand the player in front of the prop the act needs.
 */
test('dressing changes nothing a body can touch', () => {
  const bare = mapScene(SPEC, 'scene-act1', {
    verbs: ['tune'],
    castIds: ['bansi', 'munshi-kedar'],
    dressing: [],
  });
  const dressed = room();

  assert.ok((dressed.dressing?.length ?? 0) > 0, 'the room should have been dressed at all');
  assert.deepEqual(dressed.blocked, bare.blocked);
  assert.deepEqual(dressed.interactables, bare.interactables);
  assert.deepEqual(dressed.exits, bare.exits);
  assert.deepEqual(dressed.spawn, bare.spawn);
  assert.deepEqual(dressed.npcSpots, bare.npcSpots);
  assert.equal(walkable(dressed).ok, walkable(bare).ok);
  assert.deepEqual(walkable(dressed).unreachable, walkable(bare).unreachable);
});

test('the same scene id dresses to the same room every time', () => {
  assert.deepEqual(room().dressing, room().dressing);
  assert.notDeepEqual(room('scene-act1').dressing, room('scene-act2').dressing);
});

test('every placed decoration names an asset that exists', () => {
  for (const item of room().dressing ?? []) {
    const asset = dressingAsset(item.asset);
    assert.ok(asset, `${item.asset} is placed but is not in the catalogue`);
    assert.equal(item.layer, asset.layer);
    assert.ok(item.scale > 0.2 && item.scale < 2, `${item.id} scaled to ${item.scale}`);
  }
});

/**
 * Nothing standing up may sit on top of something the room already uses. The
 * player can walk through a tree — it has no body — but they should never have
 * to, and a boulder on a prop hides the one object the act is about.
 */
test('uprights keep clear of the props, the cast, the spawn and the way out', () => {
  const scene = room();
  const uprights = (scene.dressing ?? []).filter((d) => d.layer === 'upright');
  assert.ok(uprights.length > 0);

  for (const item of uprights) {
    for (const prop of scene.interactables) {
      const inside =
        item.x > prop.x - 40 &&
        item.x < prop.x + prop.w + 40 &&
        item.y > prop.y - 40 &&
        item.y < prop.y + prop.h + 40;
      assert.ok(!inside, `${item.asset} at ${item.x},${item.y} is standing on ${prop.id}`);
    }
    for (const [id, spot] of Object.entries(scene.npcSpots)) {
      assert.ok(
        Math.hypot(item.x - spot.x, item.y - spot.y) > 50,
        `${item.asset} is standing on ${id}`,
      );
    }
    assert.ok(
      Math.hypot(item.x - scene.spawn.x, item.y - scene.spawn.y) > 50,
      `${item.asset} is standing on the spawn`,
    );
    for (const exit of scene.exits) {
      const blockingDoor =
        item.x > exit.x - 60 &&
        item.x < exit.x + exit.w + 60 &&
        item.y > exit.y - 60 &&
        item.y < exit.y + exit.h + 60;
      assert.ok(!blockingDoor, `${item.asset} is standing in the doorway`);
    }
  }
});

test('nothing is placed outside the plane', () => {
  const scene = room();
  for (const item of scene.dressing ?? []) {
    assert.ok(item.x >= 0 && item.x <= scene.width, `${item.id} is off the plane in x`);
    assert.ok(item.y >= 0 && item.y <= scene.height, `${item.id} is off the plane in y`);
  }
});

/**
 * The path is the one piece of dressing with a job: it says where to walk. It
 * has to actually reach the things it is pointing at, and it has to lie flat —
 * a paving slab placed as an upright would stand on its edge in the room.
 */
test('the path is flat and reaches the props and the exit', () => {
  const scene = room();
  const path = (scene.dressing ?? []).filter((d) => d.id.startsWith('path-'));
  assert.ok(path.length > 0, 'no path was laid');
  assert.ok(
    path.every((slab) => slab.layer === 'ground'),
    'a path slab was placed standing up',
  );

  const reaches = (p: { x: number; y: number }) =>
    path.some((slab) => Math.hypot(slab.x - p.x, slab.y - p.y) < 140);

  assert.ok(reaches(scene.spawn), 'the path does not start at the spawn');
  for (const prop of scene.interactables) {
    assert.ok(
      reaches({ x: prop.x + prop.w / 2, y: prop.y + prop.h }),
      `the path does not reach ${prop.id}`,
    );
  }
  for (const exit of scene.exits) {
    assert.ok(
      reaches({ x: exit.x + exit.w / 2, y: exit.y + exit.h / 2 }),
      'the path does not reach the way out',
    );
  }
});

test('a room with no tags is left bare', () => {
  const scene = mapScene(SPEC, 'scene-act1', {
    verbs: ['tune'],
    castIds: ['bansi', 'munshi-kedar'],
    dressing: [],
  });
  assert.equal(scene.dressing, undefined);
});

test('tags select, so an indoor world gets no trees', () => {
  const indoors: Decoration[] = dressScene(room(), { tags: ['path', 'clutter'] });
  assert.ok(indoors.length > 0);
  for (const item of indoors) {
    const asset = dressingAsset(item.asset)!;
    assert.ok(
      asset.tags.includes('path') || asset.tags.includes('clutter'),
      `${item.asset} was selected by tags it does not carry`,
    );
  }
});

/**
 * The catalogue is a contract with sixteen files on disk and with the renderer
 * that reads the sizes. A missing size is a sprite drawn at whatever Phaser
 * felt like, which is the image's own 1376px.
 */
test('every catalogue entry is complete', () => {
  const seen = new Set<string>();
  for (const asset of DRESSING) {
    assert.ok(!seen.has(asset.id), `${asset.id} is in the catalogue twice`);
    seen.add(asset.id);
    assert.ok(asset.tags.length > 0, `${asset.id} has no tags, so nothing can select it`);
    assert.ok(asset.weight > 0, `${asset.id} has no weight`);
    if (asset.layer === 'upright') {
      assert.ok(asset.heightPx && asset.heightPx > 0, `${asset.id} has no height`);
    } else {
      assert.ok(asset.spreadPx && asset.spreadPx > 0, `${asset.id} has no spread`);
    }
  }
});

/**
 * A tree indoors is the single most obviously broken thing this renderer can
 * do, and it is what the first version did: the candlelit library came out
 * with thorn bushes growing between the shelves.
 */
test('a room with a roof on it gets no vegetation', () => {
  const indoors = dressingTagsFor({
    name: 'The Scriptorium',
    description: 'A candlelit library of dark oak and parchment.',
  });
  assert.ok(!indoors.includes('vegetation'));
  assert.ok(!indoors.includes('arid'));
  // And, while the catalogue is an outdoor set, nothing else either: a bare
  // library beats one furnished out of a ravine.
  assert.deepEqual(indoors, []);

  const outdoors = dressingTagsFor({
    name: 'Ravine Mouth Toll-Gate',
    description: 'A narrow stone gate choked with bullock carts.',
  });
  assert.ok(outdoors.includes('vegetation'));

  // Nothing in the words either way: take the set that is wrong quietly.
  assert.deepEqual(
    dressingTagsFor({ name: 'Somewhere', description: 'Hard to say.' }),
    dressingTagsFor({ name: 'The Scriptorium', description: '' }),
  );
});

/**
 * `spreadPx` is screen pixels and the projection halves horizontal distance,
 * so spacing slabs by their drawn width lays four of them on top of each
 * other. That bug turned a footpath into a paved river, and it is invisible
 * from the fixture — the slab count is the only place it shows.
 */
test('the path is one slab wide, not four', () => {
  const scene = room();
  const path = (scene.dressing ?? []).filter((d) => d.id.startsWith('path-'));
  let span = 0;
  const stops = [
    scene.spawn,
    ...scene.interactables.map((it) => ({ x: it.x + it.w / 2, y: it.y + it.h + 80 })),
    ...scene.exits.map((e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 })),
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    span += Math.hypot(stops[i + 1]!.x - stops[i]!.x, stops[i + 1]!.y - stops[i]!.y);
  }
  // One slab per ~110 world units of route, give or take the per-leg rounding.
  assert.ok(
    path.length < span / 60,
    `${path.length} slabs for ${Math.round(span)} units of route is a river, not a path`,
  );
});
