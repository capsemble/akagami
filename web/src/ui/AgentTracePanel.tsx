import type { AgentEvent } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  events: AgentEvent[];
  open: boolean;
  onClose: () => void;
}

const kindColor: Record<AgentEvent['kind'], string> = {
  start: colors.parchment,
  progress: colors.oracle,
  done: colors.success,
  rejected: colors.fail,
  repair: colors.gold,
  fallback: colors.gold,
};

/** The build story, streaming. Toggle with T. */
export function AgentTracePanel({ events, open, onClose }: Props) {
  if (!open) return null;
  return (
    <aside style={styles.panel}>
      <header style={styles.header}>
        <h2 style={styles.title}>Agent trace</h2>
        <button type="button" onClick={onClose} style={styles.close} aria-label="Close trace">
          T ✕
        </button>
      </header>
      <ol style={styles.list}>
        {events.map((event, i) => (
          <li key={`${event.ts}-${i}`} style={styles.row}>
            <span style={{ ...styles.kind, color: kindColor[event.kind] }}>{event.kind}</span>
            <div>
              <div style={styles.agentLine}>
                <span style={styles.agent}>{event.agent}</span>
                {event.model ? <span style={styles.model}>{event.model}</span> : null}
              </div>
              <div style={styles.message}>{event.message}</div>
            </div>
          </li>
        ))}
        {events.length === 0 ? <li style={styles.message}>waiting for the first agent…</li> : null}
      </ol>
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'relative',
    zIndex: 1,
    width: 'min(520px, 90vw)',
    maxHeight: '70vh',
    overflowY: 'auto',
    padding: space.md,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}55`,
    background: '#000000bb',
    backdropFilter: 'blur(2px)',
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { margin: 0, fontFamily: fonts.header, fontSize: 20, color: colors.gold },
  close: {
    border: `1px solid ${colors.parchment}33`,
    borderRadius: radii.chip,
    background: 'transparent',
    color: `${colors.parchment}aa`,
    padding: `2px ${space.sm}px`,
  },
  list: {
    listStyle: 'none',
    margin: `${space.md}px 0 0`,
    padding: 0,
    display: 'grid',
    gap: space.sm,
  },
  row: { display: 'grid', gridTemplateColumns: '84px 1fr', gap: space.sm, alignItems: 'start' },
  kind: { fontFamily: fonts.header, fontSize: 12, textTransform: 'uppercase', paddingTop: 2 },
  agentLine: { display: 'flex', alignItems: 'baseline', gap: space.xs, flexWrap: 'wrap' },
  agent: { fontSize: 13, color: colors.gold },
  model: {
    fontFamily: fonts.header,
    fontSize: 10,
    padding: `1px ${space.xs}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    color: `${colors.parchment}99`,
  },
  message: { fontSize: 14, color: `${colors.parchment}dd`, lineHeight: 1.45 },
};
