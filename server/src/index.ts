import './env.js'; // first, so .env is loaded before anything reads it
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import type { NpcTurn, RagRunRequest, TeachingMove } from '@chapter-quest/shared';
import { MODELS, getUsage, getUsageByModel } from './gemini.js';
import { loadEvents, loadRagTable, loadScene, loadWorld, pickRagKey } from './mocks.js';
import { mocksDir, webDist } from './paths.js';
import { artFile } from './pipeline/art.js';
import { extractFromString } from './extract.js';
import { getJob, startDesign, watch } from './jobs.js';
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
 * Build a world from a chapter.
 *
 * The run is long, so it starts in the background and the id comes back at
 * once — the client opens the event stream with it and watches the thing being
 * made. `demo:` prefixes short-circuit to the prepared fixtures, which is what
 * the demo buttons use and what keeps a dead quota from killing a presentation.
 */
app.post('/api/worlds', async (req: Request, res: Response) => {
  try {
    const { text, filename } = req.body ?? {};
    const raw = String(text ?? '');
    console.log(`[worlds] create: ${filename ?? 'inline text'}, ${raw.length} chars`);

    const demo = /^demo:(rag|kinematics)\b/i.exec(raw.trim());
    if (demo) {
      const world = await loadWorld(demo[1]!.toLowerCase());
      res.status(202).json({ id: world.id });
      return;
    }
    if (raw.trim().length < 200) {
      res.status(400).json({ error: 'That is too short to be a chapter.' });
      return;
    }

    const chapter = extractFromString(raw, filename ?? 'inline text');
    const id = startDesign(chapter);
    res.status(202).json({ id });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Painted assets, served straight off the design cache. The names are produced
 * by the art director, never by a request, but the path still gets checked:
 * anything that is not a flat `<name>.png` is refused rather than resolved.
 */
app.get('/api/art/:hash/:file', (req, res) => {
  const { hash, file } = req.params;
  if (!/^[0-9a-f]{1,32}$/.test(hash) || !/^[a-z0-9-]{1,64}\.png$/.test(file)) {
    res.status(400).json({ error: 'bad asset path' });
    return;
  }
  res.sendFile(artFile(hash, file), (err) => {
    if (err) res.status(404).json({ error: 'not painted' });
  });
});

app.get('/api/worlds/:id', async (req, res) => {
  const job = getJob(req.params.id);
  if (job) {
    if (job.world) {
      res.json(job.world);
    } else if (job.done) {
      fail(res, new Error(job.error ?? 'the build produced no world'), 500);
    } else {
      // Still forming. The client only asks once the stream says it is done,
      // so this is a reload mid-build rather than the normal path.
      res.status(409).json({ error: 'still building', status: 'designing' });
    }
    return;
  }
  try {
    res.json(await loadWorld(req.params.id));
  } catch (err) {
    fail(res, err, 404);
  }
});

app.get('/api/worlds/:id/scenes/:sceneId', async (req, res) => {
  const scene = getJob(req.params.id)?.scenes?.get(req.params.sceneId);
  if (scene) {
    res.json(scene);
    return;
  }
  try {
    res.json(await loadScene(req.params.sceneId));
  } catch (err) {
    fail(res, err, 404);
  }
});

/**
 * The build, as it happens. A generated world streams its agents live; a demo
 * fixture replays its recorded build with the original gaps, which is the same
 * shape on the wire and the same experience on screen.
 */
app.get('/api/worlds/:id/events', async (req, res) => {
  const openStream = () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': stream open\n\n');
  };

  const job = getJob(req.params.id);
  if (job) {
    openStream();
    const stop = watch(job, (event) => {
      if (event === null) {
        res.write('event: end\ndata: {}\n\n');
        res.end();
        return;
      }
      res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
    });
    req.on('close', stop);
    return;
  }

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
