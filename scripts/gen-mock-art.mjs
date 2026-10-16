#!/usr/bin/env node
/**
 * Generates the placeholder art in web/public/mock-art from the scene fixtures,
 * so the colliders in mocks/scenes/*.json always line up with what you see.
 * Nothing is downloaded. Real art replaces these files, same names.
 *
 *   node scripts/gen-mock-art.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoDiamond, isoProject, isoView } from '../shared/dist/iso.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'web/public/mock-art');
const portraitDir = join(outDir, 'portraits');
mkdirSync(portraitDir, { recursive: true });

const C = {
  ground: '#1f140d',
  groundAlt: '#271a10',
  parchment: '#f4ecd8',
  gold: '#d9a441',
  lapis: '#2c4a8a',
  oracle: '#6fb6ff',
  success: '#3f7f2e',
  fail: '#c0281e',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sceneSvg(scene, label) {
  const { width: w, height: h } = scene;
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
  );
  parts.push(`<defs>
    <pattern id="planks" width="160" height="56" patternUnits="userSpaceOnUse">
      <rect width="160" height="56" fill="${C.ground}"/>
      <rect width="160" height="2" y="54" fill="${C.groundAlt}"/>
      <rect width="2" height="56" x="78" fill="${C.groundAlt}"/>
    </pattern>
    <radialGradient id="candle" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="${C.gold}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${C.gold}" stop-opacity="0"/>
    </radialGradient>
  </defs>`);
  parts.push(`<rect width="${w}" height="${h}" fill="url(#planks)"/>`);
  parts.push(`<rect width="${w}" height="${h}" fill="url(#candle)"/>`);

  // Shelves / furniture, drawn straight from the collider rects.
  for (const r of scene.blocked) {
    const edge = r.w >= w - 1 || r.h >= h - 1 || r.x === 0 || r.y === 0;
    if (edge) {
      parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#140d08"/>`);
      continue;
    }
    parts.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="6" fill="#3a2514" stroke="#15100a" stroke-width="3"/>`,
    );
    const rows = Math.max(1, Math.floor(r.h / 55));
    for (let i = 0; i < rows; i++) {
      const y = r.y + 12 + i * (r.h / rows);
      parts.push(
        `<rect x="${r.x + 10}" y="${y}" width="${r.w - 20}" height="${Math.max(6, r.h / rows - 18)}" rx="3" fill="${C.parchment}" opacity="0.5"/>`,
      );
    }
  }

  // Exits.
  for (const e of scene.exits) {
    parts.push(
      `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" rx="4" fill="${C.lapis}" opacity="0.75"/>`,
    );
    parts.push(
      `<text x="${e.x + e.w / 2}" y="${e.y + e.h / 2}" fill="${C.parchment}" font-family="monospace" font-size="16" text-anchor="middle" dominant-baseline="middle">exit</text>`,
    );
  }

  // Interactables, labelled so you know what E does before any UI exists.
  for (const it of scene.interactables) {
    parts.push(
      `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="8" fill="${C.gold}" opacity="0.85" stroke="#f2d08a" stroke-width="3"/>`,
    );
    parts.push(
      `<text x="${it.x + it.w / 2}" y="${it.y + it.h + 20}" fill="${C.gold}" font-family="monospace" font-size="20" text-anchor="middle">${esc(it.id)}</text>`,
    );
  }

  // NPC standing spots.
  for (const [id, p] of Object.entries(scene.npcSpots)) {
    const fill = id === 'oracle' ? C.oracle : C.parchment;
    parts.push(`<circle cx="${p.x}" cy="${p.y}" r="26" fill="${fill}" opacity="0.35"/>`);
    parts.push(
      `<text x="${p.x}" y="${p.y + 48}" fill="${fill}" font-family="monospace" font-size="18" text-anchor="middle">${esc(id)}</text>`,
    );
  }

  parts.push(`<circle cx="${scene.spawn.x}" cy="${scene.spawn.y}" r="10" fill="${C.success}"/>`);
  parts.push(
    `<text x="40" y="60" fill="${C.parchment}" font-family="monospace" font-size="28" opacity="0.8">${esc(label)} — placeholder art</text>`,
  );
  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * Isometric scenes get a floor only. The props are extruded from the collider
 * rects by WorldScene at runtime, so they cannot drift from the physics.
 */
