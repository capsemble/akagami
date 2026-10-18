# Chapter Quest

Upload a chapter. Gemini turns it into a short, story-driven 2D RPG you win by
_using_ the concept, not reciting it.

Google Cloud AI Builder Cup 2026 — prototype due **18 Oct 2026**.

---

## Run it

```bash
npm install          # also builds shared/ (root postinstall)
npm run dev          # server :8787 + web :5173
```

Open http://localhost:5173. `VITE_API=mock` is the default, so the whole flow
runs off `mocks/` with no API key and no server round-trips.

| Command                           | What it does                                                     |
| --------------------------------- | ---------------------------------------------------------------- |
| `npm run dev`                     | shared watch + server (tsx) + Vite, Vite proxies `/api` → :8787  |
| `npm run build`                   | shared → server → web, all to `dist/`                            |
| `npm run typecheck`               | tsc over all three workspaces                                    |
| `npm run smoke`                   | one real Gemini call each: text, image, embedding (needs `.env`) |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                |
| `npm run deploy`                  | `scripts/deploy.sh` → Cloud Run (see `SETUP.md` first)           |

Controls in the scene: **WASD/arrows** move · **E** interact · **B** collider
overlay · **T** agent trace · **Esc** close a panel.

### Troubleshooting

**`ENOSPC: System limit for number of file watchers reached`** — Linux has run
out of inotify watches, so Vite and `tsx watch` cannot start. On a dev box this
is almost always VS Code watching `node_modules` across every open project; it
can hold 60k+ watches on its own.

Unblock immediately, no sudo, no editor changes:

```bash
npm run dev:poll     # polls for changes instead; ~5% CPU idle, no inotify
```

Fix it properly (both, ideally):

```bash
# 1. raise the ceiling (survives reboots)
sudo sysctl -w fs.inotify.max_user_watches=524288
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-inotify.conf

# 2. stop VS Code eating them: settings.json
#    "files.watcherExclude": { "**/node_modules/**": true, "**/dist/**": true }
```

Check who is holding them with:
`for d in /proc/[0-9]*; do ...` — or just close VS Code and watch the error vanish.

## Layout and ownership

```
server/            → Hrutik
shared/types.ts    → Hrutik writes, Ranjan reviews (change only via PR)
mocks/             → Hrutik seeds, both extend
web/src/api/       → Hrutik (typed client + mock switch)
web/src/game/      → Ranjan (Phaser)
web/src/ui/        → Ranjan (Hrutik builds plain versions first)
```

`shared/types.ts` is the contract both sides compile against. Changing it
breaks the other person's build, so it moves by PR only.

## Mock vs live

`web/.env.development` sets `VITE_API=mock`; `.env.production` sets `live`.
Both modes implement the same `ApiClient` (`web/src/api/types.ts`), so nothing
else in the app knows which one is running.

- **mock** — fixtures from `mocks/`, 300–800 ms of fake latency, and the SSE
  stream replayed from `agent-events.json` with its original gaps.
- **live** — the Express server. Today its routes are stubs that read the same
  fixtures, so swapping modes should look identical.

To point the browser at the server: `VITE_API=live npm run dev -w @chapter-quest/web`.

## How the pieces fit

```
UploadPage ──createWorld──▶ forming screen (AgentTracePanel, streamEvents)
                                   │
                                   ▼
                            WorldScene (Phaser)
                                   │ E on an interactable
                                   ▼
                      gameBus 'interact' ──▶ React opens RagPanel / DialogBox
```

Colliders, interactables, spawn and NPC spots all come from `mocks/scenes/*.json`,
and the placeholder art is generated from those same rects:

```bash
node scripts/gen-mock-art.mjs   # rewrites web/public/mock-art/
```

Replace the SVGs with real art under the same filenames and nothing else changes.

## Art assets

Three kinds of art, with three different lifetimes.

**Per-world art** (cast, props, one floor plate per act) is painted during a
design run by `server/src/pipeline/art.ts`, keyed by the chapter's sha256, and
cached under `server/.cache/art/<hash>/`. It is served by `/api/art/...` and
hung on geometry the mapper already chose, so a plate that disagrees with its
room is a picture that looks wrong, never a room you cannot play. Rooms are
painted last, so a build that runs out of quota runs out on the floor rather
than on a face — which means worlds built on a tight day have a full cast and
no ground under it. Repair one without re-running the design pass:

```bash
npm run room -- world-d129fc2754b3        # every act missing a plate
npm run room -- world-d129fc2754b3 act1   # just that one
```

**Set dressing** (scrub, paving, pots, rock, trees) is _not_ per world. Scrub
looks the same in every world that has scrub in it, so one set is painted once,
committed to `web/public/dressing/`, and selected from by tag:

```bash
npm run dress                      # paint anything not already on disk
npm run dress -- tree-neem         # or just one
node scripts/bake-sprites.mjs      # raw plates → trimmed transparent PNGs
```

