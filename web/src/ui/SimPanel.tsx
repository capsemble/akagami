import type { Act } from '@chapter-quest/shared';
import type { FormulaMechanic, SimOutcome } from '../api/sim';
import { SimTrace } from './SimTrace';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  act: Act;
  mechanic: FormulaMechanic;
  dials: Record<string, number>;
  outcome: SimOutcome | null;
  /** False while shared/expr.ts is still the placeholder. */
  available: boolean;
  /** True when the act was played in the world and this is the explanation. */
  staged?: boolean;
  onChange: (dials: Record<string, number>) => void;
  onRun: () => void;
  onClose: () => void;
}

/**
 * The numbers behind a run.
 *
 * On a staged act this is not how you play — you have already planted the
 * marker or pulled the aim, and this opens afterwards to show what those
 * numbers did. The dials stay live on purpose: once you have seen the thing
 * happen, dragging them is the cheapest way to find out what else would have.
 */
export function SimPanel({
  act,
  mechanic,
  dials,
  outcome,
  available,
  staged = false,
  onChange,
  onRun,
  onClose,
}: Props) {
  return (
    <section style={styles.panel}>
      <header style={styles.header}>
        <h2 style={styles.title}>{act.title}</h2>
        <button type="button" onClick={onClose} style={styles.close}>
          Esc ✕
        </button>
      </header>

      <p style={styles.goal}>{staged ? act.explainAfter : act.goal}</p>

      <div style={styles.controls}>
        {mechanic.params.map((param) => {
          const value = dials[param.name] ?? param.default;
          const step = (param.max - param.min) / 100;
          return (
            <div key={param.name} style={styles.row}>
              <span style={styles.rowLabel}>
                {param.name} — <strong style={{ color: colors.gold }}>{round(value)}</strong>
              </span>
              <input
                type="range"
                min={param.min}
                max={param.max}
                step={step}
                value={value}
                onChange={(e) => onChange({ ...dials, [param.name]: Number(e.target.value) })}
                style={{ width: 240 }}
              />
              <span style={styles.range}>
                {param.min}…{param.max}
              </span>
            </div>
          );
        })}
      </div>

      <button type="button" onClick={onRun} disabled={!available} style={styles.run}>
        {!available ? 'Simulator not wired up' : staged ? 'Try these numbers' : 'Run it'}
      </button>

      {!available ? (
        <p style={styles.unavailable}>
          The dials are live but the physics is not: <code>shared/expr.ts</code> is still the
          placeholder, so nothing can be simulated yet.
        </p>
      ) : null}

      {outcome ? (
        <div
          style={{
            ...styles.result,
            borderColor: outcome.won ? colors.success : colors.fail,
          }}
        >
          <h3 style={{ ...styles.h3, color: outcome.won ? colors.success : colors.fail }}>
            {outcome.won ? 'It lands.' : 'Not yet.'}
          </h3>

          {mechanic.spec.visual ? (
            <SimTrace
              visual={mechanic.spec.visual}
              samples={outcome.samples}
              scope={{ ...mechanic.spec.constants, ...dials, ...outcome.outputs }}
              won={outcome.won}
            />
          ) : null}
          <ul style={styles.outputs}>
            {Object.entries(outcome.outputs).map(([name, value]) => (
              <li key={name} style={styles.output}>
                <span style={styles.outputName}>{name}</span>
                <span style={styles.outputValue}>{round(value)}</span>
              </li>
            ))}
          </ul>
          {outcome.won ? <p style={styles.explain}>{act.explainAfter}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 'min(680px, 94vw)',
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
  goal: { margin: 0, lineHeight: 1.5, color: `${colors.parchment}dd` },
  controls: { display: 'grid', gap: space.sm },
  row: {
    display: 'grid',
    gridTemplateColumns: '220px 1fr 90px',
    gap: space.sm,
    alignItems: 'center',
  },
  rowLabel: { fontSize: 13, color: `${colors.parchment}aa` },
  range: { fontSize: 11, color: `${colors.parchment}66`, fontFamily: fonts.header },
  run: {
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: 'none',
    background: colors.lapis,
    color: colors.parchment,
    fontWeight: 700,
  },
  unavailable: { margin: 0, fontSize: 12, color: colors.fail, lineHeight: 1.5 },
  result: { padding: space.md, borderRadius: radii.chip, border: '1px solid' },
  h3: { margin: `0 0 ${space.sm}px`, fontFamily: fonts.header, fontSize: 18 },
  outputs: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: space.xs },
  output: { display: 'flex', justifyContent: 'space-between', fontSize: 13 },
  outputName: { color: `${colors.parchment}aa`, fontFamily: fonts.header },
  outputValue: { color: colors.oracle },
  explain: {
    margin: `${space.sm}px 0 0`,
    fontSize: 13,
    lineHeight: 1.55,
    color: `${colors.parchment}cc`,
  },
};
