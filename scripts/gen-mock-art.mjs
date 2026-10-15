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
function isoSceneSvg(scene, label) {
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

  // Tile grid, so distance is readable while walking.
  const tile = 200;
  parts.push('<g stroke="#2d1e12" stroke-width="1.5" opacity="0.65">');
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

  for (const e of scene.exits) {
    parts.push(`<polygon points="${poly(e)}" fill="${C.lapis}" opacity="0.8"/>`);
    const c = isoProject(e.x + e.w / 2, e.y + e.h / 2, view);
    parts.push(
      `<text x="${c.x.toFixed(0)}" y="${c.y.toFixed(0)}" fill="${C.parchment}" font-family="monospace" font-size="16" text-anchor="middle">exit</text>`,
    );
  }

  // Footprint tints only — the solid is drawn at runtime.
  for (const it of scene.interactables) {
    parts.push(`<polygon points="${poly(it)}" fill="${C.gold}" opacity="0.22"/>`);
  }

  for (const [id, p] of Object.entries(scene.npcSpots)) {
    const c = isoProject(p.x, p.y, view);
    const fill = id === 'oracle' ? C.oracle : C.parchment;
    parts.push(
      `<ellipse cx="${c.x.toFixed(0)}" cy="${c.y.toFixed(0)}" rx="30" ry="15" fill="${fill}" opacity="0.3"/>`,
    );
    parts.push(
      `<text x="${c.x.toFixed(0)}" y="${(c.y + 34).toFixed(0)}" fill="${fill}" font-family="monospace" font-size="17" text-anchor="middle">${esc(id)}</text>`,
    );
  }

  const s = isoProject(scene.spawn.x, scene.spawn.y, view);
  parts.push(
    `<ellipse cx="${s.x.toFixed(0)}" cy="${s.y.toFixed(0)}" rx="12" ry="6" fill="${C.success}"/>`,
  );
  parts.push(
    `<text x="24" y="40" fill="${C.parchment}" font-family="monospace" font-size="26" opacity="0.8">${esc(label)} — isometric placeholder</text>`,
  );
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="48" viewBox="0 0 32 48">
  <rect x="8" y="18" width="16" height="22" rx="4" fill="${body}"/>
  <circle cx="16" cy="12" r="9" fill="${accent}"/>
  <rect x="10" y="40" width="5" height="7" fill="${body}"/>
  <rect x="17" y="40" width="5" height="7" fill="${body}"/>
  <title>${label}</title>
</svg>`;
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
  const svg = scene.projection === 'isometric' ? isoSceneSvg(scene, label) : sceneSvg(scene, label);
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
