import type { ActStage, ParamSpec } from '@chapter-quest/shared';
import { colors, fonts, radii, space } from './tokens';

interface Props {
  /** The dials this act has, so a number the player set is named as one. */
  params: ParamSpec[];
  /** What they were set to for the run that just finished. */
  dials: Record<string, number>;
  /** What the simulation computed from them. */
  outputs: Record<string, number>;
  /** The one output the stage calls the verdict. Shown in gold. */
  readout?: ActStage['readout'];
  /**
   * Params the player kept a hand on during the run. What the card holds for
   * those is where the lever *started*, not one number the run used.
   */
  live?: string[];
  won: boolean;
}

/**
 * What the run actually did, in numbers.
 *
 * The verdict strip says whether it landed and the trace draws the curve, but
 * between them the arithmetic went unsaid: the player turned two dials and got
 * back "Not yet." with no sight of what their settings produced. These are
 * exactly the values the evaluator computed — `spec.outputs` and the params it
 * was given — so what is on the card is what the physics used, not a retelling.
 */
export function ResultCard({ params, dials, outputs, readout, live, won }: Props) {
  const settings = params
    .map((param) => ({ name: param.name, value: dials[param.name] }))
    .filter((row): row is { name: string; value: number } => Number.isFinite(row.value));

  const computed = Object.entries(outputs).filter(([, value]) => Number.isFinite(value));
  if (settings.length === 0 && computed.length === 0) return null;

  return (
    <section
      style={{ ...styles.card, borderColor: won ? `${colors.success}aa` : `${colors.fail}88` }}
    >
      <h2 style={styles.title}>Result</h2>

      {settings.map((row) => (
        <div key={row.name} style={styles.row}>
          <span style={styles.name}>
            {humanise(row.name)}
            {live?.includes(row.name) ? ' (start)' : ''}
          </span>
          <span style={styles.setValue}>{round(row.value)}</span>
        </div>
      ))}

      {settings.length > 0 && computed.length > 0 ? <div style={styles.rule} /> : null}

      {computed.map(([name, value]) => {
        const headline = readout?.output === name;
        return (
          <div key={name} style={styles.row}>
            <span style={styles.name}>{headline ? readout.label : humanise(name)}</span>
            <span style={headline ? styles.headlineValue : styles.value}>
              {round(value)}
              {headline && readout.unit ? readout.unit : ''}
            </span>
          </div>
        );
      })}
    </section>
  );
}

/** Big numbers do not need two decimals; small ones are nothing without them. */
const round = (n: number): string =>
  Math.abs(n) >= 1000 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);

/** Twin of the mapper's own, so a readout and a row agree on a name. */
const humanise = (name: string): string =>
  name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();

const styles: Record<string, React.CSSProperties> = {
  card: {
    pointerEvents: 'auto',
    width: 240,
    display: 'grid',
    gap: 3,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radii.chip,
    border: '1px solid',
    background: '#0b0806f2',
  },
  title: {
    margin: `0 0 ${space.xs}px`,
    fontFamily: fonts.header,
    fontSize: 15,
    color: `${colors.parchment}cc`,
  },
  row: { display: 'flex', justifyContent: 'space-between', gap: space.sm, fontSize: 12.5 },
  name: {
    color: `${colors.parchment}88`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  setValue: { color: `${colors.parchment}dd`, fontFamily: fonts.header, whiteSpace: 'nowrap' },
  value: { color: colors.oracle, fontFamily: fonts.header, whiteSpace: 'nowrap' },
  headlineValue: { color: colors.gold, fontFamily: fonts.header, whiteSpace: 'nowrap' },
  rule: { height: 1, margin: `${space.xs}px 0`, background: `${colors.parchment}1a` },
};
