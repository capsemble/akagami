/**
 * The numbers behind a balance stage, shared by the server (which validates a
 * stage before shipping it) and the client (which draws it and says why it did
 * what it did).
 *
 * Nothing here decides an outcome. The spec's own `win` does that, in the
 * simulator. This reads the same expressions at the same dials so that what is
 * drawn and what is said can never disagree with what was simulated.
 */
import { Run, evaluate, variablesOf } from './expr.js';
import type { ExprScope } from './expr.js';
import type { Balance, BalanceLoad, ParamSpec, SimSpec } from './types.js';

export interface PlacedLoad {
  load: BalanceLoad;
  at: number;
  atY: number;
  mass: number;
  moment: number;
}

export interface BalanceMeasure {
  loads: PlacedLoad[];
  pivot: number;
  pivotY: number;
  com: number | null;
  comY: number | null;
  /** Height of the support, sim units, when the stage declares one. */
  height: number | null;
  /** How high the cargo has to get, when there is a target. */
  targetHeight: number | null;
  /** Gravitational acceleration the spec uses, for torques. */
  g: number;
}

/** Constants, params, the initial state and every output that can be read before a run. */
export function balanceScope(spec: SimSpec, values: Record<string, number>): ExprScope {
  try {
    const scope = new Run(spec, values).scope;
    for (const [name, source] of Object.entries(spec.outputs)) {
      try {
        scope[name] = evaluate(source, scope);
      } catch {
        // an output that needs the end of the run is simply not readable yet
      }
    }
    return scope;
  } catch {
    return { ...spec.constants, ...values };
  }
}

export function measureBalance(
  balance: Balance,
  spec: SimSpec,
  values: Record<string, number>,
  scope: ExprScope = balanceScope(spec, values),
): BalanceMeasure {
  const read = (expr: string | undefined, fallback = 0): number => {
    if (!expr) return fallback;
    try {
      const value = evaluate(expr, scope);
      return Number.isFinite(value) ? value : fallback;
    } catch {
      return fallback;
    }
  };
  const loads = balance.loads.map((load) => ({
    load,
    at: read(load.at),
    atY: read(load.atY),
    mass: load.mass ? read(load.mass) : 0,
    moment: load.moment ? read(load.moment) : 0,
  }));
  const weighed = loads.filter((l) => l.mass > 0);
  const total = weighed.reduce((sum, l) => sum + l.mass, 0);
  const own = (axis: 'at' | 'atY') =>
    total > 0 ? weighed.reduce((sum, l) => sum + l.mass * l[axis], 0) / total : null;
  // A beam that turns on fixed moments as well as masses has no single centre
  // of mass worth drawing; only one the act itself names.
  const moments = loads.some((l) => l.load.moment);
  const across = balance.across;
  return {
    loads,
    pivot: read(balance.pivot),
    pivotY: across ? read(across.pivot) : 0,
    // Nor does a lever that is about delivering a load: a centre of mass drawn
    // beside a fulcrum invites mistaking one for the other.
    // Forces that are not weights (a bolt pressing) have no centre of mass either.
    com: balance.com
      ? read(balance.com)
      : moments || balance.target || balance.loads.some((l) => l.force)
        ? null
        : own('at'),
    comY: across ? (across.com ? read(across.com) : own('atY')) : null,
    height: balance.height ? read(balance.height) : null,
    targetHeight: balance.target ? read(balance.target.height) : null,
    g: typeof spec.constants.g === 'number' ? spec.constants.g : 9.81,
  };
}

/** Torque about the support from each side, m·g·d, plus any fixed moments. */
export function sideTorques(m: BalanceMeasure): { low: number; high: number } {
  let low = 0;
  let high = 0;
  for (const l of m.loads) {
    const arm = Math.abs(l.at - m.pivot);
    const turning = l.load.moment
      ? Math.abs(l.moment)
      : l.load.force
        ? l.mass * arm
        : l.mass * m.g * arm;
    if (l.at < m.pivot) low += turning;
    else high += turning;
  }
  return { low, high };
}

/**
 * Why it did what it did, in one line. Never the answer, only the reason —
 * and only a reason the numbers support. `outputs` are the run's own, read off
 * its last sample; `tilt` is the run's final tilt in radians.
 */
export function explainBalance(
  balance: Balance,
  spec: SimSpec,
  values: Record<string, number>,
  result: { won: boolean; tilt: number; outputs?: Record<string, number> },
): string {
  const m = measureBalance(balance, spec, values);
  const unit = balance.beam.unit ? ` ${balance.beam.unit}` : '';
  const pivot = balance.pivotLabel ?? 'pivot';

  if (balance.target) return explainLift(balance, m, values, result);

  if (balance.across) {
    if (result.won) return `The combined centre of mass sits over the ${pivot}.`;
    return `Centre of mass (${fmt(m.com ?? 0)}, ${fmt(m.comY ?? 0)}) — the ${pivot} is at (${fmt(m.pivot)}, ${fmt(m.pivotY)}).`;
  }
  if (m.com !== null) {
    const off = m.com - m.pivot;
    if (result.won) return `Level — the centre of mass is right over the ${pivot}.`;
    const side = m.loads
      .filter((l) => l.mass > 0 && Math.sign(l.at - m.pivot) === Math.sign(off))
      .sort((a, b) => b.mass - a.mass)[0];
    const whose = side ? ` on ${side.load.label ?? 'the heavy'}'s side` : '';
    return `The centre of mass is ${fmt(Math.abs(off))}${unit} from the ${pivot}${whose} — so that end goes down.`;
  }
  if (result.won) return 'Level — the turning effects on each side cancel.';
  const dropped = result.tilt >= 0 ? 1 : -1;
  const names = m.loads
    .filter((l) => Math.sign(l.at - m.pivot) === dropped)
    .map((l) => l.load.label ?? 'that load');
  const which = names.length ? `The ${names.join(' and ')} side` : 'That side';
  const what = m.loads.some((l) => l.load.force) ? 'force' : 'mass';
  return `${which} went down: its turning effect (${what} × distance) is the bigger one.`;
}

