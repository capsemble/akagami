import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Act,
  AgentEvent,
  RagParams,
  RagRunResponse,
  Scene,
  World,
} from '@chapter-quest/shared';
import { evaluate } from '@chapter-quest/shared';
import { API_MODE, api } from './api';
import { SIM_AVAILABLE, defaultDials, runSim } from './api/sim';
import type { FormulaMechanic, SimOutcome } from './api/sim';
import { gameBus } from './game/bus';
import { PhaserGame } from './game/PhaserGame';
import { sfx } from './game/sfx';
import { AgentTracePanel } from './ui/AgentTracePanel';
import { DioramaSlot } from './ui/DioramaSlot';
import { DialogBox } from './ui/DialogBox';
import { RagPanel } from './ui/RagPanel';
import { SimPanel } from './ui/SimPanel';
import { UploadPage } from './ui/UploadPage';
import { colors, fonts, radii, space } from './ui/tokens';

type Phase = 'upload' | 'forming' | 'playing';

/** Something the player picked up and is reading, as opposed to the act's cast. */
interface Reading {
  speaker: string;
  lines: string[];
  index: number;
}

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

  /** Index into the current act's dialogue, or null when nobody is speaking. */
  const [line, setLine] = useState<number | null>(null);
  const [reading, setReading] = useState<Reading | null>(null);
  const [ragOpen, setRagOpen] = useState(false);
  const [ragParams, setRagParams] = useState<RagParams>(DEFAULT_RAG);
  const [ragResult, setRagResult] = useState<RagRunResponse | null>(null);
  const [ragBusy, setRagBusy] = useState(false);

  const [simOpen, setSimOpen] = useState(false);
  /** Mirrors the engine's own flag, which is what survives a reload. */
  const [muted, setMuted] = useState(sfx.isMuted);
  const [dials, setDials] = useState<Record<string, number>>({});
  const [simOutcome, setSimOutcome] = useState<SimOutcome | null>(null);
  /** True once the scene has finished acting the run out and the verdict can show. */
  const [verdict, setVerdict] = useState<boolean | null>(null);
  /** What a live run reported, so the verdict can be a number and not a shrug. */
  const [outputs, setOutputs] = useState<Record<string, number> | null>(null);
  /** Acts the player has actually beaten. Nothing opens until the one before it. */
  const [solved, setSolved] = useState<string[]>([]);
  const [endingOpen, setEndingOpen] = useState(false);
  /** Dismissed the "this is not your chapter" notice. */
  const [substitutionSeen, setSubstitutionSeen] = useState(false);

  const act: Act | null = world?.acts[actIndex] ?? null;
  const formula: FormulaMechanic | null = act?.mechanic?.type === 'formula' ? act.mechanic : null;
  const stage = act?.stage ?? null;

  /**
   * The winning span, in the playback path's own units, so the scene can paint
   * it where it actually is. It is the same band the chart draws — one source,
   * two places, no chance of the floor disagreeing with the graph.
   */
  const target = useMemo(() => {
    const band = formula?.spec.visual?.band;
    const playback = stage?.playback;
    if (!band || !playback) return null;
    try {
      const scope = { ...formula!.spec.constants };
      return {
        from: evaluate(band.from, scope),
        to: evaluate(band.to, scope),
        label: playback.actor === 'train' ? 'stop inside here' : 'land on here',
      };
    } catch {
      return null; // a band that will not evaluate is not worth crashing over
    }
  }, [formula, stage]);

  const dialogue = act?.dialogue ?? [];
  const speaking = reading
    ? { speaker: reading.speaker, line: reading.lines[reading.index]!, mood: undefined }
    : line !== null
      ? dialogue[line]
      : undefined;
  const speakingCast = speaking
    ? world?.cast.find((c) => c.name === speaking.speaker || c.id === speaking.speaker)
    : undefined;
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

  // The cast says its piece when you arrive, once per act.
  useEffect(() => {
    setLine(act?.dialogue?.length ? 0 : null);
    setReading(null);
  }, [act]);

  // Each act starts unsolved, at its declared default dial positions.
  useEffect(() => {
    setSimOutcome(null);
    setVerdict(null);
    setOutputs(null);
    setSimOpen(false);
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

  // --- keyboard: T toggles the trace, Esc closes a panel -------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /input|textarea/i.test(e.target.tagName);
      if (typing) return;
      if (e.key === 't' || e.key === 'T') setTraceOpen((open) => !open);
      if (e.key === 'Escape') {
        setRagOpen(false);
        setSimOpen(false);
        setLine(null);
        setReading(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- Phaser → React ------------------------------------------------------

  /**
   * The scene has committed the numbers the player produced in the world. We
   * own the physics, so run it here and hand the samples straight back — the
   * emit has to be synchronous, because the scene has already put itself into
   * its playing state and is waiting for something to move.
   */
  useEffect(() => {
    return gameBus.on('commit', ({ values }) => {
      setDials(values);
      if (!formula) return;
      const outcome = runSim(formula, values);
      if (!outcome) return;
      setSimOutcome(outcome);
      gameBus.emit('outcome', { won: outcome.won, values, samples: outcome.samples });
    });
  }, [formula]);

  // Still choosing: clear the last verdict so a stale "Not yet." cannot linger.
  useEffect(() => {
    return gameBus.on('aiming', ({ values }) => {
      setDials(values);
      setVerdict(null);
      setOutputs(null);
      setSimOutcome(null);
    });
  }, []);

  useEffect(() => {
    return gameBus.on('played', ({ won, outputs: ran }) => {
      setVerdict(won);
      setOutputs(ran ?? null);
      if (!won || !act) return;
      setSolved((done) => (done.includes(act.id) ? done : [...done, act.id]));
      // The turn the story agent wrote and the runtime used to throw away. It
      // is decided here, where the act and the result are the same event — read
      // from `verdict` in an effect instead and the previous act's win leaks
      // into the render that switches to this one.
      if (world?.twist && act.id === world.acts[world.acts.length - 1]?.id) setEndingOpen(true);
    });
  }, [act, world]);

  useEffect(() => {
    return gameBus.on('read', ({ id }) => {
      const readable = act?.stage?.readables?.[id];
      if (readable) setReading({ speaker: readable.speaker, lines: readable.lines, index: 0 });
    });
  }, [act]);

  // Acts with no stage still open the old panel, so nothing regresses while
  // the generator is being taught to emit stages.
  useEffect(() => {
    return gameBus.on('interact', ({ id }) => {
      if (line !== null || reading) return; // let them finish reading first
      if (stage) return; // a staged act is played in the world, not in a panel
      if (act?.mechanic?.type === 'formula') {
        setSimOpen(true);
        return;
      }
      if (id === 'satchel') {
        setRagOpen(true);
        return;
      }
      console.info('[game] nothing wired to', id);
    });
  }, [act, stage, line, reading]);

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

  const advanceReading = useCallback(() => {
    setReading((current) =>
      current && current.index < current.lines.length - 1
        ? { ...current, index: current.index + 1 }
        : null,
    );
  }, []);

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

  const lastAct = world ? actIndex >= world.acts.length - 1 : true;
  const driven = stage?.bindings.some((b) => b.kind === 'control') ?? false;
  const readout = stage?.readout;
  const measured =
    readout && outputs && Number.isFinite(outputs[readout.output])
      ? `${readout.label} ${Math.round(outputs[readout.output]! * 10) / 10}${readout.unit ?? ''}`
      : null;

  return (
    <div style={styles.stage}>
      {scene ? (
        <PhaserGame
          scene={scene}
          cast={world?.cast}
          stage={stage}
          {...(formula ? { params: formula.params, spec: formula.spec } : {})}
          target={target}
          paused={ragOpen || simOpen || speaking !== undefined}
        />
      ) : (
        <p style={styles.loading}>painting the scene…</p>
      )}

      {world?.substituted && !substitutionSeen ? (
        <div style={styles.substituted}>
          <strong style={{ color: colors.fail }}>Not your chapter.</strong>
          <span style={styles.verdictText}>{world.substituted}</span>
          <button
            type="button"
            onClick={() => setSubstitutionSeen(true)}
            style={styles.verdictButton}
          >
            got it
          </button>
        </div>
      ) : null}

      <header style={styles.hud}>
        <div style={styles.hudText}>
          <div style={styles.actTitle}>{act?.title}</div>
          <div style={styles.actGoal}>{act?.goal}</div>
        </div>
        <div style={styles.actChips}>
          {world?.acts.map((a, i) => {
            const previous = world.acts[i - 1];
            const open = i === 0 || !previous || solved.includes(previous.id);
            return (
              <button
                key={a.id}
                type="button"
                disabled={!open}
                title={open ? a.title : 'finish the one before it'}
                onClick={() => open && setActIndex(i)}
                style={{
                  ...styles.actChip,
                  background: i === actIndex ? colors.gold : 'transparent',
                  color:
                    i === actIndex ? colors.ground : `${colors.parchment}${open ? 'aa' : '44'}`,
                  borderColor: open ? `${colors.gold}66` : `${colors.parchment}22`,
                  cursor: open ? 'pointer' : 'default',
                }}
              >
                {open ? a.title : '• • •'}
                {solved.includes(a.id) ? ' ✓' : ''}
              </button>
            );
          })}
        </div>
      </header>

      {verdict !== null && act ? (
        <div
          style={{
            ...styles.verdict,
            borderColor: verdict ? colors.success : colors.fail,
          }}
        >
          <strong
            style={{ color: verdict ? colors.success : colors.fail, fontFamily: fonts.header }}
          >
            {verdict ? 'It lands.' : 'Not yet.'}
          </strong>
          {measured ? <span style={styles.measured}>{measured}</span> : null}
          <span style={styles.verdictText}>
            {verdict
              ? (act.beat?.won ?? act.explainAfter)
              : (act.beat?.lost ??
                (driven
                  ? 'F to let her go again — your last runs stay on the track.'
                  : 'R to reset and try it differently.'))}
          </span>
          <button
            type="button"
            onClick={() => {
              sfx.open();
              setSimOpen(true);
            }}
            style={styles.verdictButton}
          >
            show me why
          </button>
          {verdict && !lastAct ? (
            <button
              type="button"
              onClick={() => {
                sfx.chapter();
                setActIndex((i) => i + 1);
              }}
              style={{ ...styles.verdictButton, borderColor: colors.gold, color: colors.gold }}
            >
              next act ▸
            </button>
          ) : null}
        </div>
      ) : null}

      <div style={styles.keyHint}>
        {stage
          ? 'WASD move · E act · F run · R reset · M sound · T trace'
          : 'WASD move · E interact · M sound · T trace'}
        {dialogue.length > 0 ? (
          <button type="button" onClick={() => setLine(0)} style={styles.replay}>
            replay dialogue
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setMuted(sfx.toggle())}
          style={styles.replay}
          aria-label={muted ? 'turn sound on' : 'turn sound off'}
        >
          {muted ? 'sound off' : 'sound on'}
        </button>
      </div>

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
            staged={stage !== null}
            onChange={setDials}
            onRun={handleRunSim}
            onClose={() => {
              sfx.close();
              setSimOpen(false);
            }}
          />
        </div>
      ) : null}

      {endingOpen && world?.twist ? (
        <div style={styles.overlay}>
          <section style={styles.ending}>
            <h2 style={styles.endingTitle}>{world.title}</h2>
            <p style={styles.endingTwist}>{world.twist}</p>
            {world.villain ? <p style={styles.endingVillain}>— {world.villain}</p> : null}
            <button type="button" onClick={() => setEndingOpen(false)} style={styles.enter}>
              Close the file
            </button>
          </section>
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
            onClose={() => {
              sfx.close();
              setRagOpen(false);
            }}
          />
        </div>
      ) : null}

      {speaking ? (
        <div style={styles.dialogSlot}>
          <DialogBox
            speaker={speaking.speaker}
            {...(speakingCast
              ? { portrait: speakingCast.portraits[speaking.mood ?? 'neutral'] }
              : {})}
            text={speaking.line}
            {...(reading
              ? reading.index < reading.lines.length - 1
                ? { onNext: advanceReading }
                : {}
              : line !== null && line < dialogue.length - 1
                ? { onNext: () => setLine(line + 1) }
                : {})}
            onClose={() => (reading ? setReading(null) : setLine(null))}
          />
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
  // The scene paints its own labels, so the HUD sits on a plate of its own
  // rather than letting two kinds of text share the same pixels.
  hudText: {
    maxWidth: 560,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    background: '#0b0806cc',
    border: `1px solid ${colors.gold}33`,
  },
  actTitle: { fontFamily: fonts.header, fontSize: 20, color: colors.gold },
  actGoal: { fontSize: 13, lineHeight: 1.45, color: `${colors.parchment}cc` },
  actChips: { display: 'flex', gap: space.xs, pointerEvents: 'auto' },
  actChip: {
    padding: `2px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}66`,
  },
  verdict: {
    position: 'absolute',
    top: 104,
    left: space.md,
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    width: 'min(620px, calc(100vw - 420px))',
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: '1px solid',
    background: '#0b0806f2',
  },
  verdictText: { fontSize: 13, lineHeight: 1.45, color: `${colors.parchment}cc` },
  // A world that is not built from the uploaded chapter has to say so, loudly
  // and once. Silent substitution is indistinguishable from a broken upload.
  substituted: {
    position: 'absolute',
    bottom: space.lg,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 5,
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: 'min(720px, 92vw)',
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.fail}`,
    background: '#0b0806f2',
  },
  measured: {
    flexShrink: 0,
    fontFamily: fonts.header,
    fontSize: 15,
    color: colors.gold,
    whiteSpace: 'nowrap',
  },
  verdictButton: {
    flexShrink: 0,
    padding: `3px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}44`,
    background: 'transparent',
    color: `${colors.parchment}aa`,
    fontSize: 12,
  },
  keyHint: {
    position: 'absolute',
    bottom: space.sm,
    left: space.md,
    fontSize: 12,
    color: `${colors.parchment}66`,
  },
  replay: {
    marginLeft: space.sm,
    padding: `1px ${space.xs}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: `${colors.parchment}66`,
    fontSize: 11,
  },
  ending: {
    width: 'min(640px, 92vw)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.md,
    padding: space.lg,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}66`,
    background: '#0b0806f6',
  },
  endingTitle: { margin: 0, fontFamily: fonts.header, fontSize: 28, color: colors.gold },
  endingTwist: { margin: 0, fontSize: 15, lineHeight: 1.65, color: `${colors.parchment}ee` },
  endingVillain: {
    margin: 0,
    fontFamily: fonts.header,
    fontSize: 14,
    color: `${colors.parchment}88`,
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
