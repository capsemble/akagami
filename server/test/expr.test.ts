import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compile, evaluate, randomWinRate, simulate, variablesOf } from '@chapter-quest/shared';
import type { SimSpec } from '@chapter-quest/shared';

test('arithmetic, precedence and parentheses', () => {
  assert.equal(evaluate('2 + 3 * 4', {}), 14);
  assert.equal(evaluate('(2 + 3) * 4', {}), 20);
  assert.equal(evaluate('10 / 4', {}), 2.5);
  assert.equal(evaluate('-3 + 1', {}), -2);
  assert.equal(evaluate('2 - -3', {}), 5);
  assert.equal(evaluate('u * u / (2 * a)', { u: 22, a: 1.6 }), (22 * 22) / 3.2);
});

test('comparisons and boolean operators yield 1 or 0', () => {
  assert.equal(evaluate('3 > 2', {}), 1);
  assert.equal(evaluate('3 < 2', {}), 0);
  assert.equal(evaluate('x >= 10 && x <= 20', { x: 15 }), 1);
  assert.equal(evaluate('x >= 10 && x <= 20', { x: 25 }), 0);
  assert.equal(evaluate('x < 0 || x > 100', { x: 150 }), 1);
  assert.equal(evaluate('a == b', { a: 2, b: 2 }), 1);
  assert.equal(evaluate('a != b', { a: 2, b: 2 }), 0);
});

test('booleans in scope are read as 1 and 0', () => {
  assert.equal(evaluate('rerank && k <= 3', { rerank: true, k: 3 }), 1);
  assert.equal(evaluate('rerank && k <= 3', { rerank: false, k: 3 }), 0);
});

test('variablesOf reports free variables and nothing else', () => {
  assert.deepEqual(variablesOf('x + y * 2 - x'), ['x', 'y']);
  assert.deepEqual(variablesOf('3 * 4'), []);
});

test('bad syntax throws rather than guessing', () => {
  assert.throws(() => compile('2 +'), /unexpected end/);
  assert.throws(() => compile('(2 + 3'), /unexpected end/);
  assert.throws(() => compile('2 ** 3'), /unexpected/);
  assert.throws(() => compile('x $ y'), /unexpected character/);
  assert.throws(() => compile(''), /empty expression/);
  assert.throws(() => compile('2 3'), /unexpected "3"/);
});

test('an unknown variable throws, naming itself', () => {
  assert.throws(() => evaluate('a + weather', { a: 1 }), /unknown variable "weather"/);
});

test('no code from an expression can escape into the host', () => {
  // These are the shapes a prompt-injected "expression" would try.
  for (const hostile of [
    'constructor',
    'process.exit(1)',
    'globalThis',
    '__proto__',
    'require("fs")',
  ]) {
    assert.throws(
      () => evaluate(hostile, {}),
      /unknown variable|unexpected/,
      `"${hostile}" must not evaluate`,
    );
  }
});

test('compiling the same source twice returns the cached expression', () => {
  assert.equal(compile('a + b'), compile('a + b'));
});

// --- the simulator ---------------------------------------------------------

const freefall: SimSpec = {
  constants: { g: 10 },
  state: { y: 'h0', v: '0' },
  step: { y: 'y - v * dt', v: 'v + g * dt' },
  outputs: { fallTime: 'elapsed' },
  win: 'y <= 0',
  dt: 0.001,
  maxTime: 10,
  until: 'y <= 0',
};

test('state initialisers see params and earlier state', () => {
  const spec: SimSpec = {
    constants: { k: 3 },
    state: { a: 'p * 2', b: 'a + k' },
    step: {},
    outputs: { total: 'a + b' },
    win: 'total > 0',
    dt: 1,
    maxTime: 0,
  };
  const result = simulate(spec, { p: 5 });
  assert.equal(result.state.a, 10);
  assert.equal(result.state.b, 13);
  assert.equal(result.outputs.total, 23);
});

test('step updates are simultaneous, so their order cannot change the physics', () => {
  const forward: SimSpec = {
    constants: {},
    state: { a: '1', b: '1' },
    step: { a: 'b', b: 'a' },
    outputs: {},
    win: 'a == b',
    dt: 1,
    maxTime: 1,
  };
  const swapped: SimSpec = { ...forward, step: { b: 'a', a: 'b' } };
  const one = simulate(forward, {});
  const two = simulate(swapped, {});
  assert.deepEqual(one.state, two.state);
});

test('until stops the run early', () => {
  const result = simulate({ ...freefall, outputs: {} }, { h0: 5 });
  assert.ok(result.time > 0.9 && result.time < 1.1, `fell for ${result.time}s, expected ~1s`);
  assert.ok(result.steps < Math.ceil(freefall.maxTime / freefall.dt));
});

test('a spec that never settles is capped, not hung', () => {
  assert.throws(
    () => simulate({ ...freefall, dt: 0.0000001, maxTime: 1000, until: undefined }, { h0: 5 }),
    /steps requested/,
  );
});

test('a state that blows up is an error, not a silent result', () => {
  const runaway: SimSpec = {
    constants: {},
    state: { x: '1' },
    step: { x: 'x / 0' },
    outputs: {},
    win: 'x > 0',
    dt: 1,
    maxTime: 3,
  };
  assert.throws(() => simulate(runaway, {}), /became Infinity/);
});

test('outputs are visible to later outputs and to win', () => {
  const spec: SimSpec = {
    constants: { d: 6, t: 10 },
    state: {},
    step: {},
    outputs: { speed: 'd * 60 / t', fast: 'speed > 25' },
    win: 'fast',
    dt: 1,
    maxTime: 0,
  };
  const result = simulate(spec, {});
  assert.equal(result.outputs.speed, 36);
  assert.equal(result.outputs.fast, 1);
  assert.equal(result.won, true);
});

test('randomWinRate is deterministic for a given seed', () => {
  const spec: SimSpec = {
    constants: {},
    state: {},
    step: {},
    outputs: { v: 'dial' },
    win: 'v > 50',
    dt: 1,
    maxTime: 0,
  };
  const params = [{ name: 'dial', min: 0, max: 100, default: 0, solution: 80 }];
  const a = randomWinRate(spec, params, 500, 7);
  const b = randomWinRate(spec, params, 500, 7);
  assert.equal(a, b);
  assert.ok(a > 0.4 && a < 0.6, `half the range should win, got ${a}`);
});

/**
 * Regression: a frame is shorter than a step (16 ms against 50 ms), so flooring
 * elapsed time per call gave zero steps every frame and a driven run sat still.
 */
test('advance carries leftover time instead of dropping it', async () => {
  const { Run } = await import('@chapter-quest/shared');
  const spec = {
    constants: {},
    state: { x: '0' },
    step: { x: 'x + dt' },
    outputs: {},
    win: 'x > 0',
    dt: 0.05,
    maxTime: 10,
  };

  const run = new Run(spec, {});
  let steps = 0;
  for (let frame = 0; frame < 60; frame++) steps += run.advance(1 / 60);
  assert.equal(steps, 20, 'one second at dt=0.05 is twenty steps, whatever the frame rate');
  assert.ok(Math.abs((run.scope.x as number) - 1) < 1e-9, 'and one second of simulated time');
});
