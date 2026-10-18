import type { Analogy, Prediction } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

/**
 * Before the act: commit to a guess. It is not scored and it opens nothing —
 * it exists so the result has something to be compared against.
 */
export function PredictionCard({
  prediction,
  onChoose,
  onSkip,
}: {
  prediction: Prediction;
  onChoose: (index: number) => void;
  onSkip: () => void;
}) {
  return (
    <section style={styles.card} aria-label="Predict before you play">
      <div style={styles.kicker}>Predict first — then play it and see</div>
      <p style={styles.question}>{prediction.question}</p>
      <div style={styles.options}>
        {prediction.options.map((option, i) => (
          <button key={option} type="button" onClick={() => onChoose(i)} style={styles.option}>
            {option}
          </button>
        ))}
      </div>
      <button type="button" onClick={onSkip} style={styles.skip}>
        skip the guess
      </button>
    </section>
  );
}

/**
 * After the act is won: the guess against what the act just showed, and the
 * picture the act was built on — with the line where that picture breaks.
 */
export function InsightCard({
  prediction,
  guessed,
  analogy,
  onClose,
}: {
  prediction?: Prediction;
  /** The option the player chose, or null if they skipped. */
  guessed: number | null;
  analogy?: Analogy;
  onClose: () => void;
}) {
  const right = prediction && guessed !== null && guessed === prediction.correctIndex;
  return (
    <section style={{ ...styles.card, width: 360 }} aria-label="What just happened">
      {prediction ? (
        <>
          <div style={styles.kicker}>Your prediction vs. what happened</div>
          {guessed !== null ? (
            <p style={{ ...styles.line, color: right ? '#8fd17a' : '#ef7b6e' }}>
              {right ? '✓ ' : '✗ '}You said: {prediction.options[guessed]}
            </p>
          ) : null}
          {!right ? (
            <p style={{ ...styles.line, color: '#8fd17a' }}>
              It was: {prediction.options[prediction.correctIndex]}
            </p>
          ) : null}
        </>
      ) : null}
      {analogy ? (
        <>
          <div style={{ ...styles.kicker, marginTop: space.xs }}>Picture it like this</div>
          <p style={styles.line}>{analogy.text}</p>
          <div style={{ ...styles.kicker, color: '#ef7b6e' }}>Where this picture breaks</div>
          <p style={styles.line}>{analogy.breaksWhere}</p>
        </>
      ) : null}
      <button type="button" onClick={onClose} style={styles.skip}>
        close
      </button>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    pointerEvents: 'auto',
    width: 'min(640px, 92vw)',
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: space.md,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}88`,
    background: '#0b0806f4',
  },
  kicker: { fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.gold },
  question: {
    margin: 0,
    fontFamily: fonts.header,
    fontSize: 18,
    lineHeight: 1.35,
    color: colors.parchment,
  },
  options: { display: 'grid', gap: space.xs },
  option: {
    textAlign: 'left',
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}55`,
    background: '#1f140dcc',
    color: colors.parchment,
    fontSize: 14,
    lineHeight: 1.4,
  },
  skip: {
    alignSelf: 'flex-start',
    padding: `2px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: `${colors.parchment}88`,
    fontSize: 12,
  },
  line: { margin: 0, fontSize: 13.5, lineHeight: 1.5, color: `${colors.parchment}dd` },
};
