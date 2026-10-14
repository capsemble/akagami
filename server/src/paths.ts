import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root — works from src/ under tsx and from dist/ under node. */
export const repoRoot = resolve(here, '../..');
export const mocksDir = process.env.MOCKS_DIR ?? resolve(repoRoot, 'mocks');
export const webDist = process.env.WEB_DIST ?? resolve(repoRoot, 'web/dist');
