/**
 * Load .env before anything reads process.env.
 *
 * This has to be its own module. ES imports are hoisted and evaluated before
 * any statement in the importing file, so calling dotenv's config() inside
 * index.ts runs *after* gemini.ts has already read MODELS from an empty
 * environment. Importing this first makes the load order explicit instead.
 *
 * dotenv does not overwrite variables that are already set, so Cloud Run's
 * injected secret still wins over a stray local file.
 */
import { join } from 'node:path';
import { config } from 'dotenv';
import { repoRoot } from './paths.js';

config({ path: join(repoRoot, '.env') });
