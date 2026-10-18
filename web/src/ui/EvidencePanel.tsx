import { useState } from 'react';
import type { EvidenceAction, EvidenceMechanic, EvidenceState } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  title: string;
  mechanic: EvidenceMechanic;
  state: EvidenceState;
  explainAfter: string;
  beat?: { won: string; lost: string };
  onAction: (action: EvidenceAction) => void;
  onClose: () => void;
}

/**
 * The evidence board: documents on the left, claims on the right. Pick a
 * document up — click it, or drag it — and put it down on the claim it
 * proves. Props in, actions out; the verdict comes from shared/evidence.ts.
 *
 * A failed check explains one wrong pin by what that document *does* show,
 * never by naming the claim it belongs to. An empty claim is named, because
 * the player can see that for themselves anyway.
 */
export function EvidencePanel({
  title,
  mechanic,
  state,
  explainAfter,
  beat,
  onAction,
  onClose,
}: Props) {
  const [held, setHeld] = useState<string | null>(null);
  const doc = new Map(mechanic.evidence.map((e) => [e.id, e]));
  const claim = new Map(mechanic.claims.map((c) => [c.id, c]));
  const last = state.last;
  const firstWrong = last && !last.won ? last.wrong[0] : undefined;
  const firstEmpty = last && !last.won && !firstWrong ? last.empty[0] : undefined;

  const drop = (claimId: string) => {
    if (!held) return;
    onAction({ kind: 'pin', evidence: held, claim: claimId });
    setHeld(null);
  };

  return (
    <section style={styles.panel} aria-label={`${title}: connect evidence to claims`}>
      <header style={styles.header}>
        <h2 style={styles.title}>{title}</h2>
        <button type="button" onClick={onClose} style={styles.close}>
          Esc ✕
        </button>
      </header>
      <p style={styles.prompt}>{mechanic.prompt}</p>

      <div style={styles.columns}>
        <div style={styles.column}>
          <h3 style={styles.h3}>Documents</h3>
          {mechanic.evidence.map((item) => {
            const pinned = state.pins[item.id];
            const holding = held === item.id;
            const flagged = firstWrong?.evidence === item.id;
            return (
              <div
                key={item.id}
                draggable
                onDragStart={() => setHeld(item.id)}
                style={{
                  ...styles.doc,
                  borderColor: flagged ? colors.fail : holding ? colors.gold : `${colors.gold}44`,
                  background: flagged
                    ? `${colors.fail}26`
                    : holding
                      ? `${colors.gold}22`
                      : '#1f140dcc',
                  opacity: pinned && !holding ? 0.55 : 1,
                }}
              >
                <button
                  type="button"
                  onClick={() => setHeld(holding ? null : item.id)}
                  aria-pressed={holding}
                  style={styles.docButton}
                >
                  <span style={styles.docTitle}>{item.title}</span>
                  <span style={styles.excerpt}>“{item.excerpt}”</span>
                </button>
                {pinned ? (
                  <span style={styles.pinnedTo}>
                    pinned to: {claim.get(pinned)?.text.slice(0, 48)}…
                    <button
                      type="button"
                      onClick={() => onAction({ kind: 'unpin', evidence: item.id })}
                      aria-label={`take ${item.title} back`}
                      style={styles.unpin}
                    >
                      ✕
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>

        <div style={styles.column}>
          <h3 style={styles.h3}>Claims {held ? '— click one to pin the document' : ''}</h3>
          {mechanic.claims.map((c) => {
            const on = mechanic.evidence.filter((e) => state.pins[e.id] === c.id);
            const flagged = firstWrong?.claim === c.id || firstEmpty === c.id;
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => drop(c.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && drop(c.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(c.id);
                }}
                aria-label={`claim: ${c.text}`}
                style={{
                  ...styles.claim,
                  borderColor: flagged ? colors.fail : held ? colors.gold : `${colors.parchment}33`,
                  cursor: held ? 'copy' : 'default',
                }}
              >
                <span style={styles.claimText}>{c.text}</span>
                {on.length ? (
                  <ul style={styles.pins}>
                    {on.map((e) => (
                      <li key={e.id} style={styles.pin}>
                        📎 {e.title}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span style={styles.empty}>nothing pinned</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div style={styles.actions}>
        <button type="button" onClick={() => onAction({ kind: 'check' })} style={styles.check}>
          Check the board
        </button>
        <button
          type="button"
          onClick={() => {
            setHeld(null);
            onAction({ kind: 'reset' });
          }}
          style={styles.reset}
        >
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
                Every claim stands on its evidence.
              </strong>
              {beat?.won ? <p style={styles.text}>{beat.won}</p> : null}
              <ul style={styles.whys}>
                {mechanic.links
                  .filter((l) => state.pins[l.evidence] === l.claim)
                  .map((l) => (
                    <li key={`${l.claim}-${l.evidence}`} style={styles.text}>
                      <em>{doc.get(l.evidence)?.title}</em>: {l.why}
                    </li>
                  ))}
              </ul>
              <p style={styles.textDim}>{explainAfter}</p>
            </>
          ) : (
            <>
              <strong style={{ ...styles.headline, color: colors.fail }}>
                {last.backed} of {last.total} claims are backed.
              </strong>
              {firstWrong ? (
                <p style={styles.text}>
                  <em>“{doc.get(firstWrong.evidence)?.title}”</em> does not prove “
                  {claim.get(firstWrong.claim)?.text.replace(/[.!?]+$/, '')}”. What it shows:{' '}
                  {doc.get(firstWrong.evidence)?.shows}
                </p>
              ) : firstEmpty ? (
                <p style={styles.text}>
                  “{claim.get(firstEmpty)?.text}” has nothing pinned to it yet.
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
    width: 'min(900px, 94vw)',
    maxHeight: '90vh',
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
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: space.md,
  },
  column: { display: 'flex', flexDirection: 'column', gap: space.xs },
  h3: {
    margin: 0,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: `${colors.parchment}88`,
  },
  doc: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: '1px solid',
    cursor: 'grab',
  },
  docButton: {
    all: 'unset',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    cursor: 'pointer',
  },
  docTitle: { fontSize: 14, color: colors.gold },
  excerpt: {
    fontSize: 12.5,
    lineHeight: 1.45,
    fontStyle: 'italic',
    color: `${colors.parchment}cc`,
  },
  pinnedTo: {
    display: 'flex',
    alignItems: 'center',
    gap: space.xs,
    fontSize: 11.5,
    color: `${colors.parchment}88`,
  },
  unpin: {
    padding: '0 6px',
    fontSize: 10,
    borderRadius: 4,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: `${colors.parchment}aa`,
  },
  claim: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.xs,
    minHeight: 64,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: '1px dashed',
    background: '#1f140d99',
  },
  claimText: { fontSize: 14, lineHeight: 1.45, color: colors.parchment },
  pins: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 },
  pin: { fontSize: 12.5, color: colors.gold },
  empty: { fontSize: 12, color: `${colors.parchment}55` },
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
  whys: { margin: 0, paddingLeft: space.md, display: 'grid', gap: 2 },
  text: { margin: 0, fontSize: 13.5, lineHeight: 1.5, color: `${colors.parchment}dd` },
  textDim: { margin: 0, fontSize: 13, lineHeight: 1.5, color: `${colors.parchment}99` },
};
