import { useMemo } from 'react';
import { evaluate } from '@chapter-quest/shared';
import type { SimSample, SimVisual } from '@chapter-quest/shared';
import { colors, fonts } from './tokens';

interface Props {
  visual: SimVisual;
  samples: SimSample[];
  /** Constants, params and outputs — what markers and bands are measured against. */
  scope: Record<string, number>;
  won: boolean;
}

const W = 600;
const H = 260;
const PAD = { left: 46, right: 16, top: 14, bottom: 30 };

/**
 * The run, drawn. A number tells you the satchel landed at 25.4 m; the arc tells
 * you why height bought the time and speed spent it.
 */
export function SimTrace({ visual, samples, scope, won }: Props) {
  const plot = useMemo(() => build(visual, samples, scope), [visual, samples, scope]);
  if (!plot) return null;

  const stroke = won ? colors.success : colors.gold;

  if (plot.kind === 'gauge') {
    return <Gauge plot={plot} won={won} />;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={styles.svg} role="img" aria-label={plot.caption}>
      <rect x={0} y={0} width={W} height={H} rx={8} fill="#00000066" />

      {plot.band ? (
        <rect
          x={plot.band.axis === 'x' ? plot.band.a : PAD.left}
          y={plot.band.axis === 'x' ? PAD.top : plot.band.b}
          width={plot.band.axis === 'x' ? plot.band.b - plot.band.a : W - PAD.left - PAD.right}
          height={plot.band.axis === 'x' ? H - PAD.top - PAD.bottom : plot.band.a - plot.band.b}
          fill={colors.success}
          opacity={0.22}
        />
      ) : null}

      {/* axes */}
      <line
        x1={PAD.left}
        y1={H - PAD.bottom}
        x2={W - PAD.right}
        y2={H - PAD.bottom}
        stroke={`${colors.parchment}44`}
      />
      <line
        x1={PAD.left}
        y1={PAD.top}
        x2={PAD.left}
        y2={H - PAD.bottom}
        stroke={`${colors.parchment}44`}
      />

      {plot.markers.map((m) => (
        <g key={m.label}>
          {m.axis === 'x' ? (
            <line
              x1={m.at}
              y1={PAD.top}
              x2={m.at}
              y2={H - PAD.bottom}
              stroke={colors.fail}
              strokeDasharray="4 4"
            />
          ) : (
            <line
              x1={PAD.left}
              y1={m.at}
              x2={W - PAD.right}
              y2={m.at}
              stroke={colors.fail}
              strokeDasharray="4 4"
            />
          )}
          <text
            x={m.axis === 'x' ? m.at + 4 : W - PAD.right}
            y={m.axis === 'x' ? PAD.top + 12 : m.at - 5}
            fill={colors.fail}
            fontSize={11}
            fontFamily={fonts.header}
            textAnchor={m.axis === 'x' ? 'start' : 'end'}
          >
            {m.label}
          </text>
        </g>
      ))}

      <polyline points={plot.points} fill="none" stroke={stroke} strokeWidth={2.5} />
      <circle cx={plot.last.x} cy={plot.last.y} r={5} fill={stroke} />

      <text
        x={PAD.left}
        y={H - 8}
        fill={`${colors.parchment}88`}
        fontSize={11}
        fontFamily={fonts.header}
      >
        {plot.xLabel}
      </text>
      <text
        x={6}
        y={PAD.top + 8}
        fill={`${colors.parchment}88`}
        fontSize={11}
        fontFamily={fonts.header}
      >
        {plot.yLabel}
      </text>
      <text
        x={W - PAD.right}
        y={H - 8}
        fill={`${colors.parchment}66`}
        fontSize={11}
        textAnchor="end"
        fontFamily={fonts.header}
      >
        {plot.caption}
      </text>
    </svg>
  );
}

