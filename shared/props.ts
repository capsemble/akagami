/**
 * What a prop is, worked out from what it is called.
 *
 * The design pass writes a room as a few named objects — "brake-lever", "the
 * signed timetable", "a cast-iron water tank" — and nothing downstream knows
 * what shape any of them should be. This is where that is decided, once, with
 * no model call: a keyword table over the object's own words.
 *
 * It lives here because two very different things need the same answer. The
 * mapper sizes the collider from it, so a notice board gets a wide shallow
 * footprint and a pillar a square one; the renderer draws the silhouette into
 * that same rect. If the two disagreed, a board would be drawn across a
 * footprint it does not fill, and the player would collide with thin air.
 *
 * Deliberately not a model call. A room's furniture should not need a network
 * round trip, and a table of words is something you can read and correct.
 */
import { isoProject } from './iso.js';
import type { IsoView } from './iso.js';
import type { Interactable, Point } from './types.js';

export type PropKind =
  | 'board'
  | 'lever'
  | 'tank'
  | 'barrel'
  | 'launcher'
  | 'ledge'
  | 'document'
  | 'crate'
  | 'shelf'
  | 'console'
  | 'lamp'
  | 'pillar'
  | 'cart'
  | 'door'
  | 'rock';

/** What a prop can be when nothing in its name says what it is. */
const GENERIC: PropKind[] = ['crate', 'barrel', 'document', 'rock', 'pillar', 'shelf'];

/**
 * Words → silhouette. Checked in order, so the specific entries come first: a
 * "brake lever" is a lever even though consoles also have brakes on them, and
 * a "signal lamp" is a lamp rather than an instrument panel.
 */
const KINDS: [PropKind, string[]][] = [
  ['lever', ['lever', 'switch', 'throttle', 'handle', 'brake', 'crank', 'regulator']],
  ['board', ['board', 'chalk', 'notice', 'pinboard', 'map', 'chart', 'poster', 'plan', 'wall of']],
  ['tank', ['tank', 'boiler', 'cistern', 'vat', 'reservoir', 'tower', 'silo', 'kettle']],
  ['barrel', ['barrel', 'drum', 'cask', 'keg', 'canister']],
  ['launcher', ['launcher', 'catapult', 'cannon', 'mortar', 'sling', 'ballista', 'winch']],
  ['ledge', ['ledge', 'platform', 'cliff', 'landing', 'rooftop', 'slab', 'parapet']],
  // Drawn as a desk with papers on it, so a desk and the thing lying on it are
  // the same prop — which is what they are when you walk up and read one.
  [
    'document',
    [
      'timetable',
      'ledger',
      'book',
      'scroll',
      'paper',
      'file',
      'note',
      'letter',
      'report',
      'desk',
      'table',
      'bench',
      'workbench',
      'counter',
      'lectern',
    ],
  ],
  ['shelf', ['shelf', 'shelves', 'bookcase', 'stack', 'archive', 'rack', 'cabinet', 'locker']],
  [
    'console',
    ['console', 'panel', 'terminal', 'instrument', 'gauge', 'dial', 'meter', 'scanner', 'gantry'],
  ],
  [
    'lamp',
    ['lamp', 'lantern', 'light', 'torch', 'beacon', 'signal', 'brazier', 'candle', 'flame', 'fire'],
  ],
  ['pillar', ['pillar', 'column', 'statue', 'pedestal', 'plinth', 'obelisk', 'idol', 'altar']],
  ['cart', ['cart', 'wagon', 'truck', 'carriage', 'engine', 'locomotive', 'trolley']],
  ['door', ['door', 'gate', 'hatch', 'archway', 'entrance', 'portal', 'turnstile']],
  ['rock', ['rock', 'boulder', 'stone', 'rubble', 'debris', 'heap', 'mound']],
  ['crate', ['crate', 'box', 'chest', 'case', 'trunk', 'container', 'satchel', 'pack']],
];

/** Material words → body colour. The design pass writes these in `look`. */
const MATERIALS: [number, string[]][] = [
  [0x6e7682, ['iron', 'steel', 'metal', 'rail', 'chrome', 'alloy']],
  [0xb08d57, ['brass', 'bronze', 'copper', 'gilt', 'gilded']],
  [0x9a4a32, ['rust', 'rusted', 'corroded', 'oxidised', 'oxidized']],
  [0x8a5a2b, ['timber', 'wood', 'wooden', 'oak', 'teak', 'pine', 'plank', 'mahogany', 'birch']],
  [0x7d7468, ['stone', 'granite', 'marble', 'brick', 'concrete', 'slate', 'masonry']],
  [0x6b8fa3, ['glass', 'crystal', 'mirror', 'lens']],
  [0xe4d8b4, ['paper', 'parchment', 'canvas', 'cloth', 'linen', 'vellum']],
  [0x2f4538, ['moss', 'ivy', 'verdigris']],
];

