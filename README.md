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

## What is deliberately fake

Everything marked `STUB` in `server/src/index.ts`: no generation pipeline, no
retrieval, no Firestore, no auth. `shared/expr.ts` throws on purpose until the
tested evaluator lands. The model IDs in `.env.example` are unverified —
confirm them in AI Studio.

## Deploy

One Cloud Run service in `asia-southeast1` serving the API and `web/dist` from
one container. The key comes from Secret Manager and never reaches the client.
One-time gcloud setup: **`SETUP.md`**.
