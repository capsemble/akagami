import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import type { NpcTurn, RagRunRequest, TeachingMove } from '@chapter-quest/shared';
import { MODELS, getUsage, getUsageByModel } from './gemini.js';
import {
  DEFAULT_WORLD_ID,
  loadEvents,
  loadRagTable,
  loadScene,
  loadWorld,
  pickRagKey,
} from './mocks.js';
import { mocksDir, webDist } from './paths.js';
import { readFile } from 'node:fs/promises';

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const VERSION = process.env.K_REVISION ?? '0.1.0-dev';

// Chapters arrive as text or base64 in the JSON body, hence the generous limit.
app.use(express.json({ limit: '20mb' }));

const fail = (res: Response, err: unknown, code = 500) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[api]', message);
  res.status(code).json({ error: message });
};

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    models: MODELS,
    usage: getUsage(),
    usageByModel: getUsageByModel(),
  });
});

/** Cached demo worlds, e.g. /api/demo/rag → mocks/world.rag.json */
app.get('/api/demo/:name', async (req, res) => {
  try {
    res.json(await loadWorld(req.params.name));
  } catch (err) {
    fail(res, err, 404);
  }
});

/**
 * STUB: returns the demo world instead of building one.
 * The real pipeline (curriculum → story → validator → art → mapper) lands here.
 */
app.post('/api/worlds', async (req: Request, res: Response) => {
  try {
    const { text, filename } = req.body ?? {};
    console.log(
      `[worlds] create requested: ${filename ?? 'inline text'}, ${String(text ?? '').length} chars`,
    );
    // "demo:rag" asks for the Oracle world; anything else gets the default.
    const wanted = /\brag\b/.test(String(text ?? '')) ? 'rag' : DEFAULT_WORLD_ID;
    const world = await loadWorld(wanted);
    res.status(202).json({ id: world.id });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/worlds/:id', async (req, res) => {
  try {
    res.json(await loadWorld(req.params.id));
  } catch (err) {
    fail(res, err, 404);
  }
});

app.get('/api/worlds/:id/scenes/:sceneId', async (req, res) => {
  try {
    res.json(await loadScene(req.params.sceneId));
  } catch (err) {
    fail(res, err, 404);
  }
});

/** Real SSE, replaying the recorded build with its original gaps. */
app.get('/api/worlds/:id/events', async (req, res) => {
  let events;
  try {
    events = await loadEvents(req.params.id);
  } catch (err) {
    return fail(res, err, 404);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': stream open\n\n');

  const timers: NodeJS.Timeout[] = [];
  let closed = false;
  req.on('close', () => {
    closed = true;
    timers.forEach(clearTimeout);
  });

  let previous = 0;
  let elapsed = 0;
  for (const event of events) {
    elapsed += Math.max(0, event.ts - previous);
    previous = event.ts;
    timers.push(
      setTimeout(() => {
        if (closed) return;
        res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
        if (event === events[events.length - 1]) {
          res.write('event: end\ndata: {}\n\n');
          res.end();
        }
      }, elapsed),
    );
  }
});

/** STUB: canned runs from mocks/rag.json; no retrieval happens yet. */
app.post('/api/rag/run', async (req: Request, res: Response) => {
  try {
    const body = req.body as RagRunRequest;
    const table = await loadRagTable();
    const key = pickRagKey(table, body.params);
    const hit = table[key];
    if (!hit) return fail(res, new Error(`no fixture for ${key}`), 404);
    res.json(hit);
  } catch (err) {
    fail(res, err);
  }
});

/** STUB: one canned NPC turn. */
app.post('/api/npc/turn', async (_req, res) => {
  try {
    res.json(JSON.parse(await readFile(join(mocksDir, 'npc.json'), 'utf8')) as NpcTurn);
  } catch (err) {
    fail(res, err);
  }
});

/** STUB: one canned teaching move. */
app.post('/api/adapt', async (_req, res) => {
  try {
    res.json(
      JSON.parse(await readFile(join(mocksDir, 'teaching-move.json'), 'utf8')) as TeachingMove,
    );
  } catch (err) {
    fail(res, err);
  }
});

// One container: the API above, the built client below.
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
} else {
  console.log(
    `[server] no web build at ${webDist} — API only (run the Vite dev server for the client)`,
  );
}

createServer(app).listen(PORT, () => {
  console.log(`[server] chapter-quest API on http://localhost:${PORT} (mocks: ${mocksDir})`);
});
