import type { AgentEvent } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

/**
 * The build, as a plan rather than a log.
 *
 * The trace is still the truth and it is one keypress away, but forty lines
 * streaming past is a thing to read, not a thing to watch — and the one
 * question a person has while waiting ("how far along is this?") was the one
 * thing the log could not answer.
 *
 * These are the stages `server/src/pipeline/design.ts` actually runs, in the
 * order it runs them, each lit by the events its own agents emit. Nothing here
 * is a timer pretending to be progress: a stage with no events has genuinely
 * not started, and one that never reports while a later stage runs says
 * "skipped" rather than quietly ticking itself off.
 */
interface StageDef {
  id: string;
  label: string;
  /** Agent names, as the pipeline emits them. Mock traces use older names. */
  agents: readonly string[];
}

const STAGES: readonly StageDef[] = [
  { id: 'read', label: 'Reading your material', agents: ['Orchestrator'] },
  { id: 'concepts', label: 'Extracting the concepts', agents: ['Curriculum agent'] },
  {
    id: 'world',
    label: 'Designing the world',
    agents: ["Writers' room", 'Draft judge', 'Story agent', 'Cast agent'],
  },
  {
    id: 'missions',
    label: 'Writing the missions',
    agents: ['Act writer', 'Mechanic agent', 'Mapper'],
  },
  { id: 'rules', label: 'Checking every rule', agents: ['Validator'] },
  { id: 'art', label: 'Painting the cast', agents: ['Art director'] },
];

const stageOf = new Map<string, number>();
STAGES.forEach((stage, i) => stage.agents.forEach((agent) => stageOf.set(agent, i)));

type Status = 'waiting' | 'running' | 'done' | 'warn' | 'skipped';

interface Row {
  status: Status;
  message: string;
}

const MARK: Record<Status, string> = {
  waiting: '·',
  running: '▸',
  done: '✓',
  warn: '!',
  skipped: '–',
};

const MARK_COLOR: Record<Status, string> = {
  waiting: `${colors.parchment}44`,
  running: colors.gold,
  done: colors.success,
  warn: colors.gold,
  skipped: `${colors.parchment}44`,
};

/**
 * Fold the stream into one row per stage.
 *
 * The Orchestrator bookends the whole run — its `start` opens the first stage
 * and its `done` closes the last — so its finishing line is read as the end of
 * the build rather than as another message about reading the chapter.
 */
export function foldStages(events: AgentEvent[]): { rows: Row[]; finished: boolean } {
  const seen = STAGES.map(() => ({ last: null as AgentEvent['kind'] | null, message: '' }));
  let furthest = -1;
  let finished = false;

  for (const event of events) {
    if (event.agent === 'Orchestrator' && event.kind === 'done') {
      finished = true;
      continue;
    }
    const index = stageOf.get(event.agent);
    if (index === undefined) continue;
    const row = seen[index];
    if (!row) continue;
    row.last = event.kind;
    row.message = event.message;
    furthest = Math.max(furthest, index);
  }

  // The *last* thing a stage said, not the worst thing: a validator that
  // rejected an act and then passed the repair is a stage that succeeded, and
  // an art director whose closing word was `fallback` is one that did not —
  // whatever the orchestrator says about the run as a whole afterwards.
  const rows = seen.map(({ last, message }, i): Row => {
    if (last === null) return { status: i < furthest ? 'skipped' : 'waiting', message: '' };
    if (last === 'done') return { status: 'done', message };
    if (last === 'rejected' || last === 'repair' || last === 'fallback') {
      return { status: 'warn', message };
    }
    return { status: finished || i < furthest ? 'done' : 'running', message };
  });

  return { rows, finished };
}

interface Props {
  events: AgentEvent[];
}

export function BuildStages({ events }: Props) {
  const { rows } = foldStages(events);

  return (
    <ol style={styles.list}>
      {STAGES.map((stage, i) => {
        const row = rows[i] ?? { status: 'waiting' as Status, message: '' };
        const live = row.status === 'running';
        return (
          <li key={stage.id} style={styles.row}>
            <span
              style={{
                ...styles.mark,
                color: MARK_COLOR[row.status],
                ...(live ? { animation: 'cq-pulse 1.4s ease-in-out infinite' } : {}),
              }}
              aria-hidden="true"
            >
              {MARK[row.status]}
            </span>
            <div style={styles.body}>
              <div
                style={{
                  ...styles.label,
                  color:
                    row.status === 'waiting' || row.status === 'skipped'
                      ? `${colors.parchment}55`
                      : live
                        ? colors.gold
                        : `${colors.parchment}ee`,
                }}
              >
                {stage.label}
                {row.status === 'skipped' ? <span style={styles.aside}> skipped</span> : null}
              </div>
              {/* The agent's own words, not a caption written for it. */}
              {row.message ? <div style={styles.message}>{row.message}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: {
    position: 'relative',
    zIndex: 1,
    listStyle: 'none',
    width: 'min(560px, 92vw)',
    margin: 0,
    padding: space.md,
    display: 'grid',
    gap: space.sm,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}33`,
    background: '#0b0806cc',
    backdropFilter: 'blur(2px)',
  },
  row: { display: 'grid', gridTemplateColumns: '20px 1fr', gap: space.sm, alignItems: 'start' },
  mark: { fontFamily: fonts.header, fontSize: 15, lineHeight: '20px', textAlign: 'center' },
  body: { minWidth: 0 },
  label: { fontFamily: fonts.header, fontSize: 15, lineHeight: '20px' },
  aside: { fontFamily: fonts.body, fontSize: 12, color: `${colors.parchment}44` },
  message: {
    marginTop: 1,
    fontSize: 12.5,
    lineHeight: 1.45,
    color: `${colors.parchment}99`,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
};
