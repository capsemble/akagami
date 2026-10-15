import type { RagParams, RagRunResponse } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

const CHUNK_SIZES: RagParams['chunkSize'][] = [40, 120, 250, 500];
const OVERLAPS: RagParams['overlap'][] = [0, 15, 30];

interface Props {
  question: string;
  params: RagParams;
  result: RagRunResponse | null;
  busy: boolean;
  onChange: (params: RagParams) => void;
  onRun: () => void;
  onClose: () => void;
}

/** The Oracle's satchel, as a control panel. Props in, events out. */
export function RagPanel({ question, params, result, busy, onChange, onRun, onClose }: Props) {
  const set = (patch: Partial<RagParams>) => onChange({ ...params, ...patch });

  return (
    <section style={styles.panel}>
      <header style={styles.header}>
        <h2 style={styles.title}>The Oracle&apos;s Satchel</h2>
        <button type="button" onClick={onClose} style={styles.close}>
          Esc ✕
        </button>
      </header>

      <p style={styles.question}>“{question}”</p>

      <div style={styles.controls}>
        <Row label={`Chunk size — ${params.chunkSize} words`}>
          {CHUNK_SIZES.map((size) => (
            <Chip
              key={size}
              active={params.chunkSize === size}
              onClick={() => set({ chunkSize: size })}
              label={String(size)}
            />
          ))}
        </Row>

        <Row label={`Overlap — ${params.overlap} words`}>
          {OVERLAPS.map((overlap) => (
            <Chip
              key={overlap}
              active={params.overlap === overlap}
              onClick={() => set({ overlap })}
              label={String(overlap)}
            />
          ))}
        </Row>

        <Row label={`Scrolls in the satchel (k) — ${params.k}`}>
          <input
            type="range"
            min={1}
            max={8}
            value={params.k}
            onChange={(e) => set({ k: Number(e.target.value) })}
            style={{ width: 200 }}
          />
        </Row>

        <Row label="Rerank">
          <Chip
            active={params.rerank}
            onClick={() => set({ rerank: !params.rerank })}
            label={params.rerank ? 'on' : 'off'}
          />
        </Row>
      </div>

      <button type="button" onClick={onRun} disabled={busy} style={styles.run}>
        {busy ? 'Asking the Oracle…' : 'Ask the Oracle'}
      </button>

      {result ? (
        <div style={styles.result}>
          <div style={styles.answerBlock}>
            <h3 style={styles.h3}>Answer</h3>
            <p style={styles.answer}>{result.answer}</p>
            <p style={styles.meta}>
              {result.latencyMs} ms{result.cached ? ' · cached' : ''}
            </p>
          </div>

          <div>
            <h3 style={styles.h3}>Retrieved ({result.retrieved.length})</h3>
            <ul style={styles.retrieved}>
              {result.retrieved.map((chunk) => (
                <li
                  key={chunk.id}
                  style={{
                    ...styles.chunk,
                    borderLeftColor: chunk.gold ? colors.gold : `${colors.parchment}33`,
                  }}
                >
                  <div style={styles.chunkHead}>
                    <span style={styles.chunkId}>{chunk.id}</span>
                    <span style={styles.score}>{chunk.score.toFixed(2)}</span>
                    {chunk.gold ? <span style={styles.goldTag}>gold</span> : null}
                  </div>
                  <p style={styles.chunkText}>{chunk.text}</p>
                </li>
              ))}
            </ul>
          </div>

          <div
            style={{
              ...styles.judge,
              borderColor: result.judge.correct ? colors.success : colors.fail,
            }}
          >
            <h3
              style={{ ...styles.h3, color: result.judge.correct ? colors.success : colors.fail }}
            >
              Judge: {result.judge.correct ? 'grounded' : 'not grounded'}
            </h3>
            {result.judge.missingFacts.length > 0 ? (
              <p style={styles.meta}>Missing: {result.judge.missingFacts.join('; ')}</p>
            ) : null}
            {result.judge.unsupportedClaims.length > 0 ? (
              <p style={{ ...styles.meta, color: colors.fail }}>
                Unsupported: {result.judge.unsupportedClaims.join('; ')}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <div style={styles.rowControls}>{children}</div>
    </div>
  );
}

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.chip,
        background: active ? colors.gold : 'transparent',
        color: active ? colors.ground : `${colors.parchment}cc`,
        borderColor: active ? colors.gold : `${colors.parchment}33`,
      }}
    >
      {label}
    </button>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 'min(760px, 94vw)',
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
  question: { margin: 0, fontStyle: 'italic', color: colors.oracle },
  controls: { display: 'grid', gap: space.sm },
  row: { display: 'grid', gridTemplateColumns: '240px 1fr', gap: space.sm, alignItems: 'center' },
  rowLabel: { fontSize: 13, color: `${colors.parchment}aa` },
  rowControls: { display: 'flex', gap: space.xs, alignItems: 'center', flexWrap: 'wrap' },
  chip: { padding: `4px ${space.sm}px`, borderRadius: radii.chip, border: '1px solid' },
  run: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: 'none',
    background: colors.lapis,
    color: colors.parchment,
    fontWeight: 700,
  },
  result: { display: 'grid', gap: space.md },
  answerBlock: {
    padding: space.md,
    borderRadius: radii.chip,
    background: '#ffffff0a',
  },
  h3: {
    margin: `0 0 ${space.xs}px`,
    fontFamily: fonts.header,
    fontSize: 16,
    color: colors.parchment,
  },
  answer: { margin: 0, lineHeight: 1.5 },
  meta: { margin: `${space.xs}px 0 0`, fontSize: 12, color: `${colors.parchment}88` },
  retrieved: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.xs },
  chunk: { borderLeft: '3px solid', paddingLeft: space.sm },
  chunkHead: { display: 'flex', gap: space.sm, alignItems: 'baseline', fontSize: 12 },
  chunkId: { fontFamily: fonts.header, color: `${colors.parchment}aa` },
  score: { color: colors.oracle },
  goldTag: { color: colors.gold },
  chunkText: { margin: '2px 0 0', fontSize: 13, color: `${colors.parchment}cc`, lineHeight: 1.4 },
  judge: { padding: space.md, borderRadius: radii.chip, border: '1px solid' },
};
