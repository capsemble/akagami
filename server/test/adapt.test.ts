/**
 * Adaptation. The diagnosis and every guard are deterministic and tested
 * here; the model's choices are replaced by a scripted asker, so these tests
 * prove what is done with a reply — never that a real model replies well.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  Act,
  Character,
  EvidenceMechanic,
  SequenceMechanic,
  SimSpec,
} from '@chapter-quest/shared';
import type { AdaptAsker, AdaptContext, AdaptReply, AdaptRequest } from '../src/adapt.js';
import { adapt, diagnose, leakedPairing, readAdaptRequest } from '../src/adapt.js';

const person = (id: string, name: string): Character => ({
  id,
  name,
  persona: 'p',
  portraits: { neutral: 'n', pleased: 'p', worried: 'w' },
  sprite: 's',
});
const GUIDE = person('meera', 'Dr. Meera');
const VYAS = person('vyas', 'Pandit Vyas');

const order: SequenceMechanic = {
  type: 'sequence',
  prompt: 'Order it.',
  items: [
    { id: 'tx', label: 'Transcribe the gene' },
    { id: 'proc', label: 'Process the pre-mRNA' },
    { id: 'exp', label: 'Export the mRNA' },
    { id: 'tl', label: 'Translate at the ribosome' },
  ],
  rules: [
    {
      before: 'tx',
      after: 'proc',
      why: 'there is no pre-mRNA to process until it is transcribed.',
    },
    { before: 'proc', after: 'exp', why: 'only mature mRNA leaves the nucleus.' },
    { before: 'exp', after: 'tl', why: 'ribosomes are in the cytoplasm.' },
  ],
  initial: ['tl', 'exp', 'proc', 'tx'],
  solution: ['tx', 'proc', 'exp', 'tl'],
};

const actWith = (mechanic: Act['mechanic'], extra: Partial<Act> = {}): Act => ({
  id: 'act1',
  conceptId: 'c',
  title: 'The Chart',
  goal: 'Order the steps.',
  verbs: ['arrange'],
  sceneId: 's',
  explainAfter: 'e',
  ...(mechanic ? { mechanic } : {}),
  ...extra,
});

const ctxFor = (act: Act, cast: Character[] = [GUIDE, VYAS]): AdaptContext => ({
  act,
  guide: GUIDE,
  cast,
  misconceptions: [
    { text: 'DNA is read directly by the ribosome.', owner: { id: 'vyas', name: 'Pandit Vyas' } },
    { text: 'Introns are translated and cut out of the protein later.' },
  ],
});

const request = (attempt: AdaptRequest['attempt'], failures = 1): AdaptRequest => ({
  worldId: 'world-x',
  actId: 'act1',
  attempt,
  failures,
});

const scripted = (
  ...replies: (Partial<AdaptReply> | Error)[]
): AdaptAsker & { prompts: string[] } => {
  const prompts: string[] = [];
  const ask = (async (prompt: string) => {
    prompts.push(prompt);
    const next = replies.shift() ?? {};
    if (next instanceof Error) throw next;
    return {
      misconceptionIndex: 0,
      because: 'They put translation first.',
      technique: 'contrast',
      voiceLine: 'Skip the copying, the ribosome reads the DNA itself!',
      message: 'Where are the ribosomes, and what is the only thing that reaches them?',
      ...next,
    } as AdaptReply;
  }) as AdaptAsker & { prompts: string[] };
  ask.prompts = prompts;
  return ask;
};

// --- the request ----------------------------------------------------------------------

test('a request is validated and capped; anything else is refused', () => {
  assert.equal(readAdaptRequest(null), null);
  assert.equal(readAdaptRequest({ worldId: 'w', actId: 'a', attempt: { kind: 'poem' } }), null);
  assert.equal(
    readAdaptRequest({ worldId: '../etc', actId: 'a', attempt: { kind: 'sequence', order: [] } }),
    null,
  );
  const ok = readAdaptRequest({
    worldId: 'world-1',
    actId: 'act1',
    failures: 999,
    attempt: {
      kind: 'formula',
      settings: { pull: 3, 'bad key!': 4, x: 'nan' },
      outputs: { stop: 12 },
    },
  });
  assert.deepEqual(ok, {
    worldId: 'world-1',
    actId: 'act1',
    failures: 20,
    attempt: { kind: 'formula', settings: { pull: 3 }, outputs: { stop: 12 } },
  });
});

// --- the diagnosis is computed, from the act ----------------------------------------------

test('a sequence attempt is re-judged from the act, and the fallback names the broken link', () => {
  const act = actWith(order);
  const d = diagnose(act, { kind: 'sequence', order: ['tl', 'tx', 'proc', 'exp'] });
  assert.ok(d.facts.some((f) => f.includes('2 of 3 ordering rules hold')));
  assert.ok(d.facts.some((f) => f.includes('ribosomes are in the cytoplasm')));
  assert.match(d.fallback, /Export the mRNA.*Translate at the ribosome/);
});

const exam: EvidenceMechanic = {
  type: 'evidence',
  prompt: 'Pin them.',
  claims: [
    { id: 'belgium', text: 'Britain entered the war because Germany invaded neutral Belgium.' },
    { id: 'cheque', text: 'German backing made the ultimatum possible.' },
  ],
  evidence: [
    {
      id: 'london',
      title: 'Treaty of London',
      excerpt: 'x',
      shows: 'Britain had guaranteed Belgian neutrality.',
    },
    {
      id: 'vienna',
      title: 'Vienna cable',
      excerpt: 'y',
      shows: 'Vienna acted confident of German backing.',
    },
    {
      id: 'sarajevo',
      title: 'Sarajevo report',
      excerpt: 'z',
      shows: 'Who killed the Archduke, and where.',
    },
  ],
  links: [
    { claim: 'belgium', evidence: 'london', why: 'w' },
    { claim: 'cheque', evidence: 'vienna', why: 'w' },
  ],
};

test('an evidence attempt is re-judged, and the fallback explains the wrong document by what it shows', () => {
  const d = diagnose(actWith(exam), {
    kind: 'evidence',
    pins: { sarajevo: 'belgium', vienna: 'cheque' },
  });
  assert.ok(d.facts.some((f) => f.includes('1 of 2 claims are backed')));
  assert.match(d.fallback, /Sarajevo report.*Who killed the Archduke/);
  assert.doesNotMatch(
    d.fallback,
    /Treaty of London/,
    'the fallback never names the right document',
  );
});

const braking: SimSpec = {
  constants: { u0: 22, brakeRate: 1.6, sidingEnd: 180 },
  state: { x: '0', v: 'u0' },
  step: { v: 'v - brakeRate * dt', x: 'x + v * dt' },
  outputs: { stopX: 'flagPosition + x' },
  win: 'stopX <= sidingEnd && stopX >= sidingEnd - 12',
  dt: 0.05,
  maxTime: 40,
  until: 'v <= 0',
};

test('a formula attempt is read with the miss and the measured direction of each dial', () => {
  const act = actWith(
    {
      type: 'formula',
      spec: braking,
      params: [{ name: 'flagPosition', min: 0, max: 60, default: 5, solution: 22 }],
    },
    { stage: { bindings: [], readout: { output: 'stopX', label: 'stopped at', unit: 'm' } } },
  );
  const d = diagnose(act, {
    kind: 'formula',
    settings: { flagPosition: 50 },
    outputs: { stopX: 201.3 },
  });
  assert.ok(
    d.facts.some((f) => /past the winning span/.test(f)),
    d.facts.join(' | '),
  );
  assert.ok(d.facts.some((f) => /more flag position makes stop x larger/.test(f)));
  assert.match(d.fallback, /201\.3 m/);
});

// --- the model chooses, within bounds -----------------------------------------------------

test('the chosen misconception is verbatim from the list, voiced by the cast member who owns it', async () => {
  const act = actWith(order);
  const move = await adapt(
    ctxFor(act),
    request({ kind: 'sequence', order: ['tl', 'tx', 'proc', 'exp'] }),
    scripted({}),
  );
  assert.equal(move.misconception, 'DNA is read directly by the ribosome.');
  assert.equal(move.voice?.characterId, 'vyas');
  assert.equal(move.speakerId, 'meera');
  assert.equal(move.offline, undefined);
});

test('a misconception with no owner gets no voice, and an invented index gets no misconception', async () => {
  const act = actWith(order);
  const unowned = await adapt(
    ctxFor(act),
    request({ kind: 'sequence', order: order.initial }),
    scripted({ misconceptionIndex: 1 }),
  );
  assert.equal(unowned.misconception, 'Introns are translated and cut out of the protein later.');
  assert.equal(unowned.voice, undefined);

  const invented = await adapt(
    ctxFor(act),
    request({ kind: 'sequence', order: order.initial }),
    scripted({ misconceptionIndex: 7 }),
  );
  assert.equal(invented.misconception, undefined);
  assert.equal(invented.voice, undefined);
  assert.ok(invented.message, 'the teaching move still lands');
});

test('an owner who is not in this world’s cast cannot walk in', async () => {
  const act = actWith(order);
  const move = await adapt(
    ctxFor(act, [GUIDE]),
    request({ kind: 'sequence', order: order.initial }),
    scripted({}),
  );
  assert.equal(move.voice, undefined);
});

test('a reply that recites the winning order is asked again, then replaced by the computed correction', async () => {
  const act = actWith(order);
  const recited = {
    message: 'Transcribe the gene, then process the pre-mRNA, then export the mRNA.',
  };
  const once = scripted(recited, {});
  const fixed = await adapt(ctxFor(act), request({ kind: 'sequence', order: order.initial }), once);
  assert.equal(once.prompts.length, 2);
  assert.equal(fixed.offline, undefined);

  const twice = scripted(recited, recited);
  const fallback = await adapt(
    ctxFor(act),
    request({ kind: 'sequence', order: order.initial }),
    twice,
  );
  assert.equal(fallback.offline, true);
  assert.doesNotMatch(fallback.message, /then process the pre-mRNA, then export/);
});

test('a reply that names a document with the claim it proves is a leaked pairing', () => {
  const act = actWith(exam);
  assert.equal(
    leakedPairing(
      'The Treaty of London shows Britain entered because Germany invaded neutral Belgium.',
      act,
    ),
    true,
  );
  assert.equal(
    leakedPairing('Read the Treaty of London slowly. What did Britain promise?', act),
    false,
  );
});

test('no model, no problem: the player still gets the computed correction, flagged offline', async () => {
  const act = actWith(order);
  const move = await adapt(
    ctxFor(act),
    request({ kind: 'sequence', order: ['tl', 'tx', 'proc', 'exp'] }),
    scripted(new Error('503')),
  );
  assert.equal(move.offline, true);
  assert.equal(move.speaker, 'Dr. Meera');
  assert.match(move.message, /ribosomes are in the cytoplasm/);
});

test('the prompt shows the model only computed facts and the numbered list', async () => {
  const act = actWith(order);
  const ask = scripted({});
  await adapt(
    ctxFor(act),
    request({ kind: 'sequence', order: ['tl', 'tx', 'proc', 'exp'] }, 3),
    ask,
  );
  assert.match(
    ask.prompts[0]!,
    /0\. DNA is read directly by the ribosome\. \(OWNER: Pandit Vyas\)/,
  );
  assert.match(ask.prompts[0]!, /failure number 3/);
  assert.match(ask.prompts[0]!, /2 of 3 ordering rules hold/);
});

test('a paraphrased walk through the winning order is still a leak', async () => {
  const chain: SequenceMechanic = {
    type: 'sequence',
    prompt: 'p',
    items: [
      { id: 'dna', label: 'DNA provides genetic template' },
      { id: 'tx', label: 'Transcription produces pre-mRNA' },
      { id: 'proc', label: 'RNA processing makes mature mRNA' },
      { id: 'exp', label: 'Export mature mRNA to cytoplasm' },
      { id: 'tl', label: 'Ribosomes translate mRNA into polypeptide' },
      { id: 'fold', label: 'Polypeptide folds and modifies' },
    ],
    rules: [],
    initial: [],
    solution: ['dna', 'tx', 'proc', 'exp', 'tl', 'fold'],
  };
  const act = actWith(chain);
  // The reply a real model gave on a real miss: never a label, every step.
  const paraphrase =
    'The DNA template must first be transcribed into pre-mRNA, which is then processed inside the nucleus before being exported to the cytoplasm for translation and folding.';
  const { leakedOrder } = await import('../src/guide.js');
  assert.equal(leakedOrder(paraphrase, act, false), true);
  assert.equal(
    leakedOrder(
      'Where do ribosomes live, and can anything reach them before it has been exported?',
      act,
      false,
    ),
    false,
    'naming two cards to teach the link between them is not the answer',
  );
});

test('an ordering act never gets a worked example: it is the answer in costume', async () => {
  const act = actWith(order);
  const systems: string[] = [];
  const inner = scripted({ technique: 'worked_example' }, { technique: 'worked_example' });
  const ask: AdaptAsker = (prompt, system) => {
    systems.push(system);
    return inner(prompt, system);
  };
  const move = await adapt(
    ctxFor(act),
    request({ kind: 'sequence', order: order.initial }, 3),
    ask,
  );
  assert.equal(inner.prompts.length, 2, 'asked once more, then given up on');
  assert.equal(move.offline, true);
  assert.match(systems[0]!, /NEVER use worked_example/);
});
