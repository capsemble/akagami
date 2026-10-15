/**
 * A TEST DOUBLE for shared/expr.ts, not a replacement for it.
 *
 * The real evaluator is Hrutik's and lands separately; these tests check that
 * validate.ts draws the right conclusions from an evaluator's answers, which
 * needs something that genuinely evaluates. It is a small recursive-descent
 * parser over the subset the prompts allow: numbers, names, + - * / ( ),
 * comparisons, && and ||.
 *
 * When the real expr.ts lands, point these tests at it and delete this file.
 */
import type { ParamSpec, SimSpec } from '@chapter-quest/shared';
import type { Evaluator, SimResult } from '../src/evaluator.js';

type Token = string;

const tokenCache = new Map<string, Token[]>();

function tokenize(src: string): Token[] {
  const hit = tokenCache.get(src);
  if (hit) return hit;
  const tokens = src.match(/\d+\.?\d*|[A-Za-z_]\w*|<=|>=|==|!=|&&|\|\||[-+*/()<>]/g);
  if (!tokens) throw new Error(`cannot tokenize: ${src}`);
  if (tokens.join('').length !== src.replace(/\s+/g, '').length) {
    throw new Error(`unexpected characters in: ${src}`);
  }
  tokenCache.set(src, tokens);
  return tokens;
}

class Parser {
  private at = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly scope: Record<string, number>,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }
  private take(): Token {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new Error('unexpected end of expression');
    return token;
  }

  parse(): number {
    const value = this.or();
    if (this.at !== this.tokens.length) throw new Error(`trailing tokens in expression`);
    return value;
  }

  private or(): number {
    let left = this.and();
    while (this.peek() === '||') {
      this.take();
      const right = this.and();
      left = left || right ? 1 : 0;
    }
    return left;
  }

  private and(): number {
    let left = this.comparison();
    while (this.peek() === '&&') {
      this.take();
      const right = this.comparison();
      left = left && right ? 1 : 0;
    }
    return left;
  }

  private comparison(): number {
    let left = this.sum();
    while (['<', '<=', '>', '>=', '==', '!='].includes(this.peek() ?? '')) {
      const op = this.take();
      const right = this.sum();
      const value =
        op === '<'
          ? left < right
          : op === '<='
            ? left <= right
            : op === '>'
              ? left > right
              : op === '>='
                ? left >= right
                : op === '=='
                  ? left === right
                  : left !== right;
      left = value ? 1 : 0;
    }
    return left;
  }

  private sum(): number {
    let left = this.product();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.take();
      const right = this.product();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  private product(): number {
    let left = this.unary();
    while (this.peek() === '*' || this.peek() === '/') {
      const op = this.take();
      const right = this.unary();
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  private unary(): number {
    if (this.peek() === '-') {
      this.take();
      return -this.unary();
    }
    return this.atom();
  }

  private atom(): number {
    const token = this.take();
    if (token === '(') {
      const value = this.or();
      if (this.take() !== ')') throw new Error('missing )');
      return value;
    }
    if (/^\d/.test(token)) return Number(token);
    if (!(token in this.scope)) throw new Error(`unknown variable "${token}"`);
    return this.scope[token] as number;
  }
}

function evaluate(src: string, scope: Record<string, number>): number {
  return new Parser(tokenize(src), scope).parse();
}

/** Deterministic so a failing win-rate test fails every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runSim(spec: SimSpec, params: Record<string, number>): SimResult {
  const scope: Record<string, number> = { ...spec.constants, ...params };

  for (const [name, expr] of Object.entries(spec.state)) {
    scope[name] = evaluate(expr, scope);
  }

  scope.dt = spec.dt;
  const stepEntries = Object.entries(spec.step);
  const steps = spec.dt > 0 ? Math.ceil(spec.maxTime / spec.dt) : 0;
  const next = new Array<number>(stepEntries.length);
  for (let i = 0; i < steps; i++) {
    if (spec.until && evaluate(spec.until, scope)) break;
    for (let j = 0; j < stepEntries.length; j++) {
      next[j] = evaluate(stepEntries[j]![1], scope);
    }
    for (let j = 0; j < stepEntries.length; j++) {
      scope[stepEntries[j]![0]] = next[j] as number;
    }
  }

  const outputs: Record<string, number> = {};
  for (const [name, expr] of Object.entries(spec.outputs)) {
    outputs[name] = evaluate(expr, scope);
    scope[name] = outputs[name];
  }

  return { won: Boolean(evaluate(spec.win, scope)), outputs };
}

export const fakeEvaluator: Evaluator = {
  compile(src) {
    return tokenize(src);
  },
  variablesOf(src) {
    return [...new Set(tokenize(src).filter((t) => /^[A-Za-z_]/.test(t)))];
  },
  simulate: runSim,
  randomWinRate(spec: SimSpec, params: ParamSpec[], samples = 200, seed = 1) {
    const random = mulberry32(seed);
    let wins = 0;
    for (let i = 0; i < samples; i++) {
      const dials = Object.fromEntries(
        params.map((p) => [p.name, p.min + random() * (p.max - p.min)]),
      );
      try {
        if (runSim(spec, dials).won) wins++;
      } catch {
        // a throwing sample counts as a loss
      }
    }
    return wins / samples;
  },
};
