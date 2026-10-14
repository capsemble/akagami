/**
 * The whole visual language in one file. Ranjan owns this — change the values
 * here and every plain component follows.
 */
export const colors = {
  ground: '#1f140d',
  parchment: '#f4ecd8',
  gold: '#d9a441',
  lapis: '#2c4a8a',
  oracle: '#6fb6ff',
  success: '#3f7f2e',
  fail: '#c0281e',
} as const;

export const fonts = {
  /** Loaded from Google Fonts in index.html. */
  header: "'Pixelify Sans', 'Courier New', monospace",
  body: "'Atkinson Hyperlegible', system-ui, sans-serif",
} as const;

/** 4px scale. */
export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 } as const;

export const radii = { panel: 12, chip: 6 } as const;

/** Keep motion on these three beats: tap, panel, scene. */
export const motion = { fast: 150, base: 250, slow: 400 } as const;

export const ms = (n: number) => `${n}ms`;
