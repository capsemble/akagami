import type { Proof } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  title: string;
  proof: Proof;
  onClose: () => void;
}

/** "1 in 120", "about 1 in 8", "under 1 in 10 000": odds a person can feel. */
export function odds(rate: number): string {
  // Only a sampled formula act can come out at zero: none of its 200 tries won.
  if (rate <= 0) return 'under 1 in 200 random attempts';
  if (rate < 0.0001) return 'under 1 in 10 000 random attempts';
  const n = Math.round(1 / rate);
  return `${Number.isInteger(1 / rate) ? '' : 'about '}1 in ${n.toLocaleString()} random attempts`;
}

/**
 * What was proved about this act before you were allowed to play it.
 *
 * The checks and the odds are recomputed here from the act itself by the code
 * that judges your attempts. The citations are the act's own quotations from
 * the notes. Only the last line is a model's opinion, and it says so.
 */
export function ProofPanel({ title, proof, onClose }: Props) {
  return (
    <section style={styles.panel} aria-label={`What was verified about ${title}`}>
      <header style={styles.header}>
        <div>
          <div style={styles.kicker}>Verified before you played</div>
          <h2 style={styles.title}>{title}</h2>
        </div>
        <button type="button" onClick={onClose} style={styles.close}>
          Esc ✕
        </button>
      </header>

      <ul style={styles.checks}>
        {proof.checks.map((c) => (
          <li key={c.label} style={styles.check}>
            <span style={{ color: c.ok ? colors.success : colors.fail, fontWeight: 700 }}>
              {c.ok ? '✓' : '✗'}
            </span>
            {c.label}
          </li>
        ))}
        {proof.guessRate !== null ? (
          <li style={styles.check}>
            <span
              style={{
                color: proof.guessRate <= 0.5 ? colors.success : colors.fail,
                fontWeight: 700,
              }}
            >
              {proof.guessRate <= 0.5 ? '✓' : '✗'}
            </span>
            Guessing wins {odds(proof.guessRate)} — you have to use the idea.
          </li>
        ) : null}
      </ul>

      {proof.citations.length ? (
        <div style={styles.citations}>
          <h3 style={styles.h3}>Straight from your notes</h3>
          {proof.citations.map((c) => (
            <div key={c.claim} style={styles.citation}>
              <div style={styles.claim}>{c.claim}</div>
              {c.quotes.map((q) => (
                <blockquote key={q} style={styles.quote}>
                  {q.replace(/\s+/g, ' ').trim()}
                </blockquote>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <p style={styles.footnote}>
        {proof.judge
          ? `Every quotation above was found word for word in your notes by code. Whether each one supports its rule was read by ${proof.judge.model} (${proof.judge.verdicts} checks) — a model's reading, not a formal proof.`
          : 'The checks above are run by the game’s own simulator, not by a model.'}
      </p>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 'min(720px, 94vw)',
    maxHeight: '88vh',
    overflowY: 'auto',
    padding: space.lg,
    borderRadius: radii.panel,
    border: `1px solid ${colors.success}88`,
    background: '#0b0806f4',
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
  },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' },
  kicker: { fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.success },
  title: { margin: 0, fontFamily: fonts.header, fontSize: 24, color: colors.gold },
  close: {
    border: `1px solid ${colors.parchment}33`,
    borderRadius: radii.chip,
    background: 'transparent',
    color: `${colors.parchment}aa`,
    padding: `2px ${space.sm}px`,
  },
  checks: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.xs },
  check: {
    display: 'flex',
    gap: space.sm,
    fontSize: 14,
    lineHeight: 1.45,
    color: colors.parchment,
  },
  citations: { display: 'grid', gap: space.sm },
  h3: {
    margin: 0,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: `${colors.parchment}88`,
  },
  citation: { display: 'grid', gap: 4 },
  claim: { fontSize: 13.5, color: colors.gold },
  quote: {
    margin: 0,
    padding: `${space.xs}px ${space.sm}px`,
    borderLeft: `2px solid ${colors.gold}66`,
    fontSize: 12.5,
    lineHeight: 1.45,
    fontStyle: 'italic',
    color: `${colors.parchment}cc`,
  },
  footnote: { margin: 0, fontSize: 12, lineHeight: 1.5, color: `${colors.parchment}88` },
};