/**
 * A lever that has to put a load somewhere. Three outcomes, each told from the
 * numbers that caused it: it never moved, it moved and fell short, it arrived.
 */
function explainLift(
  balance: Balance,
  m: BalanceMeasure,
  values: Record<string, number>,
  result: { won: boolean; outputs?: Record<string, number> },
): string {
  const target = balance.target!;
  const unit = balance.beam.unit ? ` ${balance.beam.unit}` : '';
  const cargo = m.loads.find((l) => l.load.mass === target.cargo);
  if (!cargo) return result.won ? 'It arrived.' : 'Not there yet.';
  const name = cargo.load.label ?? 'the load';
  const cargoLow = cargo.at < m.pivot;
  const { low, high } = sideTorques(m);
  const load = cargoLow ? low : high;
  const effort = cargoLow ? high : low;
  const pivot = balance.pivotLabel ?? 'pivot';
  const height = result.outputs?.[target.output];
  const goal = m.targetHeight ?? 0;
  // Only offer what the player can actually change.
  const adjustable = balance.height ? variablesOf(balance.height).some((v) => v in values) : false;
  const raise = adjustable ? ` or build the ${pivot} higher` : '';

  if (effort <= load) {
    return `${cap(name)} turns ${fmt0(load)} N·m against the counterweight's ${fmt0(effort)} N·m, so nothing moves. Shorten the ${name}'s arm (move the ${pivot} toward it) or add counterweight.`;
  }
  if (!result.won && height !== undefined && height < goal) {
    return `It lifted — counterweight ${fmt0(effort)} N·m beat ${fmt0(load)} N·m — but the ${name} only rose to ${fmt2(height)}${unit}; the ${target.label ?? 'platform'} is ${fmt2(goal)}${unit}. Its arm is short, so its end barely travels: move the ${pivot} away from it${raise}, and keep enough counterweight to win.`;
  }
  if (result.won && height !== undefined) {
    return `Counterweight ${fmt0(effort)} N·m beat the ${name}'s ${fmt0(load)} N·m, and the arm ratio carried it to ${fmt2(height)}${unit}. A lever trades force for distance: the short arm lifts hard, the long arm travels far.`;
  }
  return result.won ? 'It arrived.' : 'Not there yet.';
}

/**
 * What is wrong with a balance stage, if anything. An empty list means every
 * expression reads, every load sits on the beam at every dial setting, and
 * every name the stage points at exists in the spec. A stage that fails is
 * never shipped: the act falls back to plain dials.
 */
export function checkBalance(balance: Balance, spec: SimSpec, params: ParamSpec[]): string[] {
  const problems: string[] = [];
  const beam = balance.beam;
  if (!(beam.toValue > beam.fromValue)) problems.push('beam runs backwards or has no length');
  if (balance.tilt && !(balance.tilt in spec.state) && !(balance.tilt in spec.outputs)) {
    problems.push(`tilt "${balance.tilt}" is not a state or output`);
  }
  if (balance.target) {
    if (!(balance.target.output in spec.outputs)) {
      problems.push(`target output "${balance.target.output}" is not an output`);
    }
    if (!balance.loads.some((l) => l.mass === balance.target!.cargo)) {
      problems.push(`target cargo "${balance.target.cargo}" is not a load`);
    }
  }

  const base = Object.fromEntries(params.map((p) => [p.name, p.default]));
  const settings = [base];
  for (const p of params) settings.push({ ...base, [p.name]: p.min }, { ...base, [p.name]: p.max });
  const slack = (beam.toValue - beam.fromValue) * 1e-6;
  const on = (v: number) => v >= beam.fromValue - slack && v <= beam.toValue + slack;
  for (const values of settings) {
    const m = measureBalance(balance, spec, values);
    if (!balance.across && !on(m.pivot)) problems.push(`pivot ${fmt(m.pivot)} is off the beam`);
    for (const l of m.loads) {
      if (!l.load.moment && !(l.mass >= 0))
        problems.push(`${l.load.label ?? 'a load'} has mass ${l.mass}`);
      if (!balance.across && !on(l.at))
        problems.push(`${l.load.label ?? 'a load'} at ${fmt(l.at)} is off the beam`);
    }
    if (balance.height && !(m.height !== null && m.height > 0))
      problems.push('support height is not positive');
  }
  return [...new Set(problems)];
}

const fmt = (v: number) => `${Math.round(v * 10) / 10}`;
const fmt2 = (v: number) => `${Math.round(v * 100) / 100}`;
const fmt0 = (v: number) => `${Math.round(v)}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
