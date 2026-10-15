/**
 * The expression evaluator and the little simulator that runs a formula act.
 *
 * Expressions come from a language model, so nothing here goes near eval() or
 * new Function(). A source string is tokenised, parsed into a tree of closures
 * once, and then run as many times as the simulation needs.
 *
 * The supported language is deliberately small, and matches EXPR_RULE in
 * server/src/prompts.ts exactly — if you widen one, widen the other:
 *
 *   numbers, variable names, + - * / ( ), unary -,
 *   comparisons < <= > >= == !=, and && ||
 *
 * Booleans are carried as 1 and 0 so that comparisons compose with arithmetic.
 */
import type { ParamSpec, SimSpec } from './types.js';

export interface ExprScope {
  [key: string]: number | boolean;
}

export interface CompiledExpr {
  readonly source: string;
  /** Free variables, in first-seen order. */
  readonly variables: readonly string[];
  evaluate(scope: ExprScope): number;
}

export class ExprError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`${message} in "${source}"`);
    this.name = 'ExprError';
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const TOKEN = /\s*(\d+(?:\.\d+)?|[A-Za-z_]\w*|<=|>=|==|!=|&&|\|\||[-+*/()<>])/y;

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < source.length) {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(source);
    if (!match) {
      const rest = source.slice(at).trim();
      if (!rest) break;
      throw new ExprError(`unexpected character "${rest[0]}"`, source);
    }
    tokens.push(match[1]!);
    at = TOKEN.lastIndex;
  }
  if (tokens.length === 0) throw new ExprError('empty expression', source);
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — precedence climbing, compiling straight to closures
// ---------------------------------------------------------------------------

type Node = (scope: ExprScope) => number;

/**
 * Own properties only. A plain object inherits `constructor`, `__proto__` and
 * friends from Object.prototype, so a lookup by `in` or `!== undefined` would
 * hand an expression the Object constructor instead of refusing it.
 */
const read = (scope: ExprScope, name: string, source: string): number => {
  if (!Object.prototype.hasOwnProperty.call(scope, name)) {
    throw new ExprError(`unknown variable "${name}"`, source);
  }
  const value = scope[name];
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number') {
    throw new ExprError(`variable "${name}" is ${typeof value}, not a number`, source);
  }
  return value;
};

class Parser {
  private at = 0;
  readonly variables: string[] = [];

  constructor(
    private readonly tokens: string[],
    private readonly source: string,
  ) {}

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private take(): string {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new ExprError('unexpected end of expression', this.source);
    return token;
  }

  parse(): Node {
    const node = this.or();
    if (this.at !== this.tokens.length) {
      throw new ExprError(`unexpected "${this.tokens[this.at]}"`, this.source);
    }
    return node;
  }

  private or(): Node {
    let left = this.and();
    while (this.peek() === '||') {
      this.take();
      const right = this.and();
      const l = left;
      left = (s) => (l(s) !== 0 || right(s) !== 0 ? 1 : 0);
    }
    return left;
  }

  private and(): Node {
    let left = this.comparison();
    while (this.peek() === '&&') {
      this.take();
      const right = this.comparison();
      const l = left;
      left = (s) => (l(s) !== 0 && right(s) !== 0 ? 1 : 0);
    }
    return left;
  }

  private comparison(): Node {
    let left = this.sum();
    for (;;) {
      const op = this.peek();
      if (op !== '<' && op !== '<=' && op !== '>' && op !== '>=' && op !== '==' && op !== '!=') {
        return left;
      }
      this.take();
      const right = this.sum();
      const l = left;
      switch (op) {
        case '<':
          left = (s) => (l(s) < right(s) ? 1 : 0);
          break;
        case '<=':
          left = (s) => (l(s) <= right(s) ? 1 : 0);
          break;
        case '>':
          left = (s) => (l(s) > right(s) ? 1 : 0);
          break;
        case '>=':
          left = (s) => (l(s) >= right(s) ? 1 : 0);
          break;
        case '==':
          left = (s) => (l(s) === right(s) ? 1 : 0);
          break;
        default:
          left = (s) => (l(s) !== right(s) ? 1 : 0);
      }
    }
  }

  private sum(): Node {
    let left = this.product();
    for (;;) {
      const op = this.peek();
      if (op !== '+' && op !== '-') return left;
      this.take();
      const right = this.product();
      const l = left;
      left = op === '+' ? (s) => l(s) + right(s) : (s) => l(s) - right(s);
    }
  }

  private product(): Node {
    let left = this.unary();
    for (;;) {
      const op = this.peek();
      if (op !== '*' && op !== '/') return left;
      this.take();
      const right = this.unary();
      const l = left;
      left = op === '*' ? (s) => l(s) * right(s) : (s) => l(s) / right(s);
    }
  }