function Gauge({ plot, won }: { plot: Plot; won: boolean }) {
  const { gauge } = plot;
  if (!gauge) return null;
  const pct = (v: number) => ((v - gauge.min) / (gauge.max - gauge.min)) * 100;
  return (
    <div style={styles.gauge}>
      <div style={styles.track}>
        {gauge.bandTo > gauge.bandFrom ? (
          <div
            style={{
              ...styles.band,
              left: `${pct(gauge.bandFrom)}%`,
              width: `${pct(gauge.bandTo) - pct(gauge.bandFrom)}%`,
            }}
          />
        ) : null}
        <div
          style={{
            ...styles.needle,
            left: `${Math.max(0, Math.min(100, pct(gauge.value)))}%`,
            background: won ? colors.success : colors.fail,
          }}
        />
      </div>
      <div style={styles.gaugeLabels}>
        <span>{round(gauge.min)}</span>
        <span style={{ color: won ? colors.success : colors.fail, fontFamily: fonts.header }}>
          {plot.yLabel} = {round(gauge.value)}
        </span>
        <span>{round(gauge.max)}</span>
      </div>
      <p style={styles.caption}>{plot.caption}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Plot {
  kind: SimVisual['kind'];
  points: string;
  last: { x: number; y: number };
  markers: { at: number; label: string; axis: 'x' | 'y' }[];
  band?: { a: number; b: number; axis: 'x' | 'y' };
  xLabel: string;
  yLabel: string;
  caption: string;
  gauge?: { value: number; min: number; max: number; bandFrom: number; bandTo: number };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Every expression is evaluated here, so a bad one degrades to "no plot". */
function build(
  visual: SimVisual,
  samples: SimSample[],
  scope: Record<string, number>,
): Plot | null {
  try {
    const xLabel = visual.xLabel ?? (visual.kind === 'timeline' ? 'time (s)' : 'x');
    const yLabel = visual.yLabel ?? 'y';

    if (visual.kind === 'gauge') {
      const value = evaluate(visual.y, scope);
      const from = visual.band ? evaluate(visual.band.from, scope) : 0;
      const to = visual.band ? evaluate(visual.band.to, scope) : 0;
      const max = Math.max(value, to) * 1.25;
      return {
        kind: 'gauge',
        points: '',
        last: { x: 0, y: 0 },
        markers: [],
        xLabel,
        yLabel,
        caption: visual.band?.label ?? '',
        gauge: { value, min: 0, max, bandFrom: from, bandTo: to },
      };
    }

    const xs: number[] = [];
    const ys: number[] = [];
    for (const sample of samples) {
      xs.push(visual.x ? evaluate(visual.x, sample) : (sample.t ?? 0));
      ys.push(evaluate(visual.y, sample));
    }
    if (xs.length < 2) return null;

    const markerValues = (visual.markers ?? []).map((m) => ({
      value: evaluate(m.value, scope),
      label: m.label,
      axis: m.axis ?? 'y',
    }));
    const bandFrom = visual.band ? evaluate(visual.band.from, scope) : null;
    const bandTo = visual.band ? evaluate(visual.band.to, scope) : null;
    const bandAxis = visual.band?.axis ?? 'y';

    const onX = (v: { axis: string }) => v.axis === 'x';
    const xExtra = markerValues.filter(onX).map((m) => m.value);
    const yExtra = markerValues.filter((m) => !onX(m)).map((m) => m.value);
    if (bandFrom !== null && bandTo !== null) {
      (bandAxis === 'x' ? xExtra : yExtra).push(bandFrom, bandTo);
    }

    const xr = range([...xs, ...xExtra]);
    const yr = range([...ys, ...yExtra]);

    const sx = (v: number) => PAD.left + ((v - xr.min) / xr.span) * (W - PAD.left - PAD.right);
    const sy = (v: number) =>
      H - PAD.bottom - ((v - yr.min) / yr.span) * (H - PAD.top - PAD.bottom);

    return {
      kind: visual.kind,
      points: xs.map((x, i) => `${sx(x).toFixed(1)},${sy(ys[i]!).toFixed(1)}`).join(' '),
      last: { x: sx(xs[xs.length - 1]!), y: sy(ys[ys.length - 1]!) },
      markers: markerValues.map((m) => ({
        at: m.axis === 'x' ? sx(m.value) : sy(m.value),
        label: `${m.label} ${round(m.value)}`,
        axis: m.axis as 'x' | 'y',
      })),
      ...(bandFrom !== null && bandTo !== null
        ? {
            band: {
              a: bandAxis === 'x' ? sx(bandFrom) : sy(bandFrom),
              b: bandAxis === 'x' ? sx(bandTo) : sy(bandTo),
              axis: bandAxis,
            },
          }
        : {}),
      xLabel,
      yLabel,
      caption: visual.band?.label ?? '',
    };
  } catch {
    return null;
  }
}

function range(values: number[]): { min: number; max: number; span: number } {
  const finite = values.filter(Number.isFinite);
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  return { min, max, span: max - min };
}

const styles: Record<string, React.CSSProperties> = {
  svg: { width: '100%', height: 'auto', display: 'block' },
  gauge: { display: 'grid', gap: 8, padding: '8px 0' },
  track: {
    position: 'relative',
    height: 22,
    borderRadius: 11,
    background: '#00000066',
    border: `1px solid ${colors.parchment}22`,
  },
  band: { position: 'absolute', top: 0, bottom: 0, background: colors.success, opacity: 0.3 },
  needle: { position: 'absolute', top: -4, bottom: -4, width: 3, borderRadius: 2 },
  gaugeLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 11,
    color: `${colors.parchment}88`,
  },
  caption: { margin: 0, fontSize: 12, color: `${colors.parchment}99`, lineHeight: 1.5 },
};