function isoSceneSvg(scene) {
  const view = isoView(scene.width, scene.height);
  const w = Math.round(view.width);
  const h = Math.round(view.height);
  const parts = [];
  const pt = (x, y) => {
    const p = isoProject(x, y, view);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  };
  const poly = (rect) =>
    isoDiamond(rect, view)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(' ');

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
  );
  parts.push(`<rect width="${w}" height="${h}" fill="#140d08"/>`);

  // The ground plane as one big diamond.
  parts.push(
    `<polygon points="${poly({ x: 0, y: 0, w: scene.width, h: scene.height })}" fill="${C.ground}"/>`,
  );

  // Tiled in two shades, not flat: on an isometric plane one colour gives the
  // eye nothing to measure against, so you cannot tell two metres from twenty.
  const tile = 200;
  for (let x = 0; x < scene.width; x += tile) {
    for (let y = 0; y < scene.height; y += tile) {
      if (((x / tile + y / tile) | 0) % 2 === 0) continue;
      const w1 = Math.min(tile, scene.width - x);
      const h1 = Math.min(tile, scene.height - y);
      parts.push(`<polygon points="${poly({ x, y, w: w1, h: h1 })}" fill="${C.groundAlt}"/>`);
    }
  }

  // Joints over the tiles, so the seams read at any zoom.
  parts.push('<g stroke="#3a2715" stroke-width="1.5" opacity="0.5">');
  for (let x = 0; x <= scene.width; x += tile) {
    parts.push(
      `<line x1="${pt(x, 0).split(',')[0]}" y1="${pt(x, 0).split(',')[1]}" x2="${pt(x, scene.height).split(',')[0]}" y2="${pt(x, scene.height).split(',')[1]}"/>`,
    );
  }
  for (let y = 0; y <= scene.height; y += tile) {
    parts.push(
      `<line x1="${pt(0, y).split(',')[0]}" y1="${pt(0, y).split(',')[1]}" x2="${pt(scene.width, y).split(',')[0]}" y2="${pt(scene.width, y).split(',')[1]}"/>`,
    );
  }
  parts.push('</g>');

  // A skirting inside the walls: the floor meeting something is what tells you
  // the room has edges rather than fading out.
  const inset = 28;
  parts.push(
    `<polygon points="${poly({ x: inset, y: inset, w: scene.width - inset * 2, h: scene.height - inset * 2 })}" fill="none" stroke="#4a3426" stroke-width="3" opacity="0.55"/>`,
  );

  // A way out, lit. A flat blue rectangle on the floor is the one thing in the
  // room that looks like a bug rather than a place, so it gets a warm threshold
  // and a chevron pointing the way it leads.
  for (const e of scene.exits) {
    for (const [k, fill, opacity] of [
      [0, '#6b4a22', 0.75],
      [0.14, '#a8762f', 0.7],
      [0.3, '#e0b35e', 0.6],
    ]) {
      const r = { x: e.x + e.w * k, y: e.y + e.h * k, w: e.w * (1 - 2 * k), h: e.h * (1 - 2 * k) };
      parts.push(`<polygon points="${poly(r)}" fill="${fill}" opacity="${opacity}"/>`);
    }
    const cx = e.x + e.w / 2;
    const cy = e.y + e.h / 2;
    // Point the chevron at whichever wall the exit is nearest.
    const out = [
      { away: cy, to: { x: 0, y: -1 } },
      { away: scene.height - cy, to: { x: 0, y: 1 } },
      { away: cx, to: { x: -1, y: 0 } },
      { away: scene.width - cx, to: { x: 1, y: 0 } },
    ].reduce((nearest, side) => (side.away < nearest.away ? side : nearest)).to;
    const reach = Math.min(e.w, e.h) * 0.7;
    const side = { x: -out.y, y: out.x };
    const chevron = [
      pt(
        cx - out.x * reach * 0.1 + side.x * reach * 0.6,
        cy - out.y * reach * 0.1 + side.y * reach * 0.6,
      ),
      pt(cx + out.x * reach, cy + out.y * reach),
      pt(
        cx - out.x * reach * 0.1 - side.x * reach * 0.6,
        cy - out.y * reach * 0.1 - side.y * reach * 0.6,
      ),
    ].join(' ');
    parts.push(
      `<polyline points="${chevron}" fill="none" stroke="${C.parchment}" stroke-width="5" opacity="0.8"/>`,
    );
  }

  // Nothing under the interactables: the runtime draws a ring there that lights
  // up when the player is in reach, and two overlapping tints read as a smudge.

  // Nothing under the cast and nothing on the spawn: the runtime stands real
  // figures there and draws their shadows with them, and a painted ellipse
  // underneath only shows up as a smudge they never quite stand on.

  parts.push('</svg>');
  return parts.join('\n');
}

