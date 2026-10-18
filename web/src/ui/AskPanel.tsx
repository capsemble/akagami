import { useEffect, useRef, useState } from 'react';
import type { Character } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

export interface AskEntry {
  who: 'player' | 'guide';
  text: string;
  /** A guide line no model wrote — a scripted pointer, said as one. */
  offline?: boolean;
  /** The request itself failed; this is the error, not the guide. */
  failed?: boolean;
}

interface Props {
  guide: Character;
  log: AskEntry[];
  busy: boolean;
  /** Questions worth one click, chosen from where the player is in the act. */
  suggestions: string[];
  onAsk: (question: string) => void;
  onClose: () => void;
}

const MAX_QUESTION = 400;

/**
 * Talking to the guide.
 *
 * Sits where the dialogue box sits, in the same frame, because it is the same
 * thing: someone in the room speaking to you. The difference is that this one
 * listens. Suggested questions are there for the player who does not yet know
 * what to ask — which, on a concept they have just met, is most players.
 */
export function AskPanel({ guide, log, busy, suggestions, onAsk, onClose }: Props) {
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const transcript = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  // The newest line is the one being read; keep it in view.
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log.length, busy]);

  const send = (question: string) => {
    const trimmed = question.trim().slice(0, MAX_QUESTION);
    if (!trimmed || busy) return;
    onAsk(trimmed);
    setDraft('');
    input.current?.focus();
  };

  return (
    <section style={styles.panel} aria-label={`Ask ${guide.name}`}>
      <header style={styles.head}>
        <img src={guide.portraits.neutral} alt="" width={48} height={48} style={styles.portrait} />
        <div style={styles.who}>
          <span style={styles.name}>{guide.name}</span>
          <span style={styles.role}>your guide — ask anything about this act</span>
        </div>
        <button type="button" onClick={onClose} style={styles.close}>
          Esc ✕
        </button>
      </header>

      <div ref={transcript} style={styles.transcript}>
        {log.length === 0 ? (
          <p style={styles.opening}>
            Stuck, curious, or sure the game is wrong? Ask — I won't hand you the answer, but I'll
            help you find it.
          </p>
        ) : null}
        {log.map((entry, i) =>
          entry.failed ? (
            <p key={i} style={styles.failed}>
              {entry.text}
            </p>
          ) : (
            <div key={i} style={entry.who === 'player' ? styles.playerLine : styles.guideLine}>
              <span style={styles.speaker}>{entry.who === 'player' ? 'You' : guide.name}</span>
              <span>{entry.text}</span>
              {entry.offline ? (
                <span style={styles.offline}>scripted hint — no model answered</span>
              ) : null}
            </div>
          ),
        )}
        {busy ? <p style={styles.thinking}>{guide.name} is thinking…</p> : null}
      </div>

      {!busy && suggestions.length > 0 ? (
        <div style={styles.chips}>
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} style={styles.chip}>
              {s}
            </button>
          ))}
        </div>
      ) : null}

      <form
        style={styles.row}
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <input
          ref={input}
          value={draft}
          maxLength={MAX_QUESTION}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Esc closes from inside the field: the app's own Esc handler
            // stands down while the player is typing, by design.
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder={`Ask ${guide.name.split(' ')[0]} a question…`}
          style={styles.input}
          aria-label="Your question"
        />
        <button type="submit" disabled={busy || !draft.trim()} style={styles.send}>
          Ask
        </button>
      </form>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 'min(760px, 94vw)',
    maxHeight: '62vh',
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: space.md,
    borderRadius: radii.panel,
    border: `1px solid ${colors.gold}66`,
    background: '#0b0806f4',
    animation: 'cq-rise 250ms ease-out both',
  },
  head: { display: 'flex', alignItems: 'center', gap: space.sm },
  portrait: { borderRadius: radii.chip, objectFit: 'cover', border: `1px solid ${colors.gold}44` },
  who: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
  name: { fontFamily: fonts.header, fontSize: 18, color: colors.gold },
  role: { fontSize: 12, color: `${colors.parchment}77` },
  close: {
    border: `1px solid ${colors.parchment}33`,
    borderRadius: radii.chip,
    background: 'transparent',
    color: `${colors.parchment}aa`,
    padding: `2px ${space.sm}px`,
  },
  transcript: {
    flex: 1,
    minHeight: 80,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    padding: `${space.xs}px 2px`,
  },
  opening: { margin: 0, fontSize: 14, lineHeight: 1.5, color: `${colors.parchment}99` },
  playerLine: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: `${space.xs}px ${space.sm}px`,
    borderRadius: radii.chip,
    background: `${colors.lapis}66`,
    fontSize: 14,
    lineHeight: 1.45,
    color: colors.parchment,
  },
  guideLine: {
    alignSelf: 'flex-start',
    maxWidth: '88%',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: `${space.xs}px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}33`,
    background: '#00000044',
    fontSize: 14,
    lineHeight: 1.5,
    color: `${colors.parchment}ee`,
  },
  speaker: { fontFamily: fonts.header, fontSize: 12, color: `${colors.gold}cc` },
  offline: { fontSize: 11, color: `${colors.parchment}66`, fontStyle: 'italic' },
  failed: { margin: 0, fontSize: 13, color: colors.fail },
  thinking: { margin: 0, fontSize: 13, color: `${colors.parchment}77`, fontStyle: 'italic' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: space.xs },
  chip: {
    padding: `3px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}55`,
    background: 'transparent',
    color: `${colors.gold}dd`,
    fontSize: 12.5,
  },
  row: { display: 'flex', gap: space.sm },
  input: {
    flex: 1,
    padding: `${space.sm}px ${space.sm}px`,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: '#0000004d',
    color: colors.parchment,
    fontFamily: fonts.body,
    fontSize: 14,
  },
  send: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: 'none',
    background: colors.gold,
    color: colors.ground,
    fontWeight: 700,
  },
};
