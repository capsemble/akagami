import { useEffect, useRef } from 'react';
import type { Character, TeachingMove } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

const TECHNIQUE: Record<TeachingMove['technique'], string> = {
  contrast: 'Contrast',
  worked_example: 'Worked example',
  simpler_wording: 'In plainer words',
  debug_mistake: 'Debugging your attempt',
};

interface Props {
  move: TeachingMove;
  cast: Character[];
  /** A board is open: sit to the side of it rather than over its verdict. */
  docked?: boolean;
  onClose: () => void;
}

/**
 * After a miss: the character who personifies the wrong idea walks in and
 * cheers it on, and the guide answers it. The diagnosis behind it was computed
 * from the attempt; the model only chose which listed misconception it was.
 */
export function AdaptCard({ move, cast, docked = false, onClose }: Props) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.animate(
      [
        { transform: 'translateY(24px)', opacity: 0 },
        { transform: 'translateY(0)', opacity: 1 },
      ],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }, [move]);

  const who = (id?: string, name?: string) =>
    cast.find((c) => c.id === id) ?? cast.find((c) => c.name === name);
  const voice = move.voice ? who(move.voice.characterId, move.voice.speaker) : undefined;
  const guide = who(move.speakerId, move.speaker);

  return (
    <section
      ref={ref}
      style={docked ? { ...styles.card, ...styles.docked } : styles.card}
      role="status"
      aria-label="What went wrong, and why"
    >
      {move.voice ? (
        <div style={styles.row}>
          {voice ? <img src={voice.portraits.pleased} alt="" style={styles.portrait} /> : null}
          <div style={styles.body}>
            <div style={{ ...styles.name, color: '#ef7b6e' }}>
              {move.voice.speaker} <span style={styles.tag}>the wrong idea</span>
            </div>
            <p style={styles.voice}>“{move.voice.line}”</p>
          </div>
        </div>
      ) : null}

      <div style={styles.row}>
        {guide ? <img src={guide.portraits.neutral} alt="" style={styles.portrait} /> : null}
        <div style={styles.body}>
          <div style={styles.name}>
            {move.speaker} <span style={styles.tag}>{TECHNIQUE[move.technique]}</span>
            {move.offline ? (
              <span style={styles.tag}>no model — from the game's own check</span>
            ) : null}
          </div>
          <p style={styles.message}>{move.message}</p>
        </div>
      </div>

      {move.misconception ? (
        <p style={styles.diagnosis}>
          <strong style={{ color: colors.gold }}>Spotted:</strong> {move.misconception}
          {move.because ? <span style={styles.because}> — {move.because}</span> : null}
        </p>
      ) : null}

      <button type="button" onClick={onClose} style={styles.close}>
        got it
      </button>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    position: 'absolute',
    left: '50%',
    bottom: space.lg,
    transform: 'translateX(-50%)',
    zIndex: 30,
    width: 'min(680px, 94vw)',
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: space.md,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}99`,
    background: '#0b0806f6',
    boxShadow: '0 12px 40px #000a',
  },
  // Beside an open board, top right, where it covers neither the cards nor
  // the verdict. Narrow screens have no beside, so it stays at the bottom.
  docked: {
    left: 'auto',
    right: space.md,
    bottom: 'auto',
    top: space.md,
    transform: 'none',
    width: 'min(340px, 94vw)',
  },
  row: { display: 'flex', gap: space.md, alignItems: 'flex-start' },
  portrait: {
    width: 56,
    height: 56,
    flexShrink: 0,
    objectFit: 'cover',
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}55`,
  },
  body: { display: 'flex', flexDirection: 'column', gap: 2 },
  name: { fontFamily: fonts.header, fontSize: 15, color: colors.gold },
  tag: {
    marginLeft: space.xs,
    padding: '0 6px',
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    fontFamily: fonts.body,
    fontSize: 11,
    whiteSpace: 'nowrap',
    color: `${colors.parchment}aa`,
  },
  voice: {
    margin: 0,
    fontSize: 14,
    lineHeight: 1.45,
    fontStyle: 'italic',
    color: colors.parchment,
  },
  message: { margin: 0, fontSize: 14, lineHeight: 1.5, color: colors.parchment },
  diagnosis: {
    margin: 0,
    paddingTop: space.xs,
    borderTop: `1px solid ${colors.gold}22`,
    fontSize: 12.5,
    lineHeight: 1.45,
    color: `${colors.parchment}cc`,
  },
  because: { color: `${colors.parchment}88` },
  close: {
    alignSelf: 'flex-end',
    padding: `2px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}44`,
    background: 'transparent',
    color: `${colors.parchment}aa`,
    fontSize: 12,
  },
};