  private unary(): Node {
    if (this.peek() === '-') {
      this.take();
      const operand = this.unary();
      return (s) => -operand(s);
    }
    if (this.peek() === '+') {
      this.take();
      return this.unary();
    }
    return this.atom();
  }

  private atom(): Node {
    const token = this.take();

    if (token === '(') {
      const inner = this.or();
      const close = this.take();
      if (close !== ')') throw new ExprError(`expected ")" but found "${close}"`, this.source);
      return inner;
    }

    if (/^\d/.test(token)) {
      const value = Number(token);
      return () => value;
    }

    if (/^[A-Za-z_]/.test(token)) {
      if (!this.variables.includes(token)) this.variables.push(token);
      const source = this.source;
      return (s) => read(s, token, source);
    }

    throw new ExprError(`unexpected "${token}"`, this.source);
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const cache = new Map<string, CompiledExpr>();

/** Parse an expression. Throws ExprError if it does not parse. */
export function compile(source: string): CompiledExpr {
  const hit = cache.get(source);
  if (hit) return hit;

  const parser = new Parser(tokenize(source), source);
  const node = parser.parse();
  const compiled: CompiledExpr = {
    source,
    variables: Object.freeze([...parser.variables]),
    evaluate: node,
  };
  cache.set(source, compiled);
  return compiled;
}

export function evaluate(source: string | CompiledExpr, scope: ExprScope): number {
  return (typeof source === 'string' ? compile(source) : source).evaluate(scope);
}

/** Free variables referenced by an expression. */
export function variablesOf(source: string | CompiledExpr): string[] {
  return [...(typeof source === 'string' ? compile(source) : source).variables];
}

/** Back-compatible boolean form. */
export function evaluateExpr(source: string, scope: ExprScope): boolean {
  return evaluate(source, scope) !== 0;
}

export interface SimResult {
  won: boolean;
  outputs: Record<string, number>;
  /** Final state, handy for drawing the trajectory. */
  state: Record<string, number>;
  steps: number;
  time: number;
  /**
   * The path the run took: one sample per recorded step, each holding every
   * constant, param and state value at that moment plus `t`. Empty unless
   * `trace` was asked for — recording costs an object per sample.
   */
  samples: SimSample[];
}

export type SimSample = Record<string, number>;

export interface SimOptions {
  /** Record the path. Roughly this many samples, evenly spaced. */
  trace?: number | boolean;
}

const DEFAULT_TRACE_SAMPLES = 180;

/** A spec that integrates forever is a bug, not a long simulation. */
const MAX_STEPS = 2_000_000;

/**
 * One simulation, stepped by hand.
 *
 * This is the whole physics engine. `simulate` drives it to completion in a
 * tight loop; a live act drives it one frame at a time with the player writing
 * a control into the scope between steps. Both go through here, so a run you
 * drive and a run the validator scores can never disagree about the physics.
 *
 * State initialisers are evaluated in declaration order, so a later one may use
 * an earlier one. Each step computes every update from the *current* state
 * before assigning any of them, so the order of `step` entries cannot change
 * the physics. Outputs are evaluated after the run, in order, and each is
 * visible to the next and to `win`.
 */
export class Run {
  readonly scope: ExprScope;
  /** Steps taken so far. Simulated time is this times `spec.dt`. */
  steps = 0;

  private readonly stepExprs: (readonly [string, CompiledExpr])[];
  private readonly untilExpr: CompiledExpr | null;
  private readonly next: number[];
  private readonly limit: number;
  private finished = false;
  /** Real seconds not yet spent on a whole step. */
  private carry = 0;

  constructor(
    readonly spec: SimSpec,
    params: Record<string, number>,
  ) {
    this.scope = { ...spec.constants, ...params };
    for (const [name, source] of Object.entries(spec.state)) {
      this.scope[name] = evaluate(source, this.scope);
    }
    this.scope.dt = spec.dt;

    this.untilExpr = spec.until ? compile(spec.until) : null;
    this.stepExprs = Object.entries(spec.step).map(
      ([name, source]) => [name, compile(source)] as const,
    );
    this.next = new Array<number>(this.stepExprs.length);
    this.limit = spec.dt > 0 ? Math.ceil(spec.maxTime / spec.dt) : 0;
    if (this.limit > MAX_STEPS) {
      throw new Error(
        `simulate: ${this.limit} steps requested (maxTime ${spec.maxTime} / dt ${spec.dt})`,
      );
    }
  }

  get time(): number {
    return this.steps * this.spec.dt;
  }

  /** True once `until` fires or the step ceiling is reached. */
  get done(): boolean {
    if (this.finished || this.steps >= this.limit) return true;
    return this.untilExpr !== null && this.untilExpr.evaluate(this.scope) !== 0;
  }

  /** What the player is holding right now. Read by the next step, not this one. */
  set(name: string, value: number): void {
    this.scope[name] = value;
  }

  /** Advance by exactly one `spec.dt`. Returns false if the run was over. */
  step(): boolean {
    if (this.done) return false;
    for (let i = 0; i < this.stepExprs.length; i++) {
      this.next[i] = this.stepExprs[i]![1].evaluate(this.scope);
    }
    for (let i = 0; i < this.stepExprs.length; i++) {
      const value = this.next[i]!;
      if (!Number.isFinite(value)) {
        throw new Error(
          `simulate: ${this.stepExprs[i]![0]} became ${value} after ${this.steps + 1} steps`,
        );
      }
      this.scope[this.stepExprs[i]![0]] = value;
    }
    this.steps++;
    return true;
  }

  /**
   * Advance by real elapsed seconds, in whole `dt` steps.
   *
   * Leftover time is carried to the next call. A frame is usually shorter than
   * `dt` — 16 ms against a 50 ms step — so without the carry every frame floors
   * to zero steps and the run never moves at all. Capped so a stalled tab
   * cannot integrate a minute of physics in one frame.
   */
  advance(seconds: number, controls?: Record<string, number>, maxSteps = 240): number {
    if (controls) for (const [name, value] of Object.entries(controls)) this.set(name, value);
    const dt = this.spec.dt;
    if (dt <= 0) return 0;
    this.carry = Math.min(this.carry + seconds, maxSteps * dt);
    let taken = 0;
    while (this.carry >= dt && this.step()) {
      this.carry -= dt;
      taken++;
    }
    return taken;
  }

  /** A snapshot of every number in scope, as a trace sample. */
  sample(): SimSample {
    const sample: SimSample = { t: this.time };
    for (const [key, value] of Object.entries(this.scope)) {
      if (typeof value === 'number') sample[key] = value;
    }
    return sample;
  }

  /** Evaluate the outputs and the win condition against where the run ended. */
  finish(): Omit<SimResult, 'samples'> {
    this.finished = true;
    const outputs: Record<string, number> = {};
    for (const [name, source] of Object.entries(this.spec.outputs)) {
      const value = evaluate(source, this.scope);
      outputs[name] = value;
      this.scope[name] = value;
    }
    const state: Record<string, number> = {};
    for (const name of Object.keys(this.spec.state)) state[name] = this.scope[name] as number;

    return {
      won: evaluate(this.spec.win, this.scope) !== 0,
      outputs,
      state,
      steps: this.steps,
      time: this.time,
    };
  }
}

/** Run one simulation to completion. See `Run` for the physics itself. */
export function simulate(
  spec: SimSpec,
  params: Record<string, number>,
  options: SimOptions = {},
): SimResult {
  const run = new Run(spec, params);

  const wanted =
    options.trace === true
      ? DEFAULT_TRACE_SAMPLES
      : typeof options.trace === 'number'
        ? options.trace
        : 0;
  const limit = spec.dt > 0 ? Math.ceil(spec.maxTime / spec.dt) : 0;
  const every = wanted > 0 ? Math.max(1, Math.floor(limit / wanted) || 1) : 0;
  const samples: SimSample[] = [];
  if (wanted > 0) samples.push(run.sample());

  while (run.step()) {
    if (wanted > 0 && (run.steps % every === 0 || run.steps === limit)) samples.push(run.sample());
  }

  const result = run.finish();

  // The last sample carries the outputs too, so a plot can mark where it ended.
  if (wanted > 0) {
    samples.pop();
    samples.push(run.sample());
  }

  return { ...result, samples };
}

/** Deterministic, so a failing win-rate check fails the same way every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How often random dial positions win. An act that scores high here can be
 * beaten without understanding anything, which is the whole point of checking.
 * A spec that throws on some sample counts that sample as a loss.
 */
export function randomWinRate(spec: SimSpec, params: ParamSpec[], samples = 400, seed = 1): number {
  if (params.length === 0 || samples <= 0) return 0;
  const random = mulberry32(seed);
  let wins = 0;
  for (let i = 0; i < samples; i++) {
    const dials: Record<string, number> = {};
    for (const param of params) dials[param.name] = param.min + random() * (param.max - param.min);
    try {
      if (simulate(spec, dials).won) wins++;
    } catch {
      // a sample that blows up is not a win
    }
  }
  return wins / samples;
}
