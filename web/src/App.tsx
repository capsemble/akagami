import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Act,
  AgentEvent,
  AttemptReport,
  Medal,
  RagParams,
  RagRunResponse,
  Scene,
  TeachingMove,
  EvidenceAction,
  EvidenceState,
  SequenceAction,
  SequenceState,
  World,
} from '@chapter-quest/shared';
import {
  applyEvidence,
  applySequence,
  evaluate,
  gradeRun,
  initialEvidenceState,
  initialSequenceState,
  proofOf,
  winningBand,
} from '@chapter-quest/shared';
import { API_MODE, api } from './api';
import { SIM_AVAILABLE, defaultDials, runSim } from './api/sim';
import type { FormulaMechanic, SimOutcome } from './api/sim';
import { gameBus } from './game/bus';
import { PhaserGame } from './game/PhaserGame';
import { sfx } from './game/sfx';
import { AgentTracePanel } from './ui/AgentTracePanel';
import { BuildStages } from './ui/BuildStages';
import { DioramaSlot } from './ui/DioramaSlot';
import { DialogBox } from './ui/DialogBox';
import { AskPanel } from './ui/AskPanel';
import type { AskEntry } from './ui/AskPanel';
import { RagPanel } from './ui/RagPanel';
import { AdaptCard } from './ui/AdaptCard';
import { EvidencePanel } from './ui/EvidencePanel';
import { InsightCard, PredictionCard } from './ui/PredictionCard';
import { ProofPanel } from './ui/ProofPanel';
import { SequencePanel } from './ui/SequencePanel';
import { ResultCard } from './ui/ResultCard';
import { SimPanel } from './ui/SimPanel';
import { TitleCard } from './ui/TitleCard';
import { UploadPage } from './ui/UploadPage';
import { colors, fonts, radii, space } from './ui/tokens';

