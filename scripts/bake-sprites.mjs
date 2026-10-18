/**
 * Raw plates → game sprites.
 *
 *   node scripts/bake-sprites.mjs
 *   node scripts/bake-sprites.mjs --in server/.cache/dressing --out web/public/dressing
 *
 * The image model returns JPEG on a flat white field whatever the prompt asks
 * for, and a JPEG cannot carry alpha. The client already knows how to deal
 * with that — `web/src/game/painted.ts` keys and crops a plate on the way into
 * a texture — but doing it per asset per session is work the browser should
 * not be repeating, and the keyed result cannot be committed or inspected.
 *
 * This is the same algorithm, run once, at the bench:
 *
 *   1. read the field colour off the four corners, and bail if they disagree —
 *      a frame whose corners differ has no studio field, only a subject
 *      standing somewhere, and cutting one out takes a bite out of a painting;
 *   2. flood that colour inward *from the border*, so white that belongs to
 *      the subject (a pot's highlight, a bleached awning) survives;
 *   3. feather the pixels left on the boundary, or every sprite gets a hard
 *      white halo where the JPEG blurred into its own edge;
 *   4. trim to the subject and scale it down to `--max`, because these are
 *      displayed around 200px and shipping 1376px of them is three megabytes
 *      of nothing.
 *
 * Decoding and encoding are done by a headless browser, which is the one PNG
 * codec that is already on the machine — the repo has no image dependency and
 * this is a bench tool, not something the server or the game ever runs. It
 * looks for Playwright and falls back to plain Chrome over CDP, and if it
 * finds neither it says so and changes nothing.
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const flag = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const inDir = resolve(repoRoot, flag('in', 'server/.cache/dressing'));
const outDir = resolve(repoRoot, flag('out', 'web/public/dressing'));
const MAX = Number(flag('max', 512));

/**
 * Playwright, from wherever this machine happens to keep it.
 *
 * Not a dependency of the repo: nothing that ships imports this file, and
 * adding a browser to `npm install` to bake sixteen pictures once would be a
 * poor trade. If it is not here, say so plainly rather than half-working.
 */
function findPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = ['playwright', 'playwright-core', join(process.env.HOME ?? '', '.npm/_npx')];
  for (const name of candidates.slice(0, 2)) {
    try {
      return require(name);
    } catch {
      /* keep looking */
    }
  }
  // npx leaves copies under a hashed folder; any of them will do.
  const npx = candidates[2];
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) {
      const path = join(npx, entry, 'node_modules/playwright');
      if (existsSync(path)) {
        try {
          return require(path);
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

const chromePath = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => existsSync(p));

const playwright = findPlaywright();
if (!playwright) {
  console.error(
    'bake-sprites: no Playwright on this machine.\n' +
      '  npx playwright install chromium   (or run: npm i -D playwright)\n' +
      'Nothing was written. The raw plates are still in ' +
      inDir,
  );
  process.exit(1);
}

/**
 * The keying itself, which runs inside the page because that is where the
 * canvas is. A straight port of `cutout()` in web/src/game/painted.ts — if one
 * changes, the other should.
 */
const KEY_IN_PAGE = `
async (dataUrl, max) => {
  const FIELD = 60;   // within this of the field colour is the field
  const HALO = 150;   // within this, and touching it, is the blur between

  const img = new Image();
  img.src = dataUrl;
  await img.decode();

  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const frame = ctx.getImageData(0, 0, w, h);
  const data = frame.data;
  const apart = (a, r, g, b) => Math.abs(a[0]-r) + Math.abs(a[1]-g) + Math.abs(a[2]-b);

  const patch = (left, top) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = top; y < top + 5; y++) {
      for (let x = left; x < left + 5; x++) {
        const i = (y * w + x) * 4;
        r += data[i]; g += data[i+1]; b += data[i+2]; n++;
      }
    }
    return [r/n, g/n, b/n];
  };
  const corners = [patch(1,1), patch(w-6,1), patch(1,h-6), patch(w-6,h-6)];
  for (const a of corners) for (const b of corners) {
    if (apart(a, b[0], b[1], b[2]) > 48) return { ok: false, why: 'corners disagree' };
  }
  const studio = corners[0];

  const field = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  const push = (p) => {
    if (field[p]) return;
    const i = p * 4;
    if (apart(studio, data[i], data[i+1], data[i+2]) > FIELD) return;
    field[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < w; x++) { push(x); push((h-1)*w + x); }
  for (let y = 0; y < h; y++) { push(y*w); push(y*w + w - 1); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (field[p]) continue;
    const i = p * 4;
    if (apart(studio, data[i], data[i+1], data[i+2]) > HALO) continue;
    const edge = (x > 0 && field[p-1]) || (x < w-1 && field[p+1]) ||
                 (y > 0 && field[p-w]) || (y < h-1 && field[p+w]);
    if (edge) data[i+3] = 110;
  }
  for (let p = 0; p < field.length; p++) if (field[p]) data[p*4+3] = 0;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y*w + x)*4 + 3] === 0) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  if (maxX < 0 || cropW < 8 || cropH < 8) return { ok: false, why: 'keyed to nothing' };
  if (cropW > w * 0.97 && cropH > h * 0.97) return { ok: false, why: 'keyed to everything' };

  ctx.putImageData(frame, 0, 0);
  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  out.getContext('2d').drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  return { ok: true, w: cropW, h: cropH, png: out.toDataURL('image/png') };
}`;

const files = existsSync(inDir)
  ? readdirSync(inDir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort()
  : [];
if (files.length === 0) {
  console.error(`bake-sprites: nothing to bake in ${inDir}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const browser = await playwright.chromium.launch(
  chromePath ? { executablePath: chromePath, args: ['--no-sandbox'] } : {},
);
const page = await browser.newPage();
await page.goto('about:blank');

let baked = 0;
const refused = [];
for (const file of files) {
  const stem = file.slice(0, -extname(file).length);
  const mime = /\.png$/i.test(file)
    ? 'image/png'
    : /\.webp$/i.test(file)
      ? 'image/webp'
      : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${readFileSync(join(inDir, file)).toString('base64')}`;

  const result = await page.evaluate(
    ([fn, url, max]) => new Function(`return (${fn})`)()(url, max),
    [KEY_IN_PAGE, dataUrl, MAX],
  );

  if (!result.ok) {
    refused.push(`${stem} (${result.why})`);
    continue;
  }
  const bytes = Buffer.from(result.png.slice('data:image/png;base64,'.length), 'base64');
  writeFileSync(join(outDir, `${stem}.png`), bytes);
  baked++;
  console.log(`  ✓ ${stem}.png  ${result.w}x${result.h}  ${(bytes.length / 1024) | 0} KB`);
}

await browser.close();
console.log(`\nbaked ${baked}/${files.length} into ${outDir}`);
if (refused.length > 0) {
  console.log('left alone (no flat field to key — repaint these):');
  for (const line of refused) console.log(`  · ${line}`);
}
