import { useState } from 'react';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  busy: boolean;
  error?: string | null;
  onSubmit: (input: File | string) => void;
}

/** Plain version. Ranjan: this is the title screen, go wild. */
export function UploadPage({ busy, error, onSubmit }: Props) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const canSubmit = !busy && (file !== null || text.trim().length > 0);

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Chapter Quest</h1>
        <p style={styles.sub}>
          Drop in a chapter. Get a short story-driven RPG you win by actually using the concept.
        </p>

        <label style={styles.label}>
          Paste the chapter
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste a few thousand words of a textbook chapter…"
            rows={8}
            style={styles.textarea}
            disabled={busy}
          />
        </label>

        <label style={styles.label}>
          …or upload a file
          <input
            type="file"
            accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
            style={{ marginTop: space.xs }}
          />
        </label>

        {error ? <p style={styles.error}>{error}</p> : null}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onSubmit(file ?? text)}
          style={{ ...styles.button, opacity: canSubmit ? 1 : 0.45 }}
        >
          {busy ? 'Building the world…' : 'Build my world'}
        </button>

        <button
          type="button"
          onClick={() => onSubmit('demo:rag')}
          disabled={busy}
          style={styles.ghost}
        >
          Skip — play the RAG demo world
        </button>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100%',
    display: 'grid',
    placeItems: 'center',
    padding: space.lg,
    background: colors.ground,
  },
  card: {
    width: 'min(680px, 100%)',
    display: 'flex',
    flexDirection: 'column',
    gap: space.md,
    padding: space.xl,
    border: `1px solid ${colors.gold}55`,
    borderRadius: radii.panel,
    background: '#00000033',
  },
  title: { margin: 0, fontFamily: fonts.header, fontSize: 44, color: colors.gold },
  sub: { margin: 0, color: `${colors.parchment}cc`, lineHeight: 1.5 },
  label: { display: 'flex', flexDirection: 'column', gap: space.xs, fontSize: 14 },
  textarea: {
    width: '100%',
    padding: space.sm,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: '#0000004d',
    color: colors.parchment,
    fontFamily: fonts.body,
    resize: 'vertical',
  },
  button: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: 'none',
    background: colors.gold,
    color: colors.ground,
    fontWeight: 700,
  },
  ghost: {
    padding: space.sm,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: `${colors.parchment}aa`,
  },
  error: { margin: 0, color: colors.fail },
};