type Phase = 'upload' | 'forming' | 'title' | 'playing';

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
  // Closed by default now that the forming screen names the stages itself.
  // The trace is still the truth and T still opens it — it is the thing you
  // reach for when a stage says something surprising, not the thing you watch.
  const [traceOpen, setTraceOpen] = useState(false);
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
  /**
   * How many acts the player has walked into. Acts open by going through the
   * gate, not by clicking ahead, so the chips can take you back to a room you
   * have been in but never forward past a gate you have not opened.
   */
  const [reached, setReached] = useState(1);
  /** Bumped to rebuild the scene in place, e.g. after the ending is closed. */
  const [sceneKey, setSceneKey] = useState(0);
  /** The conversation with the guide, for the act in hand. */
  const [askOpen, setAskOpen] = useState(false);
  const [askLog, setAskLog] = useState<AskEntry[]>([]);
  const [askBusy, setAskBusy] = useState(false);
  /** Bumped on every finished run, so the same verdict twice still counts twice. */
  const [runs, setRuns] = useState(0);
  /** Each finished run of the act in hand: how far from the middle it landed. */
  const [misses, setMisses] = useState<number[]>([]);
  /** The best medal per act, this session. */
  const [medals, setMedals] = useState<Record<string, Medal>>({});
  /** Dismissed the "this is not your chapter" notice. */
  const [substitutionSeen, setSubstitutionSeen] = useState(false);
  /** Dismissed the "some acts were left out" notice. */
  const [omissionSeen, setOmissionSeen] = useState(false);
  /** The board of a sequence act: where the cards are, and the last verdict. */
  const [seqOpen, setSeqOpen] = useState(false);
  const [seq, setSeq] = useState<SequenceState | null>(null);
  /** The board of an evidence act: which document is pinned to which claim. */
  const [evOpen, setEvOpen] = useState(false);
  const [ev, setEv] = useState<EvidenceState | null>(null);
  /** What was proved about the act in hand, opened from the act card. */
  const [proofOpen, setProofOpen] = useState(false);
  /** act id → the option the player committed to, or null if they skipped. */
  const [guesses, setGuesses] = useState<Record<string, number | null>>({});
  /** Acts whose after-the-win card has been closed. */
  const [insightClosed, setInsightClosed] = useState<string[]>([]);
  /** The teaching move for the last miss, and how many misses each act has had. */
  const [adaptMove, setAdaptMove] = useState<TeachingMove | null>(null);
  const [failures, setFailures] = useState<Record<string, number>>({});
  const adapting = useRef(false);

  const act: Act | null = world?.acts[actIndex] ?? null;
  const formula: FormulaMechanic | null = act?.mechanic?.type === 'formula' ? act.mechanic : null;
  const sequence = act?.mechanic?.type === 'sequence' ? act.mechanic : null;
  const board = act?.mechanic?.type === 'evidence' ? act.mechanic : null;
  /**
   * A retrieval act the runtime can play: live over the Old Library's scrolls,
   * or from the canned table it falls back to.
   */
  const fixtureRag =
    act?.mechanic?.type === 'ai-system' && act.mechanic.corpus ? act.mechanic : null;
  const stage = act?.stage ?? null;

  /**
   * The winning span, in the playback path's own units, so the scene can paint
   * it where it actually is. It is the same band the chart draws — one source,
   * two places, no chance of the floor disagreeing with the graph.
   */
  /**
   * The span of the judged number that wins, measured off the validated
   * solution (see shared/grade.ts). Null for an act whose verdict does not turn
   * on that number alone — it is still won or lost, just not medalled.
   */
  // Fixture worlds predate `guide`; anyone in the cast can answer for them.
  const guideId = world?.guide ?? world?.cast[0]?.id ?? null;
  const guide = world?.cast.find((c) => c.id === guideId) ?? null;

  const medalBand = useMemo(() => {
    const readout = stage?.readout;
    if (!formula || !readout) return null;
    return winningBand(formula.spec, formula.params, readout.output);
  }, [formula, stage]);

  const target = useMemo(() => {
    const band = formula?.spec.visual?.band;
    const playback = stage?.playback;
    if (!playback) return null;
    const label = playback.actor === 'train' ? 'stop inside here' : 'land on here';
    if (!band) {
      // No drawn band, but the act may still be judged on *where* it ends — a
      // stop at 96–104 m with nothing on the floor saying so is a brake point
      // you have to guess. Use the measured span, but only when the judged
      // number is literally the distance travelled: a speed band painted on
      // the track would be a lie in metres.
      const output = stage?.readout?.output;
      const isPlace = output && formula?.spec.outputs[output]?.trim() === playback.along;
      return isPlace && medalBand ? { ...medalBand, label } : null;
    }
    try {
      const scope = { ...formula!.spec.constants };
      return {
        from: evaluate(band.from, scope),
        to: evaluate(band.to, scope),
        label,
      };
    } catch {
      return null; // a band that will not evaluate is not worth crashing over
    }
  }, [formula, stage, medalBand]);

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
      setActIndex(0);
      setReached(1);
      setSolved([]);
      setPhase('forming');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Open a world that already exists, skipping the build entirely.
   *
   * Straight past the forming screen: there is no stream to watch because
   * nothing is being designed, and the effect below fetches the world because
   * `world` is still null. Replaying the old build trace would be a lie about
   * what is happening right now. The title card still gets its moment.
   */
  const handleOpen = useCallback((id: string) => {
    setError(null);
    setEvents([]);
    setWorld(null);
    setActIndex(0);
    setSolved([]);
    setReached(1);
    setWorldId(id);
    setSkipped(true);
    setTraceOpen(false);
    setPhase('title');
  }, []);

  // --- the world forming --------------------------------------------------
  useEffect(() => {
    if (phase !== 'forming' || !worldId) return;
    return api.streamEvents(worldId, (event) => setEvents((prev) => [...prev, event]));
  }, [phase, worldId]);

  // A build the server refused — nothing in the chapter is playable — ends on
  // its reason. Without this the forming screen waited for a world forever.
  useEffect(() => {
    const refused = events.find((e) => e.agent === 'Orchestrator' && e.kind === 'rejected');
    if (refused) setError(refused.message);
  }, [events]);

  // Skip asks for the world before the build has finished, and a build that
  // paints its art runs for minutes. "Still building" is a reason to ask again
  // in a moment, not an error: answered once and never retried, it left the
  // forming screen stuck on a world that was ready a minute later.
  const [worldPoll, setWorldPoll] = useState(0);
  useEffect(() => {
    if (!worldReady || !worldId || world) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    api
      .getWorld(worldId)
      .then((next) => live && setWorld(next))
      .catch((err) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : String(err);
        if (/→ 409\b/.test(message)) {
          setError(null);
          retry = setTimeout(() => setWorldPoll((n) => n + 1), 3000);
          return;
        }
        setError(message);
      });
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
    };
  }, [worldReady, worldId, world, worldPoll]);

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
    setMisses([]);
    setDials(formula ? defaultDials(formula) : {});
  }, [formula]);

  // A sequence act starts with its cards where the mechanic says, every visit.
  useEffect(() => {
    setSeqOpen(false);
    setSeq(sequence ? initialSequenceState(sequence) : null);
  }, [sequence]);

  // A retrieval act opens with the satchel its lesson is about, every visit.
  useEffect(() => {
    setRagResult(null);
    setRagParams(fixtureRag?.start ?? DEFAULT_RAG);
  }, [fixtureRag]);

  // An evidence act starts with every document on the table, every visit.
  useEffect(() => {
    setEvOpen(false);
    setEv(board ? initialEvidenceState() : null);
  }, [board]);

  /**
   * The one way an act becomes solved, whatever its mechanic: a formula run
   * that wins, a sequence that breaks no rule, a fixture RAG answer the judge
   * passes. Each caller has already applied its own validated condition; this
   * only records it and opens the way on.
   */
  const markSolved = useCallback(
    (actId: string) => {
      setSolved((done) => (done.includes(actId) ? done : [...done, actId]));
      // A room with a gate ends through it: winning the last act opens the way
      // out, and walking through it is the finale. A room with no exit at all
      // still ends on the win.
      const last = actId === world?.acts[world.acts.length - 1]?.id;
      if (last && !scene?.exits.length) setEndingOpen(true);
    },
    [world, scene],
  );

  /**
   * A miss, sent to be read for the misconception behind it. Only the raw
   * attempt goes: the server re-judges it from the act rather than trusting
   * this side's verdict. One at a time — a second miss while the first is
   * being read waits for the next.
   */
  const requestAdapt = useCallback(
    (attempt: AttemptReport) => {
      if (!world || !act || adapting.current) return;
      const count = (failures[act.id] ?? 0) + 1;
      setFailures((f) => ({ ...f, [act.id]: count }));
      adapting.current = true;
      const actId = act.id;
      api
        .adapt({ worldId: world.id, actId, attempt, failures: count })
        .then((move) => setAdaptMove(move))
        .catch((err) => console.warn('[adapt]', err))
        .finally(() => {
          adapting.current = false;
        });
    },
    [world, act, failures],
  );

  // A new act, or a win, clears the last miss's lesson.
  useEffect(() => setAdaptMove(null), [act?.id]);
  useEffect(() => {
    if (act && solved.includes(act.id)) setAdaptMove(null);
  }, [act, solved]);

  const actOnSequence = useCallback(
    (action: SequenceAction) => {
      if (!sequence || !act || !seq) return;
      const next = applySequence(sequence, seq, action);
      setSeq(next);
      if (action.kind !== 'check') return;
      if (next.last?.won) sfx.chapter();
      // Decided from the reducer's own verdict, in the same step as the
      // check — never from a conversation or a model's opinion.
      if (next.solved) markSolved(act.id);
      else if (next.last && !next.last.won) requestAdapt({ kind: 'sequence', order: next.order });
    },
    [sequence, act, seq, markSolved, requestAdapt],
  );

  const actOnEvidence = useCallback(
    (action: EvidenceAction) => {
      if (!board || !act || !ev) return;
      const next = applyEvidence(board, ev, action);
      setEv(next);
      if (action.kind !== 'check') return;
      if (next.last?.won) sfx.chapter();
      // The validated links decide, in the same step as the check.
      if (next.solved) markSolved(act.id);
      else if (next.last && !next.last.won) requestAdapt({ kind: 'evidence', pins: next.pins });
    },
    [board, act, ev, markSolved, requestAdapt],
  );

  // Every finished run is a data point: where it landed against the middle of
  // the winning span. Two in a row is a comparison the player can act on, and
  // the best of them is the medal the act keeps.
  useEffect(() => {
    if (runs === 0 || !medalBand || !act) return;
    const output = act.stage?.readout?.output;
    const ran = outputs ?? simOutcome?.outputs;
    const value = output && ran ? ran[output] : undefined;
    if (value === undefined || !Number.isFinite(value)) return;
    setMisses((before) => [...before, Math.abs(value - (medalBand.from + medalBand.to) / 2)]);
    const earned = verdict ? gradeRun(value, medalBand).medal : null;
    if (earned) {
      setMedals((best) => {
        const held = best[act.id];
        return held && MEDAL_RANK[held] >= MEDAL_RANK[earned]
          ? best
          : { ...best, [act.id]: earned };
      });
    }
    // Keyed on the run counter alone: the outputs and verdict it reads were set
    // in the same batch, and re-running on either would count one run twice.
  }, [runs]);

  // A formula run that missed is read for its misconception too. Same key, same
  // reason: one finished run, one request.
  useEffect(() => {
    if (runs === 0 || verdict !== false || !formula) return;
    const ran = outputs ?? simOutcome?.outputs;
    if (ran) requestAdapt({ kind: 'formula', settings: dials, outputs: ran });
  }, [runs]);

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
      if (e.key === 'q' || e.key === 'Q') setAskOpen(true);
      if (e.key === 'Escape') {
        setRagOpen(false);
        setSeqOpen(false);
        setEvOpen(false);
        setProofOpen(false);
        setSimOpen(false);
        setAskOpen(false);
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
      setRuns((n) => n + 1);
      // Decided here, where the act and the result are the same event — read
      // from `verdict` in an effect and the previous act's win leaks into the
      // render that switches to this one.
      if (won && act) markSolved(act.id);
    });
  }, [act, markSolved]);

  // Through the gate: the next act, or from the last one, the end of the story.
  useEffect(() => {
    return gameBus.on('exit', () => {
      if (!world) return;
      sfx.chapter();
      if (actIndex >= world.acts.length - 1) {
        setEndingOpen(true);
        return;
      }
      setReached((r) => Math.max(r, actIndex + 2));
      setActIndex(actIndex + 1);
    });
  }, [world, actIndex]);

  useEffect(() => gameBus.on('ask', () => setAskOpen(true)), []);

  // A new act is a new subject: the guide starts the conversation over.
  useEffect(() => {
    setAskLog([]);
    setAskOpen(false);
  }, [act?.id]);

  /**
   * One question to the guide. The last run of this act goes with it, so
   * "why did that happen?" can be answered from what actually happened.
   */
  const askGuide = useCallback(
    async (question: string) => {
      if (!world || !act || !guideId) return;
      const history = askLog
        .filter((entry) => !entry.failed)
        .slice(-6)
        .map(({ who, text }) => ({ who, text }));
      const ran = outputs ?? simOutcome?.outputs;
      setAskLog((log) => [...log, { who: 'player', text: question }]);
      setAskBusy(true);
      try {
        const turn = await api.npcTurn({
          worldId: world.id,
          actId: act.id,
          characterId: guideId,
          playerSays: question,
          history,
          ...(verdict !== null && ran
            ? { attempt: { won: verdict, settings: dials, outputs: ran } }
            : {}),
          solved: solved.includes(act.id),
        });
        setAskLog((log) => [
          ...log,
          { who: 'guide', text: turn.reply, ...(turn.offline ? { offline: true } : {}) },
        ]);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        setAskLog((log) => [
          ...log,
          { who: 'guide', text: `Could not reach the guide: ${why.slice(0, 140)}`, failed: true },
        ]);
      } finally {
        setAskBusy(false);
      }
    },
    [world, act, guideId, askLog, outputs, simOutcome, verdict, dials, solved],
  );

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
      // A sequence act is played at its board, and any prop in the room is it.
      if (sequence) {
        sfx.open();
        setSeqOpen(true);
        return;
      }
      if (board) {
        sfx.open();
        setEvOpen(true);
        return;
      }
      if (fixtureRag || id === 'satchel') {
        setRagOpen(true);
        return;
      }
      console.info('[game] nothing wired to', id);
    });
  }, [act, stage, line, reading, sequence, board, fixtureRag]);

  const runRag = useCallback(async () => {
    if (!world || !act) return;
    setRagBusy(true);
    try {
      const result = await api.runRag({
        worldId: world.id,
        actId: act.id,
        question: fixtureRag?.question ?? 'What dose did the Archivist record, and when?',
        params: ragParams,
      });
      setRagResult(result);
      // A live run is won when it shows the act's lesson, measured on the real
      // retrieval (rag.ts). From the canned table, only a row it actually has
      // for these settings counts: the catch-all `default` answers correctly
      // whatever was chosen, so it proves nothing.
      const won = result.live
        ? result.lesson?.passed === true
        : result.judge.correct && !!result.fixtureKey && result.fixtureKey !== 'default';
      if (fixtureRag && won) markSolved(act.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRagBusy(false);
    }
  }, [world, act, ragParams, fixtureRag, markSolved]);

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
    return <UploadPage busy={busy} error={error} onSubmit={handleSubmit} onOpen={handleOpen} />;
  }

  if (phase === 'forming') {
    return (
      <main style={styles.forming}>
        <DioramaSlot
          dioramaUrl={world?.dioramaUrl}
          {...(world?.styleUrl ? { imageUrl: world.styleUrl } : {})}
        />
        <h1 style={styles.formingTitle}>The world is forming…</h1>
        <BuildStages events={events} />
        <p style={styles.hint}>press T for the agent trace</p>
        <AgentTracePanel events={events} open={traceOpen} onClose={() => setTraceOpen(false)} />
        <div style={styles.formingActions}>
          <button
            type="button"
            disabled={!world}
            onClick={() => setPhase('title')}
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

  if (phase === 'title') {
    return (
      <TitleCard
        world={world}
        onStart={() => {
          sfx.chapter();
          setPhase('playing');
        }}
      />
    );
  }

  const lastAct = world ? actIndex >= world.acts.length - 1 : true;
  const nextAct = world?.acts[actIndex + 1];
  const driven =
    stage?.bindings.some((b) => b.kind === 'control' || (b.kind === 'needle' && b.live)) ?? false;
  const levers = (stage?.bindings ?? []).flatMap((b) =>
    b.kind === 'needle' && b.live ? [b.param] : [],
  );
  const readout = stage?.readout;
  // A live act reports its own outputs through `played`; a replayed one was
  // simulated here and never did. Both are the same run to the player, so the
  // readout and the result card take whichever one actually has the numbers.
  const runOutputs = outputs ?? simOutcome?.outputs ?? null;
  const measured =
    readout && runOutputs && Number.isFinite(runOutputs[readout.output])
      ? `${readout.label} ${Math.round(runOutputs[readout.output]! * 10) / 10}${readout.unit ?? ''}`
      : null;

  // The verdict as a medal, or as a distance. "Not yet." is a shrug; "over by
  // 4 m" is something to do differently.
  const judged = readout && runOutputs ? runOutputs[readout.output] : undefined;
  const grade =
    medalBand && verdict !== null && judged !== undefined && Number.isFinite(judged)
      ? gradeRun(judged, medalBand)
      : null;
  const medal = verdict && grade?.medal ? grade.medal : null;
  const unit = readout?.unit ?? '';
  const headline = medal
    ? `${medal[0]!.toUpperCase()}${medal.slice(1)}.`
    : verdict
      ? 'It lands.'
      : grade && grade.miss !== 0
        ? `${grade.miss > 0 ? 'Over' : 'Under'} by ${round1(Math.abs(grade.miss))}${unit}.`
        : 'Not yet.';
  // One-click questions, chosen from where the player is: before a run they
  // need the task, after a miss they need the why, after a win the rule.
  const firstDial = formula?.params[0]?.name;
  const suggestions =
    verdict === false
      ? ['Why did that happen?', 'Should I go more or less?', 'Give me a hint']
      : verdict === true
        ? ['Why did that work?', 'What is the rule here?']
        : [
            'What am I supposed to do here?',
            ...(firstDial ? [`What does the ${humaniseName(firstDial)} do?`] : []),
            'Explain the idea simply',
          ];

  const latest = misses.at(-1);
  const previous = misses.at(-2);
  const gained = latest !== undefined && previous !== undefined ? previous - latest : null;
  const compare =
    gained === null || Math.abs(gained) < 0.05
      ? null
      : `${round1(Math.abs(gained))}${unit} ${gained > 0 ? 'closer' : 'further'} than last time`;

  // Commit to a guess before the act, once the cast has said its piece. Not
  // scored and it gates nothing: it is what the result gets compared against.
  const predicting =
    !!act?.prediction &&
    scene !== null &&
    !(act.id in guesses) &&
    !solved.includes(act.id) &&
    speaking === undefined &&
    !(ragOpen || simOpen || seqOpen || evOpen || askOpen || proofOpen || endingOpen);
  const insight =
    act &&
    solved.includes(act.id) &&
    !insightClosed.includes(act.id) &&
    (act.prediction || act.analogy)
      ? act
      : null;
  // Only worked out when asked for: a formula act's odds come from simulating it.
  const proof = proofOpen && act ? proofOf(act) : null;

  return (
    <div style={styles.stage}>
      {scene ? (
        <PhaserGame
          key={`${act?.id ?? 'none'}-${sceneKey}`}
          scene={scene}
          cast={world?.cast}
          stage={stage}
          {...(formula ? { params: formula.params, spec: formula.spec } : {})}
          target={target}
          paused={
            ragOpen ||
            simOpen ||
            seqOpen ||
            evOpen ||
            askOpen ||
            proofOpen ||
            predicting ||
            speaking !== undefined
          }
          {...(guideId ? { guide: guideId } : {})}
          {...(world?.playerSheet ? { playerSheet: world.playerSheet } : {})}
          typing={askOpen}
          {...(act
            ? {
                gate: {
                  open: solved.includes(act.id),
                  leadsTo: nextAct ? `Act ${actIndex + 2}: ${nextAct.title}` : 'the way out',
                  last: lastAct,
                },
              }
            : {})}
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

      {world?.omitted?.length && !omissionSeen ? (
        <div style={{ ...styles.substituted, borderColor: colors.gold }}>
          <strong style={{ color: colors.gold, whiteSpace: 'nowrap' }}>
            {world.omitted.length} act{world.omitted.length > 1 ? 's' : ''} left out.
          </strong>
          <span style={styles.verdictText}>
            {world.omitted.map((o) => `“${o.title}”: ${o.reason}.`).join(' ')}
          </span>
          <button type="button" onClick={() => setOmissionSeen(true)} style={styles.verdictButton}>
            got it
          </button>
        </div>
      ) : null}

      <header style={styles.hud}>
        <div style={styles.hudColumn}>
          <div style={styles.hudText}>
            <div style={styles.actTitle}>
              {act?.title}
              {act?.mechanic ? (
                <button
                  type="button"
                  onClick={() => setProofOpen(true)}
                  style={styles.verified}
                  title="What was checked before you were allowed to play this act"
                >
                  ✓ verified
                </button>
              ) : null}
            </div>
            <div style={styles.actGoal}>{act?.goal}</div>
            {act?.steps?.length ? (
              <ol style={styles.actSteps}>
                {act.steps.map((step) => (
                  <li key={step} style={styles.actStep}>
                    {step}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
          {verdict !== null && act ? (
            <div
              style={{
                ...styles.verdict,
                borderColor: verdict ? colors.success : colors.fail,
              }}
            >
              <strong
                style={{
                  color: medal ? MEDAL_COLOR[medal] : verdict ? colors.success : colors.fail,
                  fontFamily: fonts.header,
                  whiteSpace: 'nowrap',
                }}
              >
                {headline}
              </strong>
              {measured ? <span style={styles.measured}>{measured}</span> : null}
              {compare ? (
                <span
                  style={{ ...styles.compare, color: gained! > 0 ? colors.success : colors.fail }}
                >
                  {compare}
                </span>
              ) : null}
              <span style={styles.verdictText}>
                {verdict
                  ? (act.beat?.won ?? act.explainAfter)
                  : (act.beat?.lost ??
                    (driven
                      ? 'F to go again from the same start — R mid-run starts over.'
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
              {verdict && scene?.exits.length ? (
                <span style={styles.gateHint}>
                  {lastAct ? '→ the way out is open' : '→ the gate is open — walk through it'}
                </span>
              ) : verdict && !lastAct ? (
                // Only a room with no exit at all still needs a button to leave by.
                <button
                  type="button"
                  onClick={() => {
                    sfx.chapter();
                    setReached((r) => Math.max(r, actIndex + 2));
                    setActIndex((i) => i + 1);
                  }}
                  style={{ ...styles.verdictButton, borderColor: colors.gold, color: colors.gold }}
                >
                  next act ▸
                </button>
              ) : null}
            </div>
          ) : null}
          {verdict === null && !formula && act && solved.includes(act.id) ? (
            <div style={{ ...styles.verdict, borderColor: colors.success }}>
              <strong style={{ color: colors.success, fontFamily: fonts.header }}>Solved.</strong>
              {scene?.exits.length ? (
                <span style={styles.gateHint}>
                  {lastAct ? '→ the way out is open' : '→ the gate is open — walk through it'}
                </span>
              ) : !lastAct ? (
                <button
                  type="button"
                  onClick={() => {
                    sfx.chapter();
                    setReached((r) => Math.max(r, actIndex + 2));
                    setActIndex((i) => i + 1);
                  }}
                  style={{ ...styles.verdictButton, borderColor: colors.gold, color: colors.gold }}
                >
                  next act ▸
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div style={styles.actChips}>
          {world?.acts.map((a, i) => {
            const open = i < reached;
            return (
              <button
                key={a.id}
                type="button"
                disabled={!open}
                title={open ? a.title : 'reached through the gate before it'}
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
                {medals[a.id] ? (
                  <span style={{ color: MEDAL_COLOR[medals[a.id]!], textShadow: '0 0 2px #000' }}>
                    {' ★'}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </header>

      <div style={styles.keyHint}>
        {stage
          ? 'WASD move · E act · F run · R reset · M sound · T trace'
          : 'WASD move · E interact · M sound · T trace'}
        {guide ? (
          <button type="button" onClick={() => setAskOpen(true)} style={styles.ask}>
            Q ask {guide.name}
          </button>
        ) : null}
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

      <div style={styles.rail}>
        {insight ? (
          <InsightCard
            {...(insight.prediction ? { prediction: insight.prediction } : {})}
            guessed={guesses[insight.id] ?? null}
            {...(insight.analogy ? { analogy: insight.analogy } : {})}
            onClose={() => setInsightClosed((done) => [...done, insight.id])}
          />
        ) : null}
        {traceOpen ? (
          <AgentTracePanel events={events} open onClose={() => setTraceOpen(false)} />
        ) : null}
        {verdict !== null && formula && runOutputs ? (
          <ResultCard
            params={formula.params}
            dials={dials}
            outputs={runOutputs}
            {...(readout ? { readout } : {})}
            {...(levers.length > 0 ? { live: levers } : {})}
            won={verdict}
          />
        ) : null}
      </div>

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

      {endingOpen && world ? (
        <div style={styles.overlay}>
          <section style={styles.ending}>
            <h2 style={styles.endingTitle}>{world.title}</h2>
            <p style={styles.endingTwist}>
              {world.twist ?? `Every act of ${world.title} is done.`}
            </p>
            {world.villain ? <p style={styles.endingVillain}>— {world.villain}</p> : null}
            {/* What the player is taking away, act by act. */}
            <ul style={styles.endingActs}>
              {world.acts.map((a) => {
                const medal = medals[a.id];
                return (
                  <li key={a.id} style={styles.endingAct}>
                    <span>{a.title}</span>
                    <span style={{ color: medal ? MEDAL_COLOR[medal] : `${colors.parchment}66` }}>
                      {medal ?? (solved.includes(a.id) ? 'done' : '—')}
                    </span>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              onClick={() => {
                setEndingOpen(false);
                // The room went dark on the way through the gate; bring it back
                // up rather than leave the player standing in the black.
                setSceneKey((k) => k + 1);
              }}
              style={styles.enter}
            >
              Close the file
            </button>
          </section>
        </div>
      ) : null}

      {seqOpen && sequence && seq && act ? (
        <div style={styles.overlay}>
          <SequencePanel
            title={act.title}
            mechanic={sequence}
            state={seq}
            explainAfter={act.explainAfter}
            {...(act.beat ? { beat: act.beat } : {})}
            onAction={actOnSequence}
            onClose={() => {
              sfx.close();
              setSeqOpen(false);
            }}
          />
        </div>
      ) : null}

      {evOpen && board && ev && act ? (
        <div style={styles.overlay}>
          <EvidencePanel
            title={act.title}
            mechanic={board}
            state={ev}
            explainAfter={act.explainAfter}
            {...(act.beat ? { beat: act.beat } : {})}
            onAction={actOnEvidence}
            onClose={() => {
              sfx.close();
              setEvOpen(false);
            }}
          />
        </div>
      ) : null}

      {ragOpen ? (
        <div style={styles.overlay}>
          <RagPanel
            question={fixtureRag?.question ?? 'What dose did the Archivist record, and when?'}
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

      {askOpen && guide ? (
        <div style={styles.dialogSlot}>
          <AskPanel
            guide={guide}
            log={askLog}
            busy={askBusy}
            suggestions={suggestions}
            onAsk={(question) => void askGuide(question)}
            onClose={() => setAskOpen(false)}
          />
        </div>
      ) : null}

      {predicting && act?.prediction ? (
        <div style={styles.dialogSlot}>
          <PredictionCard
            prediction={act.prediction}
            onChoose={(i) => {
              sfx.act();
              setGuesses((g) => ({ ...g, [act.id]: i }));
            }}
            onSkip={() => setGuesses((g) => ({ ...g, [act.id]: null }))}
          />
        </div>
      ) : null}

      {proof && act ? (
        <div style={styles.overlay}>
          <ProofPanel title={act.title} proof={proof} onClose={() => setProofOpen(false)} />
        </div>
      ) : null}

      {speaking && !askOpen ? (
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

      {adaptMove && world ? (
        <AdaptCard
          move={adaptMove}
          cast={world.cast}
          docked={seqOpen || evOpen || simOpen || ragOpen}
          onClose={() => setAdaptMove(null)}
        />
      ) : null}

      <div style={styles.mode}>API: {API_MODE}</div>
    </div>
  );
}

const MEDAL_RANK: Record<Medal, number> = { bronze: 1, silver: 2, gold: 3 };
const MEDAL_COLOR: Record<Medal, string> = {
  gold: colors.gold,
  silver: '#c9cfd6',
  bronze: '#c07a45',
};

const round1 = (n: number): string => `${Math.round(n * 10) / 10}`;

/** "winchPullKn" → "winch pull kn", the way the dials are labelled in the scene. */
const humaniseName = (name: string): string =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();

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
  // The act card's one control: what was proved before you were let in.
  verified: {
    pointerEvents: 'auto',
    marginLeft: space.sm,
    padding: `0 ${space.xs + 2}px`,
    verticalAlign: 'middle',
    borderRadius: radii.chip,
    border: `1px solid ${colors.success}`,
    background: `${colors.success}33`,
    color: '#9fdc8a',
    fontFamily: fonts.body,
    fontSize: 11.5,
    letterSpacing: 0.4,
  },
  actGoal: { fontSize: 13, lineHeight: 1.45, color: `${colors.parchment}cc` },
  // The one piece of text whose job is to be obeyed rather than read, so it
  // gets the gold and a number per line instead of being another paragraph.
  actSteps: {
    margin: `${space.sm}px 0 0`,
    padding: `${space.xs}px 0 0 ${space.md}px`,
    borderTop: `1px solid ${colors.gold}33`,
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  actStep: { fontSize: 12.5, lineHeight: 1.4, color: `${colors.gold}dd` },
  actChips: { display: 'flex', gap: space.xs, pointerEvents: 'auto' },
  actChip: {
    padding: `2px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}66`,
  },
  // Stacked under the act card rather than pinned at a fixed height: the card
  // grows with its steps, and a pinned verdict sat on top of them.
  hudColumn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.sm,
    maxWidth: 'min(592px, calc(100vw - 420px))',
  },
  verdict: {
    pointerEvents: 'auto',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space.sm,
    rowGap: space.xs,
    width: '100%',
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: '1px solid',
    background: '#0b0806f2',
  },
  // Its own line under the verdict, three lines at most: the full explanation
  // is one click away behind "show me why", and a verdict that runs down the
  // screen buries the room it is about.
  verdictText: {
    order: 10,
    flexBasis: '100%',
    fontSize: 13,
    lineHeight: 1.45,
    color: `${colors.parchment}cc`,
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
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
  compare: { flexShrink: 0, fontSize: 12.5, whiteSpace: 'nowrap' },
  // The one hint-bar control that opens a person, so it reads as a button.
  ask: {
    marginLeft: space.sm,
    padding: `1px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}88`,
    background: '#0b0806cc',
    color: colors.gold,
    fontSize: 11.5,
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
  endingActs: {
    listStyle: 'none',
    margin: 0,
    padding: `${space.sm}px 0 0`,
    alignSelf: 'stretch',
    display: 'grid',
    gap: space.xs,
    borderTop: `1px solid ${colors.gold}33`,
  },
  endingAct: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: space.md,
    fontSize: 14,
    color: `${colors.parchment}cc`,
  },
  gateHint: { flexShrink: 0, fontSize: 12.5, color: colors.gold, whiteSpace: 'nowrap' },
  endingVillain: {
    margin: 0,
    fontFamily: fonts.header,
    fontSize: 14,
    color: `${colors.parchment}88`,
  },
  // Trace and result share one column so neither has to know the other is
  // there — the trace is tall and variable, the card hangs below whatever it is.
  rail: {
    position: 'absolute',
    top: 72,
    right: space.md,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: space.md,
  },
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
