import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyFailure, retryPlan } from '../src/gemini.js';

/**
 * Regression: a design run on a fresh chapter died mid-writers'-room on a 503
 * that would have cleared. Overload and quota were treated as one failure with
 * four attempts and ~3.5s of total backoff — far too impatient for a capacity
 * spike, and pointless patience for a spent daily quota.
 */
test('a capacity spike and a spent quota are not the same failure', () => {
  const overload = {
    error: { code: 503, message: 'This model is currently experiencing high demand.' },
  };
  assert.equal(classifyFailure({ code: 503, message: JSON.stringify(overload) }), 'overload');
  assert.equal(classifyFailure({ message: '503 UNAVAILABLE' }), 'overload');
  assert.equal(classifyFailure({ status: 502 }), 'overload');

  assert.equal(classifyFailure({ code: 429, message: 'You exceeded your current quota' }), 'quota');
  assert.equal(classifyFailure({ message: 'RESOURCE_EXHAUSTED' }), 'quota');

  assert.equal(classifyFailure({ code: 404, message: 'model not found' }), 'fatal');
  assert.equal(classifyFailure(new Error('bad prompt')), 'fatal');
});

test('an overloaded model is waited out; a spent quota is handed over', () => {
  const total = (kind: 'overload' | 'quota') => {
    let ms = 0;
    let tries = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const plan = retryPlan(kind, attempt);
      if (!plan.retry) break;
      ms += plan.waitMs;
      tries++;
    }
    return { ms, tries };
  };

  const overload = total('overload');
  assert.ok(overload.tries >= 5, `overload gives up after ${overload.tries} tries`);
  assert.ok(
    overload.ms >= 25_000,
    `only ${overload.ms}ms of patience for a spike that lasts longer`,
  );

  const quota = total('quota');
  assert.ok(quota.tries <= 1, 'a daily quota will not clear while we wait');
  assert.ok(quota.ms < 2_000, 'waiting on quota just delays the fallback model');

  assert.equal(retryPlan('fatal', 0).retry, false);
});