`npm run dress` writes raw JPEGs to `server/.cache/dressing/` — deliberately
not under `web/public`, or Vite would ship five megabytes of uncut plates to
the browser. The bake step keys the white studio field out, feathers the edge,
trims to the subject and writes the PNG the game loads. It needs a headless
Chrome and is a bench tool, not something the server or the game ever runs.

**Placeholder art** for the hand-written mock worlds is generated from the same
rects as the colliders:

```bash
node scripts/gen-mock-art.mjs   # rewrites web/public/mock-art/
```

### Dressing asset convention

One PNG per entry in `shared/dressing.ts`, named `web/public/dressing/<id>.png`,
with a real alpha channel and the subject trimmed to the edges of the image.

|            | **upright**                                         | **ground**                          |
| ---------- | --------------------------------------------------- | ----------------------------------- |
| anchor     | `(0.5, 1)` — bottom edge is the ground-contact line | `(0.5, 0.5)`                        |
| sized by   | `heightPx`, how tall it stands on screen            | `spreadPx`, how wide it lies        |
| drawn as   | the image's own aspect at that height               | `spreadPx` × `spreadPx / 2`         |
| painted as | standing on nothing: no ground, no base, no plinth  | a flat patch, twice as wide as deep |

Both are 2:1 dimetric with the light from the top left, and neither carries a
baked shadow — the renderer lays its own, which is what keeps a sprite sitting
on the floor the plate painted rather than on a lighter rectangle of its own.

Sizes are written as `metres(n)` against `PERSON_PX`, because the cast stand
62px tall and sizing by eye produced waist-high grass and bathtub-sized pots.

Tags are the whole selection interface. `dressingTagsFor` reads a room's own
name and description — the same keyword-table trick `propKindFor` plays on a
prop — and the mapper dresses from whatever comes back. Indoor rooms currently
get nothing, because every asset painted so far is outdoor and arid; adding an
indoor set is new briefs in `server/scripts/dress.ts` and new entries in the
catalogue, and no renderer changes at all.

Dressing never collides. A decoration produces no body and no hit area, so
`walkable()` returns the same answer for a dressed room as for a bare one —
that invariant is held by `server/test/dressing.test.ts`, not by convention.

## Models

Two providers behind one layer (`server/src/gemini.ts`):

|                |                                                                  |
| -------------- | ---------------------------------------------------------------- |
| **fastrouter** | One OpenAI-compatible endpoint in front of ~200 models. Default. |
| **google**     | `@google/genai` direct.                                          |

`MODEL_PROVIDER` picks one; unset, a `FASTROUTER_API_KEY` decides it. Each role
(`DESIGN_MODEL`, `TEXT_MODEL`, `FAST_MODEL`, `IMAGE_MODEL`, `EMBED_MODEL`) is an
env var, so swapping a model is a restart rather than a deploy.

```bash
npm run models            # does every role exist, and what does it cost?
npm run models -- --probe # one real call per role, to prove it does
npm run smoke             # one real call of each kind
```

Run `npm run models` before any long session: a wrong ID fails at call time with
a 404, forty seconds into a design run, not at startup. Use `--probe` when
changing a model — a router's catalogue can be wrong about what a model
supports, and the only reliable test is the call.

Measured on one real build (CV chapter → 3 acts, 20 painted assets):

|                               | tokens | cost   |
| ----------------------------- | ------ | ------ |
| design, 8 calls on Argon      | 75k    | ~$0.24 |
| design, same on `gpt-5-mini`  | 75k    | ~$0.04 |
| art, 20 images on nano-banana | 95k    | ~$0.57 |

Painting is the expensive part. `PAINT_ART=off` keeps the placeholder art and
the world still plays — worth setting while iterating on story or mechanics.

The schemas are written once as Gemini `responseSchema`s and translated to JSON
Schema on the way out to an OpenAI-compatible endpoint
(`server/src/providers/jsonschema.ts`) — one set of schemas, not two kept in step
by hand.

## What is deliberately fake

Everything marked `STUB` in `server/src/index.ts`: no retrieval, no Firestore,
no auth.

On the art side, three things are honestly unfinished rather than stubbed:

- **Indoor rooms are undressed.** The dressing catalogue is an outdoor, arid
  set, and an indoor set has not been painted. See `INDOOR_TAGS`.
- **A floor plate is a picture, not geometry.** Anything the plate paints
  standing on the ground — a shed, an awning — has no collider, because the
  colliders are the mapper's four walls. The room prompt keeps architecture to
  the outer edge for that reason, and the model does not always obey.
- **Dressing has no collision either, by design.** You can walk through a
  tree. Giving the large uprights bodies means re-running `walkable()` over
  every room in the library, which is a change to physics and not to art.

## Deploy

One Cloud Run service in `asia-southeast1` serving the API and `web/dist` from
one container. The key comes from Secret Manager and never reaches the client.
One-time gcloud setup: **`SETUP.md`**.
