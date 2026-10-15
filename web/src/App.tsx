import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Act,
  AgentEvent,
  RagParams,
  RagRunResponse,
  Scene,
  World,
} from '@chapter-quest/shared';
import { API_MODE, api } from './api';
import { SIM_AVAILABLE, defaultDials, runSim } from './api/sim';
import type { FormulaMechanic, SimOutcome } from './api/sim';
import { gameBus } from './game/bus';
import { PhaserGame } from './game/PhaserGame';
import { AgentTracePanel } from './ui/AgentTracePanel';
import { DioramaSlot } from './ui/DioramaSlot';
import { DialogBox } from './ui/DialogBox';
import { RagPanel } from './ui/RagPanel';
import { SimPanel } from './ui/SimPanel';
import { UploadPage } from './ui/UploadPage';
import { colors, fonts, radii, space } from './ui/tokens';

type Phase = 'upload' | 'forming' | 'playing';

const DEFAULT_RAG: RagParams = { chunkSize: 120, overlap: 15, k: 3, rerank: false };

export default function App() {
  const [phase, setPhase] = useState<Phase>('upload');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [worldId, setWorldId] = useState<string | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [traceOpen, setTraceOpen] = useState(true);
  const [skipped, setSkipped] = useState(false);

  const [actIndex, setActIndex] = useState(0);
  const [scene, setScene] = useState<Scene | null>(null);

  const [dialog, setDialog] = useState<{ speaker: string; text: string } | null>(null);
  const [ragOpen, setRagOpen] = useState(false);
  const [ragParams, setRagParams] = useState<RagParams>(DEFAULT_RAG);
  const [ragResult, setRagResult] = useState<RagRunResponse | null>(null);
  const [ragBusy, setRagBusy] = useState(false);

  const [simOpen, setSimOpen] = useState(false);
  const [dials, setDials] = useState<Record<string, number>>({});
  const [simOutcome, setSimOutcome] = useState<SimOutcome | null>(null);

  const act: Act | null = world?.acts[actIndex] ?? null;
  const formula: FormulaMechanic | null = act?.mechanic?.type === 'formula' ? act.mechanic : null;
  const formingDone = useMemo(
    () => events.some((e) => e.agent === 'Orchestrator' && e.kind === 'done'),
    [events],
  );
  // The replay runs ~21s, which is the point during the demo and a nuisance
  // while building. Skip jumps straight to the finished world.
  const worldReady = formingDone || skipped;

  // --- upload -------------------------------------------------------------
  const handleSubmit = useCallback(async (input: File | string) => {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createWorld(input);
      setWorldId(id);
      setEvents([]);
      setPhase('forming');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  // --- the world forming --------------------------------------------------
  useEffect(() => {
    if (phase !== 'forming' || !worldId) return;
    return api.streamEvents(worldId, (event) => setEvents((prev) => [...prev, event]));
  }, [phase, worldId]);

  useEffect(() => {
    if (!worldReady || !worldId || world) return;
    api
      .getWorld(worldId)
      .then(setWorld)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [worldReady, worldId, world]);

  // Each act starts unsolved, at its declared default dial positions.
  useEffect(() => {
    setSimOutcome(null);
    setDials(formula ? defaultDials(formula) : {});
  }, [formula]);

  // --- the scene for the current act --------------------------------------
  useEffect(() => {
    if (!world || !act) return;
    let live = true;
    setScene(null);
    api
      .getScene(world.id, act.sceneId)
      .then((next) => live && setScene(next))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [world, act]);

  // --- keyboard: T toggles the trace, Esc closes the RAG panel ------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /input|textarea/i.test(e.target.tagName);
      if (typing) return;
      if (e.key === 't' || e.key === 'T') setTraceOpen((open) => !open);
      if (e.key === 'Escape') {
        setRagOpen(false);
        setSimOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- Phaser → React -----------------------------------------------------
  useEffect(() => {
    return gameBus.on('interact', ({ id }) => {
      if (act?.mechanic?.type === 'formula') {
        setSimOpen(true);
        return;
      }
      if (id === 'satchel') {
        setRagOpen(true);
        return;
      }
      setDialog({
        speaker: world?.cast[0]?.name ?? 'The Archivist',
        text: act ? `${act.goal}\n\n(${id})` : `You examine the ${id.replace(/-/g, ' ')}.`,
      });
    });
  }, [act, world]);

  const runRag = useCallback(async () => {
    if (!world || !act) return;
    setRagBusy(true);
    try {
      const result = await api.runRag({
        worldId: world.id,
        actId: act.id,
        question: 'What dose did the Archivist record, and when?',
        params: ragParams,
      });
      setRagResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRagBusy(false);
    }
  }, [world, act, ragParams]);

  const handleRunSim = useCallback(() => {
    if (!formula) return;
    setSimOutcome(runSim(formula, dials));
  }, [formula, dials]);

  if (phase === 'upload') {
    return <UploadPage busy={busy} error={error} onSubmit={handleSubmit} />;
  }

  if (phase === 'forming') {
    return (
      <main style={styles.forming}>
        <DioramaSlot dioramaUrl={world?.dioramaUrl} />
        <h1 style={styles.formingTitle}>The world is forming…</h1>
        <p style={styles.hint}>press T to hide the trace</p>
        <AgentTracePanel events={events} open={traceOpen} onClose={() => setTraceOpen(false)} />
        <div style={styles.formingActions}>
          <button
            type="button"
            disabled={!world}
            onClick={() => setPhase('playing')}
            style={{ ...styles.enter, opacity: world ? 1 : 0.4 }}
          >
            {world ? `Enter ${world.title}` : 'Building…'}
          </button>
          {world ? null : (
            <button type="button" onClick={() => setSkipped(true)} style={styles.skip}>
              skip ▸
            </button>
          )}
        </div>
        {error ? <p style={styles.formingError}>{error}</p> : null}
      </main>
    );
  }

  return (
    <div style={styles.stage}>
      {scene ? (
        <PhaserGame scene={scene} paused={ragOpen || simOpen || dialog !== null} />
      ) : (
        <p style={styles.loading}>painting the scene…</p>
      )}

      <header style={styles.hud}>
        <div>
          <div style={styles.actTitle}>{act?.title}</div>
          <div style={styles.actGoal}>{act?.goal}</div>
        </div>
        <div style={styles.actChips}>
          {world?.acts.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setActIndex(i)}
              style={{
                ...styles.actChip,
                background: i === actIndex ? colors.gold : 'transparent',
                color: i === actIndex ? colors.ground : `${colors.parchment}aa`,
              }}
            >
              {a.id}
            </button>
          ))}
        </div>
      </header>

      <div style={styles.keyHint}>WASD move · E interact · B colliders · T trace</div>

      {traceOpen ? (
        <div style={styles.traceSlot}>
          <AgentTracePanel events={events} open onClose={() => setTraceOpen(false)} />
        </div>
      ) : null}

      {simOpen && formula && act ? (
        <div style={styles.overlay}>
          <SimPanel
            act={act}
            mechanic={formula}
            dials={dials}
            outcome={simOutcome}
            available={SIM_AVAILABLE}
            onChange={setDials}
            onRun={handleRunSim}
            onClose={() => setSimOpen(false)}
          />
        </div>
      ) : null}

      {ragOpen ? (
        <div style={styles.overlay}>
          <RagPanel
            question="What dose did the Archivist record, and when?"
            params={ragParams}
            result={ragResult}
            busy={ragBusy}
            onChange={setRagParams}
            onRun={runRag}
            onClose={() => setRagOpen(false)}
          />
        </div>
      ) : null}

      {dialog ? (
        <div style={styles.dialogSlot}>
          <DialogBox speaker={dialog.speaker} text={dialog.text} onClose={() => setDialog(null)} />
        </div>
      ) : null}

      <div style={styles.mode}>API: {API_MODE}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  forming: {
    position: 'relative',
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.lg,
  },
  formingTitle: {
    position: 'relative',
    zIndex: 1,
    margin: 0,
    fontFamily: fonts.header,
    fontSize: 36,
    color: colors.gold,
  },
  hint: {
    position: 'relative',
    zIndex: 1,
    margin: 0,
    fontSize: 12,
    color: `${colors.parchment}66`,
  },
  formingError: { position: 'relative', zIndex: 1, color: colors.fail },
  formingActions: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    gap: space.sm,
    alignItems: 'center',
  },
  skip: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: `${colors.parchment}88`,
  },
  enter: {
    padding: `${space.sm}px ${space.lg}px`,
    borderRadius: radii.chip,
    border: 'none',
    background: colors.gold,
    color: colors.ground,
    fontWeight: 700,
  },
  stage: { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' },
  loading: {
    display: 'grid',
    placeItems: 'center',
    height: '100%',
    color: `${colors.parchment}88`,
  },
  hud: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.md,
    padding: space.md,
    pointerEvents: 'none',
  },
  actTitle: {
    fontFamily: fonts.header,
    fontSize: 22,
    color: colors.gold,
    textShadow: '0 2px 6px #000',
  },
  actGoal: {
    maxWidth: 520,
    fontSize: 13,
    color: `${colors.parchment}cc`,
    textShadow: '0 2px 6px #000',
  },
  actChips: { display: 'flex', gap: space.xs, pointerEvents: 'auto' },
  actChip: {
    padding: `2px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}66`,
  },
  keyHint: {
    position: 'absolute',
    bottom: space.sm,
    left: space.md,
    fontSize: 12,
    color: `${colors.parchment}66`,
  },
  traceSlot: { position: 'absolute', top: 72, right: space.md },
  overlay: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    background: '#000000aa',
  },
  dialogSlot: {
    position: 'absolute',
    bottom: space.lg,
    left: 0,
    right: 0,
    display: 'grid',
    placeItems: 'center',
  },
  mode: {
    position: 'absolute',
    bottom: space.sm,
    right: space.md,
    fontSize: 11,
    color: `${colors.parchment}44`,
  },
};