const BY_KIND: Record<PropKind, number> = {
  board: 0x6b4423,
  lever: 0x6e7682,
  tank: 0x5f6b72,
  barrel: 0x8a5a2b,
  launcher: 0x7a5230,
  ledge: 0x7d7468,
  document: 0x6b4a2a,
  crate: 0x8a5a2b,
  shelf: 0x5c3d22,
  console: 0x4a5560,
  lamp: 0x55504a,
  pillar: 0x8d8475,
  cart: 0x6b4a3a,
  door: 0x5a3c22,
  rock: 0x6a6258,
};

/**
 * How much floor a prop takes and how tall it stands.
 *
 * Both floor numbers are multiples of one unit — the room's prop width — not of
 * the width and depth separately. A base footprint is wider than it is deep, so
 * scaling the two independently would mean a round tank came out as an oval and
 * a square pillar as an oblong. One unit for both: square here means square on
 * the floor. A board is wide and shallow because that is how a board hangs.
 */
const SHAPE: Record<PropKind, { w: number; h: number; height: number }> = {
  board: { w: 1.5, h: 0.28, height: 1.3 },
  lever: { w: 0.6, h: 0.6, height: 0.6 },
  tank: { w: 1.0, h: 1.0, height: 2.0 },
  barrel: { w: 0.65, h: 0.65, height: 1.0 },
  launcher: { w: 1.25, h: 0.75, height: 0.9 },
  ledge: { w: 1.5, h: 0.7, height: 0.4 },
  document: { w: 1.05, h: 0.6, height: 0.6 },
  crate: { w: 0.8, h: 0.8, height: 0.85 },
  shelf: { w: 1.35, h: 0.35, height: 1.8 },
  console: { w: 1.05, h: 0.55, height: 0.9 },
  lamp: { w: 0.4, h: 0.4, height: 1.9 },
  pillar: { w: 0.6, h: 0.6, height: 2.2 },
  cart: { w: 1.15, h: 0.6, height: 0.9 },
  door: { w: 1.25, h: 0.3, height: 1.7 },
  rock: { w: 0.85, h: 0.85, height: 0.7 },
};

/**
 * Does any of these words appear in that name?
 *
 * Whole words, give or take an ordinary English ending, so "levers" and
 * "timetables" still hit their needles while a "ledger" is emphatically not a
 * ledge. Substring matching was the bug: it put the rank ledger on a stone
 * slab. A needle with a space in it is matched against the whole phrase.
 */
const ENDING = /^(s|es|ed|ing)$/;

function says(words: string[], needles: string[]): boolean {
  return needles.some((needle) =>
    needle.includes(' ')
      ? words.join(' ').includes(needle)
      : words.some(
          (word) =>
            word === needle ||
            (word.startsWith(needle) && ENDING.test(word.slice(needle.length))),
        ),
  );
}

const describe = (target: { id: string; label?: string; look?: string }): string[] =>
  `${target.id} ${target.label ?? ''} ${target.look ?? ''}`
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);

export function propKindFor(target: { id: string; label?: string; look?: string }): PropKind {
  // The id and the label say what a thing is; the look only says how it looks.
  // A satchel described as having a brass count-dial on the strap is still a
  // satchel and not an instrument panel, so the name gets first refusal and the
  // description is only consulted when the name says nothing.
  for (const words of [describe({ id: target.id, label: target.label }), describe(target)]) {
    for (const [kind, needles] of KINDS) {
      if (says(words, needles)) return kind;
    }
  }
  // Unrecognised still means varied: a strange room gets a crate, a barrel and
  // a table in it rather than three identical blocks.
  return GENERIC[seedOf(target.id) % GENERIC.length]!;
}

/** The body colour for a prop: its material if stated, else the kind's own. */
export function propTint(
  target: { id: string; label?: string; look?: string },
  kind = propKindFor(target),
): number {
  const words = describe(target);
  for (const [color, needles] of MATERIALS) {
    if (says(words, needles)) return color;
  }
  return BY_KIND[kind];
}

/** What the plate over the prop says. The design pass's label, if it wrote one. */
export function propLabel(target: { id: string; label?: string }): string {
  const raw = target.label?.trim() || target.id.replace(/[-_]/g, ' ');
  const words = raw.replace(/^(a|an|the)\s+/i, '').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The rect a prop of this kind wants. `base` is the mapper's own PROP size; its
 * width is the floor unit and its height the standing unit.
 */
export function propFootprint(
  target: { id: string; label?: string; look?: string },
  base: { w: number; h: number; height: number },
): { w: number; h: number; height: number } {
  const shape = SHAPE[propKindFor(target)];
  return {
    w: Math.round(base.w * shape.w),
    h: Math.round(base.w * shape.h),
    height: Math.round(base.height * shape.height),
  };
}

/** How tall this prop stands, in pixels. Its own `height` wins if it has one. */
export function propHeight(target: Interactable, kind = propKindFor(target)): number {
  if (target.height !== undefined && target.height > 0) return target.height;
  return Math.round(Math.min(target.w, target.h) * SHAPE[kind].height);
}

/** The screen point directly over a prop, where its name plate hangs. */
export function propApex(target: Interactable, view: IsoView): Point {
  const p = isoProject(target.x + target.w / 2, target.y + target.h / 2, view);
  return { x: p.x, y: p.y - propHeight(target) - 14 };
}

/** A stable small integer from a string, for picking and for jittering art. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
