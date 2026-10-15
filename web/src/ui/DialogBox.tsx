import { useEffect, useRef, useState } from 'react';
import { colors, fonts, motion, radii, space } from './tokens';

interface Props {
  speaker: string;
  portrait?: string;
  text: string;
  options?: string[];
  onPick?: (index: number) => void;
  /** Advance to the next line. Absent on the last line. */
  onNext?: () => void;
  /** Esc, or the skip control: abandon the whole exchange. */
  onClose: () => void;
  /** ms per character */
  speed?: number;
}

/** Typewriter dialogue. Click or press Enter to finish the line early, Esc closes. */
export function DialogBox({
  speaker,
  portrait,
  text,
  options,
  onPick,
  onNext,
  onClose,
  speed = 18,
}: Props) {
  const [shown, setShown] = useState(0);
  const done = shown >= text.length;
  const doneRef = useRef(done);
  doneRef.current = done;
  const nextRef = useRef(onNext);
  nextRef.current = onNext;

  useEffect(() => {
    setShown(0);
    const id = setInterval(() => {
      setShown((n) => {
        if (n >= text.length) {
          clearInterval(id);
          return n;
        }
        return n + 1;
      });
    }, speed);
    return () => clearInterval(id);
  }, [text, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (!doneRef.current) setShown(text.length);
      else nextRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, text.length]);

  return (
    <div
      style={styles.box}
      onClick={() => (done ? onNext?.() : setShown(text.length))}
      role="button"
      tabIndex={0}
      aria-label={`${speaker}: ${text}`}
    >
      <div style={styles.head}>
        {portrait ? (
          <img src={portrait} alt="" width={56} height={56} style={styles.portrait} />
        ) : null}
        <span style={styles.speaker}>{speaker}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={styles.close}
        >
          Esc skip
        </button>
      </div>

      <p style={styles.text}>
        {text.slice(0, shown)}
        {done ? null : <span style={styles.caret}>▌</span>}
      </p>

      {done && onNext && !(options && options.length > 0) ? (
        <div style={styles.next}>click, Enter or Space ▸</div>
      ) : null}

      {done && options && options.length > 0 ? (
        <div style={styles.options}>
          {options.map((option, i) => (
            <button
              key={option}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPick?.(i);
              }}
              style={styles.option}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  box: {
    width: 'min(880px, 94vw)',
    padding: space.md,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}66`,
    background: '#0b0806ee',
    display: 'grid',
    gap: space.sm,
    cursor: 'pointer',
    transition: `opacity ${motion.base}ms ease`,
  },
  head: { display: 'flex', alignItems: 'center', gap: space.sm },
  portrait: { borderRadius: radii.chip, border: `1px solid ${colors.gold}55` },
  speaker: { fontFamily: fonts.header, color: colors.gold, fontSize: 18, flex: 1 },
  close: {
    border: `1px solid ${colors.parchment}33`,
    borderRadius: radii.chip,
    background: 'transparent',
    color: `${colors.parchment}aa`,
    padding: `2px ${space.sm}px`,
  },
  text: { margin: 0, lineHeight: 1.6, minHeight: '3.2em' },
  caret: { color: colors.gold },
  next: {
    textAlign: 'right',
    fontSize: 11,
    color: `${colors.parchment}66`,
    fontFamily: fonts.header,
  },
  options: { display: 'grid', gap: space.xs },
  option: {
    textAlign: 'left',
    padding: space.sm,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: colors.parchment,
  },
};