function portraitSvg(name, mood) {
  const tint = { neutral: C.parchment, pleased: C.gold, worried: C.fail }[mood];
  const isOracle = name === 'oracle';
  const body = { rane: '#4a5240', dalvi: '#2f3a52' }[name] ?? (isOracle ? C.lapis : '#3a2514');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="${C.ground}"/>
  <circle cx="128" cy="150" r="96" fill="${body}"/>
  <circle cx="128" cy="104" r="52" fill="${isOracle ? C.oracle : '#c9a37a'}" opacity="${isOracle ? 0.8 : 1}"/>
  <rect x="34" y="34" width="188" height="188" fill="none" stroke="${tint}" stroke-width="6" rx="12"/>
  <text x="128" y="238" fill="${tint}" font-family="monospace" font-size="20" text-anchor="middle">${name}/${mood}</text>
</svg>`;
}

function spriteSvg(label, body, accent) {
  // A placeholder, still — but a figure rather than four rectangles. Outline,
  // a coat that reads at 32px, and a contact shadow so it stands on the floor
  // instead of floating above it.
  const dark = shade(body, 0.55);
  const light = shade(body, 1.25);
  // Straight lines only: Phaser rasterises these SVGs itself and quietly drops
  // path arcs, which is how the first draft of this sprite became a floating head.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="48" viewBox="0 0 32 48">
  <title>${label}</title>
  <ellipse cx="16" cy="45" rx="9" ry="3" fill="#000000" opacity="0.3"/>
  <rect x="11" y="38" width="4" height="7" fill="${dark}"/>
  <rect x="17" y="38" width="4" height="7" fill="${dark}"/>
  <polygon points="9,19 23,19 25,40 7,40" fill="${body}"/>
  <polygon points="16,19 23,19 25,40 16,40" fill="${dark}" opacity="0.5"/>
  <polygon points="12,19 20,19 16,27" fill="${light}" opacity="0.85"/>
  <rect x="7" y="38" width="18" height="2" fill="${dark}"/>
  <circle cx="16" cy="13" r="6" fill="${accent}"/>
  <polygon points="10,12 22,12 20,7 12,7" fill="${dark}"/>
  <ellipse cx="16" cy="12" rx="9" ry="2.4" fill="${dark}"/>
</svg>`;
}

/** Scale a #rrggbb toward black or white. */
function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((v) => Math.max(0, Math.min(255, Math.round(v * factor))))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  return `#${c}`;
}

const sceneDir = join(root, 'mocks/scenes');
const labels = {
  'scene-scriptorium': 'The Scriptorium',
  'scene-stacks': 'The Stacks',
  'scene-sanctum': 'Sanctum of the Blue Flame',
  'scene-signal-box': 'Ghat 9 Signal Box',
  'scene-falling-grade': 'Falling Grade',
  'scene-gorge': 'Gorge Crossing',
};
for (const file of readdirSync(sceneDir).filter((f) => f.endsWith('.json'))) {
  const scene = JSON.parse(readFileSync(join(sceneDir, file), 'utf8'));
  const label = labels[scene.id] ?? scene.id;
  const svg = scene.projection === 'isometric' ? isoSceneSvg(scene) : sceneSvg(scene, label);
  writeFileSync(join(outDir, `${scene.id}.svg`), svg);
  console.log(`scene   ${scene.id}.svg  (${scene.projection ?? 'topdown'})`);
}

for (const name of ['archivist', 'oracle', 'rane', 'dalvi']) {
  for (const mood of ['neutral', 'pleased', 'worried']) {
    writeFileSync(join(portraitDir, `${name}-${mood}.svg`), portraitSvg(name, mood));
  }
  console.log('portrait', name);
}

writeFileSync(
  join(outDir, 'sprite-archivist.svg'),
  spriteSvg('The Archivist', '#4a2f18', C.parchment),
);
writeFileSync(join(outDir, 'sprite-oracle.svg'), spriteSvg('The Oracle', C.lapis, C.oracle));
writeFileSync(join(outDir, 'sprite-rane.svg'), spriteSvg('Inspector Rane', '#4a5240', '#c9a37a'));
writeFileSync(
  join(outDir, 'sprite-dalvi.svg'),
  spriteSvg('Station Master Dalvi', '#2f3a52', '#c9a37a'),
);
writeFileSync(join(outDir, 'player.svg'), spriteSvg('Player', C.gold, C.parchment));
console.log('sprites  archivist, oracle, rane, dalvi, player');
