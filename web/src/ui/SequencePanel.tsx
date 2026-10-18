import { useState } from 'react';
import type { SequenceAction, SequenceMechanic, SequenceState } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  title: string;
  mechanic: SequenceMechanic;
  state: SequenceState;
  /** Shown once the order holds: the act's own explanation. */
  explainAfter: string;
  /** The cast's reactions, when the act has them. */
  beat?: { won: string; lost: string };
  onAction: (action: SequenceAction) => void;
  onClose: () => void;
}

/**
 * The board a sequence act is played on. Props in, actions out: the order,
 * the verdict and the latch all live in shared/sequence.ts, so what is judged
 * here is exactly what the validator proved finishable.
 *
 * A failed check names one broken link — the earliest — by lighting its two
 * cards and giving the reason, not the direction. Which way round they go is
 * still the player's to work out from why, which is the concept.
 */
export function SequencePanel({
  title,
  mechanic,
  state,
  explainAfter,
  beat,
  onAction,
  onClose,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const byId = new Map(mechanic.items.map((item) => [item.id, item]));
  const last = state.last;
  const flagged = last && !last.won ? last.broken[0] : undefined;
  const lit = new Set(flagged ? [flagged.before, flagged.after] : []);

  return (
    <section style={styles.panel} aria-label={`${title}: arrange the cards`}>
      <header style={styles.header}>
        <h2 style={styles.title}>{title}</h2>
        <button type="button" onClick={onClose} style={styles.close}>
          Esc ✕
        </button>
      </header>

      <p style={styles.prompt}>{mechanic.prompt}</p>

      <ol style={styles.cards}>
        {state.order.map((id, index) => {
          const item = byId.get(id);
          if (!item) return null;
          const hot = lit.has(id);
          return (
            <li
              key={id}
              draggable
              onDragStart={() => setDragging(id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) onAction({ kind: 'move', id: dragging, to: index });
                setDragging(null);
              }}
              style={{
                ...styles.card,
                // Tinted as well as outlined: a red edge alone reads as brown
                // beside the muted gold of the others.
                borderColor: hot ? colors.fail : `${colors.gold}55`,
                background: hot ? `${colors.fail}26` : '#1f140dcc',
                opacity: dragging === id ? 0.4 : 1,
              }}
            >
              <span style={styles.position}>{index + 1}</span>
              <span style={styles.cardText}>
                <span style={styles.label}>{item.label}</span>
                {item.detail ? <span style={styles.detail}>{item.detail}</span> : null}
              </span>
              <span style={styles.arrows}>
                <button
                  type="button"
                  aria-label={`move ${item.label} up`}
                  disabled={index === 0}
                  onClick={() => onAction({ kind: 'move', id, to: index - 1 })}
                  style={styles.arrow}
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label={`move ${item.label} down`}
                  disabled={index === state.order.length - 1}
                  onClick={() => onAction({ kind: 'move', id, to: index + 1 })}
                  style={styles.arrow}
                >
                  ▼
                </button>
              </span>
            </li>
          );
        })}
      </ol>

      <div style={styles.actions}>
        <button type="button" onClick={() => onAction({ kind: 'check' })} style={styles.check}>
          Check the order
        </button>
        <button type="button" onClick={() => onAction({ kind: 'reset' })} style={styles.reset}>
          Reset
        </button>
        <span style={styles.meta}>
          {state.checks === 0 ? 'not checked yet' : `checked ${state.checks}×`}
          {state.solved ? ' · solved' : ''}
        </span>
      </div>

      {last ? (
        <div
          role="status"
          style={{ ...styles.verdict, borderColor: last.won ? colors.success : colors.fail }}
        >
          {last.won ? (
            <>
              <strong style={{ ...styles.headline, color: colors.success }}>
                The order holds.
              </strong>
              {beat?.won ? <p style={styles.text}>{beat.won}</p> : null}
              <p style={styles.text}>{explainAfter}</p>
            </>
          ) : last.invalid ? (
            <strong style={{ ...styles.headline, color: colors.fail }}>{last.invalid}</strong>
          ) : (
            <>
              <strong style={{ ...styles.headline, color: colors.fail }}>
                {last.kept} of {last.total} links hold.
              </strong>
              {flagged ? (
                <p style={styles.text}>
                  Look again at <em>“{byId.get(flagged.before)?.label}”</em> and{' '}
                  <em>“{byId.get(flagged.after)?.label}”</em>: {flagged.why}
                </p>
              ) : null}
              {beat?.lost ? <p style={styles.textDim}>{beat.lost}</p> : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 'min(640px, 94vw)',
    maxHeight: '88vh',
    overflowY: 'auto',
    padding: space.lg,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}66`,
    background: '#0b0806f2',
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
  },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { margin: 0, fontFamily: fonts.header, fontSize: 24, color: colors.gold },
  close: {
    border: `1px solid ${colors.parchment}33`,
    borderRadius: radii.chip,
    background: 'transparent',
    color: `${colors.parchment}aa`,
    padding: `2px ${space.sm}px`,
  },
  prompt: { margin: 0, fontSize: 14, lineHeight: 1.5, color: `${colors.parchment}dd` },
  cards: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.xs },
  card: {
    display: 'grid',
    gridTemplateColumns: '28px 1fr auto',
    alignItems: 'center',
    gap: space.sm,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: '1px solid',
    background: '#1f140dcc',
    cursor: 'grab',
  },
  position: { fontFamily: fonts.header, fontSize: 18, color: colors.gold, textAlign: 'center' },
  cardText: { display: 'flex', flexDirection: 'column', gap: 2 },
  label: { fontSize: 14.5, color: colors.parchment },
  detail: { fontSize: 12.5, lineHeight: 1.4, color: `${colors.parchment}99` },
  arrows: { display: 'flex', flexDirection: 'column', gap: 2 },
  arrow: {
    padding: '0 6px',
    fontSize: 10,
    lineHeight: '16px',
    borderRadius: 4,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: `${colors.parchment}aa`,
  },
  actions: { display: 'flex', alignItems: 'center', gap: space.sm },
  check: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: 'none',
    background: colors.gold,
    color: colors.ground,
    fontWeight: 700,
  },
  reset: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}44`,
    background: 'transparent',
    color: `${colors.parchment}aa`,
  },
  meta: { fontSize: 12, color: `${colors.parchment}77` },
  verdict: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: '1px solid',
  },
  headline: { fontFamily: fonts.header, fontSize: 16 },
  text: { margin: 0, fontSize: 13.5, lineHeight: 1.5, color: `${colors.parchment}dd` },
  textDim: { margin: 0, fontSize: 13, lineHeight: 1.5, color: `${colors.parchment}99` },
};
