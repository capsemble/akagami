import './env.js'; // first, so .env is loaded before anything reads it
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import type { RagParams, RagRunRequest } from '@chapter-quest/shared';
import { MODELS, getUsage, getUsageByModel } from './gemini.js';
import { loadEvents, loadRagTable, loadScene, loadWorld, pickRagKey } from './mocks.js';
import { mocksDir, webDist } from './paths.js';
import { artFile } from './pipeline/art.js';
import { extractFromString, extractPdfBytes } from './extract.js';
import { getJob, startDesign, watch } from './jobs.js';
import { adapt, adaptContext, readAdaptRequest } from './adapt.js';
import { chapterCorpus, runRag } from './rag.js';
import { listBuilt, loadBuilt, sourceOf } from './library.js';
import { askGuide, guideContext, readGuideRequest } from './guide.js';

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
    const { text, filename, pdf } = req.body ?? {};
    // A PDF comes up as base64 and is read here: the browser's file.text() on
    // a PDF is the raw binary, which used to be designed as if it were notes.
    const fromPdf =
      typeof pdf === 'string' ? await extractPdfBytes(Buffer.from(pdf, 'base64'), String(filename ?? 'upload.pdf')) : null;
    const raw = fromPdf ? fromPdf.text : String(text ?? '');
    console.log(`[worlds] create: ${filename ?? 'inline text'}, ${raw.length} chars${fromPdf ? ` from ${fromPdf.pages.length} PDF pages` : ''}`);

    const demo = /^demo:(rag|kinematics|machine)\b/i.exec(raw.trim());
    if (demo) {
      const world = await loadWorld(demo[1]!.toLowerCase());
      res.status(202).json({ id: world.id });
      return;
    }
    if (raw.trim().length < 200) {
      res.status(400).json({
        error: fromPdf
          ? 'That PDF has almost no selectable text (a scan?). Paste the notes as text instead.'
          : 'That is too short to be a chapter.',
      });
      return;
    }

    const chapter = fromPdf ?? extractFromString(raw, filename ?? 'inline text');
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
  if (!/^[0-9a-f]{1,32}$/.test(hash) || !/^[a-z0-9-]{1,64}\.(png|jpe?g|webp)$/.test(file)) {
    res.status(400).json({ error: 'bad asset path' });
    return;
  }
  res.sendFile(artFile(hash, file), (err) => {
    if (err) res.status(404).json({ error: 'not painted' });
  });
});

/**
 * Worlds already built on this machine. The client puts them under the demo
 * buttons so a chapter you paid minutes for is one click away, instead of a
 * build you have to run again because the server restarted.
 */
app.get('/api/worlds', async (_req, res) => {
  try {
    res.json({ worlds: await listBuilt() });
  } catch (err) {
    fail(res, err, 500);
  }
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
  // Not in memory: either a demo fixture, or a world this machine built before
  // the last restart, which the stage cache can reassemble for nothing.
  try {
    const built = await loadBuilt(req.params.id);
    if (built) {
      res.json(built.world);
      return;
    }
  } catch (err) {
    // Built, but not one act of it can be finished. Say that, rather than
    // serve a world whose first gate never opens.
    fail(res, err, 422);
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
  const built = await loadBuilt(req.params.id).catch(() => null);
  const rebuilt = built?.scenes.get(req.params.sceneId);
  if (rebuilt) {
    res.json(rebuilt);
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

/**
 * One trip to the Oracle. For an act on the live corpus this is the real
 * pipeline — Gemini embeddings, retrieval, a Gemini answer, a judge — see
 * rag.ts. The question comes from the act, never from the request. If the
 * pipeline cannot run, the canned table answers instead and says so
 * (`live: false`), rather than the panel going dead mid-demo.
 */
const CHUNK_SIZES = [40, 120, 250, 500] as const;
const OVERLAPS = [0, 15, 30] as const;
function readRagParams(raw: unknown): RagParams | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const chunkSize = CHUNK_SIZES.find((n) => n === p.chunkSize);
  const overlap = OVERLAPS.find((n) => n === p.overlap);
  const k = Number(p.k);
  if (!chunkSize || overlap === undefined || !Number.isInteger(k) || k < 1 || k > 8) return null;
  return {
    chunkSize,
    overlap,
    k,
    rerank: p.rerank === true,
    ...(p.rule === 'grounded' ? { rule: 'grounded' } : {}),
  };
}

app.post('/api/rag/run', async (req: Request, res: Response) => {
  const body = req.body as Partial<RagRunRequest>;
  const params = readRagParams(body.params);
  if (!params) return fail(res, new Error('bad retrieval settings'), 400);
  const context =
    typeof body.worldId === 'string' && typeof body.actId === 'string'
      ? await guideContext({
          worldId: body.worldId,
          actId: body.actId,
          characterId: '',
          playerSays: '-',
          history: [],
          solved: false,
        }).catch(() => null)
      : null;
  const mechanic = context?.act.mechanic;
  // Played over the chapter the world was built from. There is no canned
  // table for a chapter nobody has seen, so a failure here is reported, not
  // papered over.
  if (mechanic?.type === 'ai-system' && mechanic.corpus === 'chapter') {
    try {
      const text = await sourceOf(String(body.worldId));
      if (!text)
        return fail(
          res,
          new Error('the chapter this world was built from is not on this server'),
          404,
        );
      res.json(
        await runRag(
          mechanic.question,
          params,
          mechanic.ragAct,
          undefined,
          chapterCorpus(text, mechanic),
        ),
      );
    } catch (err) {
      fail(res, err);
    }
    return;
  }
  if (mechanic?.type === 'ai-system' && mechanic.corpus === 'oracle') {
    try {
      res.json(await runRag(mechanic.question, params, mechanic.ragAct));
      return;
    } catch (err) {
      console.warn(
        '[rag] live run failed, answering from the table:',
        err instanceof Error ? err.message.slice(0, 160) : err,
      );
    }
  }
  try {
    const table = await loadRagTable();
    const key = pickRagKey(table, params);
    const hit = table[key];
    if (!hit) return fail(res, new Error(`no fixture for ${key}`), 404);
    res.json({ ...hit, fixtureKey: key, live: false });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Ask the guide a question. Grounded in the chapter the world was built from,
 * barred from giving away a dial's winning value, and honest when no model is
 * answering — see guide.ts.
 */
app.post('/api/npc/turn', async (req, res) => {
  const question = readGuideRequest(req.body);
  if (!question) {
    res.status(400).json({ error: 'A question needs worldId, actId, characterId and playerSays.' });
    return;
  }
  try {
    const context = await guideContext(question);
    if (!context) return fail(res, new Error('no such world, act or guide'), 404);
    res.json(await askGuide(context, question));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * A failed attempt, read for the misconception behind it. The attempt is
 * re-judged from the act's own data; the model only chooses among the
 * curriculum's misconceptions and writes the lines. See adapt.ts.
 */
app.post('/api/adapt', async (req, res) => {
  const request = readAdaptRequest(req.body);
  if (!request) return fail(res, new Error('not an attempt'), 400);
  try {
    const context = await adaptContext(request);
    if (!context) return fail(res, new Error('no such world or act'), 404);
    res.json(await adapt(context, request));
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
