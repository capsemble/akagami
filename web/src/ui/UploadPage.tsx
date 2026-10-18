import { useEffect, useState } from 'react';
import { API_MODE, api } from '../api';
import type { BuiltWorld } from '../api/types';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  busy: boolean;
  error?: string | null;
  onSubmit: (input: File | string) => void;
  /** Open a world this machine has already built, without building it again. */
  onOpen: (id: string) => void;
}

/** "3 minutes ago", roughly. A build is recent or it is not. */
function when(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Plain version. Ranjan: this is the title screen, go wild. */
export function UploadPage({ busy, error, onSubmit, onOpen }: Props) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [built, setBuilt] = useState<BuiltWorld[]>([]);
  const [apiDown, setApiDown] = useState(false);

  // A chapter costs minutes and credits to turn into a world. Once it exists
  // it should be one click away, not a build you run again because the server
  // restarted. The same call doubles as a reachability check.
  useEffect(() => {
    let alive = true;
    void api.listWorlds().then((worlds) => {
      if (!alive) return;
      setApiDown(worlds === null);
      setBuilt(worlds ?? []);
    });
    return () => {
      alive = false;
    };
  }, []);

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

        {/*
          Said here, not after the upload. Mock mode never reads the chapter —
          it picks one of two prepared worlds — and finding that out only once
          you are standing in the wrong world is how an honest upload turns
          into "are we always rendering the dummy game?".
        */}
        {API_MODE === 'mock' ? (
          <p style={styles.notice}>
            <strong style={styles.noticeHead}>Demo mode.</strong> Uploading plays one of the two
            prepared worlds below — your chapter is not read. Run <code>npm run dev</code> to build
            from it for real.
          </p>
        ) : apiDown ? (
          <p style={{ ...styles.notice, borderColor: `${colors.fail}66` }}>
            <strong style={{ ...styles.noticeHead, color: colors.fail }}>API unreachable.</strong>{' '}
            Building needs the server: <code>npm -w @chapter-quest/server run dev</code>. The demos
            below still work.
          </p>
        ) : null}

        {error ? <p style={styles.error}>{error}</p> : null}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => onSubmit(file ?? text)}
          style={{ ...styles.button, opacity: canSubmit ? 1 : 0.45 }}
        >
          {busy ? 'Building the world…' : 'Build my world'}
        </button>

        <div style={styles.demos}>
          <button
            type="button"
            onClick={() => onSubmit('demo:kinematics')}
            disabled={busy}
            style={styles.ghost}
          >
            Skip — play the kinematics demo
          </button>
          <button
            type="button"
            onClick={() => onSubmit('demo:rag')}
            disabled={busy}
            style={styles.ghost}
          >
            …or the RAG one
          </button>
          <button
            type="button"
            onClick={() => onSubmit('demo:machine')}
            disabled={busy}
            style={styles.ghost}
          >
            …or The Impossible Machine
          </button>
        </div>

        {built.length > 0 ? (
          <section style={styles.library}>
            <h2 style={styles.libraryTitle}>Worlds you have built</h2>
            <ul style={styles.list}>
              {built.map((world) => (
                <li key={world.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(world.id)}
                    disabled={busy}
                    style={styles.entry}
                    title={world.logline}
                  >
                    <span style={styles.entryTop}>
                      <span style={styles.entryTitle}>{world.title}</span>
                      <span style={styles.entryMeta}>
                        {world.acts} acts · {when(world.builtAt)}
                      </span>
                    </span>
                    <span style={styles.entryLine}>{world.logline}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
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
  demos: { display: 'flex', gap: space.sm },
  ghost: {
    flex: 1,
    padding: space.sm,
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}33`,
    background: 'transparent',
    color: `${colors.parchment}aa`,
  },
  error: { margin: 0, color: colors.fail },
  notice: {
    margin: 0,
    padding: space.sm,
    borderRadius: radii.chip,
    border: `1px solid ${colors.gold}55`,
    background: '#0000002e',
    fontSize: 13,
    lineHeight: 1.5,
    color: `${colors.parchment}cc`,
  },
  noticeHead: { color: colors.gold },
  library: {
    display: 'flex',
    flexDirection: 'column',
    gap: space.sm,
    paddingTop: space.md,
    borderTop: `1px solid ${colors.gold}33`,
  },
  libraryTitle: {
    margin: 0,
    fontFamily: fonts.header,
    fontSize: 15,
    color: `${colors.gold}cc`,
    letterSpacing: 0.4,
  },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: space.xs },
  entry: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    padding: space.sm,
    textAlign: 'left',
    borderRadius: radii.chip,
    border: `1px solid ${colors.parchment}22`,
    background: '#0000002e',
    color: colors.parchment,
    cursor: 'pointer',
  },
  entryTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: space.sm },
  entryTitle: { fontWeight: 700, color: colors.gold },
  entryMeta: { fontSize: 12, color: `${colors.parchment}77`, whiteSpace: 'nowrap' },
  entryLine: {
    fontSize: 12.5,
    lineHeight: 1.4,
    color: `${colors.parchment}99`,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
};
