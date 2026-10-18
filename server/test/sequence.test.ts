import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  Act,
  ActSpec,
  Concept,
  Curriculum,
  GameScript,
  Mechanic,
  SequenceMechanic,
} from '@chapter-quest/shared';
import {
  applySequence,
  compile,
  completionOf,
  initialSequenceState,
  judgeSequence,
  randomWinRate,
  sequenceProblems,
  sequenceWinRate,
  simulate,
  startingOrder,
  variablesOf,
} from '@chapter-quest/shared';
import { leakedOrder } from '../src/guide.js';
import { repoRoot } from '../src/paths.js';
import { UnsupportedChapterError, routeConcepts } from '../src/routing.js';
import {
  validateRuntimeSupport,
  validateScript,
  validateSequenceMechanics,
} from '../src/validate.js';
import { toMechanic } from '../src/wire.js';
import { NoPlayableActsError, mapScenes, toWorld } from '../src/world.js';

const evaluator = { compile, variablesOf, simulate, randomWinRate };
const codes = (errors: { code: string }[]) => errors.map((e) => e.code);

const fallback = JSON.parse(
  readFileSync(join(repoRoot, 'server/fixtures/fallback-script.json'), 'utf8'),
) as GameScript;
const chapterText = readFileSync(
  join(repoRoot, 'server/scripts/fixtures/sample-chapter.md'),
  'utf8',
);

// --- a sequence act that is actually a good act ------------------------------

const RULES = [
  {
    before: 'coagulation',
    after: 'flocculation',
    why: 'Stirring only grows flocs once the particles are sticky.',
  },
  {
    before: 'flocculation',
    after: 'sedimentation',
    why: 'Only grown flocs are heavy enough to settle.',
  },
  {
    before: 'sedimentation',
    after: 'filtration',
    why: 'Settling first, or the sand clogs within hours.',
  },
  { before: 'filtration', after: 'disinfection', why: 'Particles shield microbes from chlorine.' },
];
const SOLUTION = ['coagulation', 'flocculation', 'sedimentation', 'filtration', 'disinfection'];

const treatment: SequenceMechanic = {
  type: 'sequence',
  prompt: 'Hang the stage plates in the order the water passes through them.',
  items: [
    { id: 'coagulation', label: 'Dose the coagulant' },
    { id: 'flocculation', label: 'Slow-stir the flocs' },
    { id: 'sedimentation', label: 'Let the flocs settle' },
    { id: 'filtration', label: 'Run the sand filter' },
    { id: 'disinfection', label: 'Add chlorine' },
  ],
  rules: RULES,
  initial: ['filtration', 'coagulation', 'disinfection', 'sedimentation', 'flocculation'],
  solution: SOLUTION,
};

// --- judging -------------------------------------------------------------------

test('the solution wins and the starting order loses', () => {
  assert.equal(judgeSequence(treatment, treatment.solution).won, true);
  const start = judgeSequence(treatment, treatment.initial);
  assert.equal(start.won, false);
  assert.ok(start.broken.length > 0);
  assert.equal(start.kept + start.broken.length, start.total);
});

test('any order that breaks no rule wins, not only the declared one', () => {
  // A and B are unordered relative to each other: both orders must win.
  const fork: SequenceMechanic = {
    type: 'sequence',
    prompt: 'p',
    items: ['root', 'a', 'b', 'end'].map((id) => ({ id, label: id })),
    rules: [
      { before: 'root', after: 'a', why: 'w' },
      { before: 'root', after: 'b', why: 'w' },
      { before: 'a', after: 'end', why: 'w' },
      { before: 'b', after: 'end', why: 'w' },
    ],
    initial: ['end', 'a', 'b', 'root'],
    solution: ['root', 'a', 'b', 'end'],
  };
  assert.equal(judgeSequence(fork, ['root', 'a', 'b', 'end']).won, true);
  assert.equal(judgeSequence(fork, ['root', 'b', 'a', 'end']).won, true);
  assert.equal(sequenceWinRate(fork), 2 / 24);
});

test('a broken rule is reported with its reason, earliest first', () => {
  const swapped = ['coagulation', 'flocculation', 'filtration', 'sedimentation', 'disinfection'];
  const judged = judgeSequence(treatment, swapped);
  assert.equal(judged.won, false);
  assert.equal(judged.broken.length, 1);
  assert.equal(judged.broken[0]!.why, 'Settling first, or the sand clogs within hours.');
  assert.equal(judged.kept, 3);
});

test('an order that is not a permutation of the cards never wins', () => {
  for (const order of [
    SOLUTION.slice(0, 4),
    [...SOLUTION.slice(0, 4), 'coagulation'],
    [...SOLUTION.slice(0, 4), 'boiling'],
  ]) {
    const judged = judgeSequence(treatment, order);
    assert.equal(judged.won, false);
    assert.ok(judged.invalid);
  }
});

// --- the interaction -------------------------------------------------------------

test('a player can play the act start to finish: fail, read why, fix, win, reset', () => {
  let state = initialSequenceState(treatment);
  assert.deepEqual(state.order, treatment.initial);

  state = applySequence(treatment, state, { kind: 'check' });
  assert.equal(state.last?.won, false);
  assert.equal(state.solved, false);
  assert.equal(state.checks, 1);

  // Walk each card into its place, one move at a time, as the panel's arrows do.
  for (const [index, id] of SOLUTION.entries()) {
    state = applySequence(treatment, state, { kind: 'move', id, to: index });
    assert.equal(state.last, null, 'moving a card clears the stale verdict');
  }
  assert.deepEqual(state.order, SOLUTION);

  state = applySequence(treatment, state, { kind: 'check' });
  assert.equal(state.last?.won, true);
  assert.equal(state.solved, true);

  // Reset puts the cards back but does not un-win the act: progression holds.
  state = applySequence(treatment, state, { kind: 'reset' });
  assert.deepEqual(state.order, treatment.initial);
  assert.equal(state.solved, true);
  assert.equal(state.last, null);
});

test('swap exchanges two cards; unknown ids and no-op moves change nothing', () => {
  const start = initialSequenceState(treatment);
  const swapped = applySequence(treatment, start, {
    kind: 'swap',
    a: treatment.initial[0]!,
    b: treatment.initial[1]!,
  });
  assert.deepEqual(swapped.order.slice(0, 2), [treatment.initial[1], treatment.initial[0]]);
  assert.equal(applySequence(treatment, start, { kind: 'move', id: 'boiling', to: 0 }), start);
  assert.equal(
    applySequence(treatment, start, { kind: 'swap', a: 'boiling', b: 'filtration' }),
    start,
  );
  assert.equal(
    applySequence(treatment, start, { kind: 'move', id: treatment.initial[0]!, to: 0 }),
    start,
  );
});

test('checking a wrong order never marks the act solved', () => {
  let state = initialSequenceState(treatment);
  for (let i = 0; i < 5; i++) state = applySequence(treatment, state, { kind: 'check' });
  assert.equal(state.solved, false);
});

// --- the completion condition -----------------------------------------------------

test('a sound sequence act has a reachable completion', () => {
  assert.deepEqual(sequenceProblems(treatment), []);
  const completion = completionOf({ mechanic: treatment });
  assert.equal(completion.ok, true);
});

test('a chain of five has exactly one winning order in 120', () => {
  assert.equal(sequenceWinRate(treatment), 1 / 120);
});

test('an act whose cards start solved is free and is rejected', () => {
  const free = { ...treatment, initial: SOLUTION };
  assert.ok(codes(sequenceProblems(free)).includes('starts-solved'));
  assert.equal(completionOf({ mechanic: free }).ok, false);
});

test('a cycle in the rules leaves nothing winnable and is rejected', () => {
  const cycle = {
    ...treatment,
    rules: [...RULES, { before: 'disinfection', after: 'coagulation', why: 'w' }],
  };
  assert.ok(codes(sequenceProblems(cycle)).includes('solution-loses'));
  assert.equal(sequenceWinRate(cycle), 0);
});

test('too few rules make the act guessable and are rejected', () => {
  const oneRule = {
    ...treatment,
    items: treatment.items.slice(0, 4),
    rules: [RULES[0]!],
    solution: SOLUTION.slice(0, 4),
    initial: ['flocculation', 'coagulation', 'sedimentation', 'filtration'],
  };
  const problems = codes(sequenceProblems(oneRule));
  assert.ok(problems.includes('guessable'), problems.join(','));
  assert.ok(problems.includes('unconstrained-item'));
});

test('rules that name cards that do not exist are rejected', () => {
  const ghost = {
    ...treatment,
    rules: [...RULES, { before: 'boiling', after: 'disinfection', why: 'w' }],
  };
  assert.ok(codes(sequenceProblems(ghost)).includes('unknown-item'));
});

// --- the model's wire shape -----------------------------------------------------------

test('the starting order is computed, deterministic, and always starts unsolved', () => {
  const a = startingOrder({ rules: RULES, solution: SOLUTION }, 'act2');
  const b = startingOrder({ rules: RULES, solution: SOLUTION }, 'act2');
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), [...SOLUTION].sort());
  const judged = judgeSequence(treatment, a);
  assert.ok(judged.broken.length >= Math.ceil(RULES.length / 2));

  const mechanic = toMechanic(
    {
      type: 'sequence',
      sequence: {
        prompt: treatment.prompt,
        items: treatment.items,
        rules: RULES,
        solution: SOLUTION,
      },
    },
    'act2',
  ) as SequenceMechanic;
  assert.deepEqual(mechanic.initial, a);
  assert.equal(judgeSequence(mechanic, mechanic.initial).won, false);
});

test('a model cannot choose its corpus: a generated retrieval act is always played over its own chapter', () => {
  const mechanic = toMechanic({
    type: 'ai-system',
    aiSystem: { ragAct: 'chunking', question: 'q', goldFact: 'g' },
    // Whatever arrives on the wire, the branch reads only its own fields.
    ...({ corpus: 'fixture' } as object),
  });
  assert.equal(mechanic.type === 'ai-system' && mechanic.corpus, 'chapter');
  assert.deepEqual(mechanic.type === 'ai-system' && mechanic.start, {
    chunkSize: 40,
    overlap: 0,
    k: 3,
    rerank: false,
  });
  // A lesson with nothing to measure gets no corpus at all, and stays unplayable.
  const injection = toMechanic({
    type: 'ai-system',
    aiSystem: { ragAct: 'injection', question: 'q', goldFact: 'g' },
  });
  assert.equal('corpus' in injection, false);
});

// --- completion for every mechanic kind ---------------------------------------------

test('qualitative and chapter-built retrieval acts report no completion path', () => {
  const qualitative = completionOf({
    mechanic: { type: 'qualitative', rubric: { mustShow: ['x'], misconceptions: [] } },
  });
  assert.equal(qualitative.ok, false);
  assert.equal(!qualitative.ok && qualitative.unsupported, true);

  const rag: Mechanic = { type: 'ai-system', ragAct: 'chunking', question: 'q', goldFact: 'g' };
  assert.equal(completionOf({ mechanic: rag }).ok, false);
  assert.equal(completionOf({ mechanic: { ...rag, corpus: 'fixture' } }).ok, true);
  assert.equal(completionOf({}).ok, false);
});

// --- routing ---------------------------------------------------------------------------

const concept = (id: string, kind: Concept['kind'], name = id, keyRule = 'rule'): Concept => ({
  id,
  name,
  keyRule,
  requires: [],
  difficulty: 2,
  misconceptions: [],
  kind,
  quote: 'q',
  page: 1,
});

/** The shape of the computer-vision chapter that shipped two unwinnable acts. */
const vision: Curriculum = {
  title: 'Image processing',
  subject: 'computer-vision',
  concepts: [
    concept('image-as-numbers', 'qualitative', 'An image is a grid of numbers'),
    concept('gaussian-blur', 'formula', 'Gaussian blur'),
    concept('convolution', 'ai-system', 'Convolution', 'A kernel slides over the image.'),
    concept('canny-steps', 'sequence', 'The stages of Canny edge detection'),
  ],
};

test('routing keeps playable concepts and names why the rest are not built', () => {
  const routing = routeConcepts(vision);
  assert.deepEqual(
    routing.playable.map((c) => c.id),
    ['gaussian-blur', 'canny-steps'],
  );
  const why = new Map(routing.unsupported.map((u) => [u.concept.id, u.reason]));
  assert.match(why.get('convolution')!, /not about retrieval/);
  assert.match(why.get('image-as-numbers')!, /no mechanic can judge it/);
});

test('a genuine retrieval concept is played over its own chapter; a mislabelled one is still refused', () => {
  const routing = routeConcepts({
    ...vision,
    concepts: [
      concept('top-k', 'ai-system', 'Top-k retrieval', 'More retrieved chunks is not better.'),
      concept('convolution', 'ai-system', 'Convolution', 'A kernel slides over the image.'),
    ],
  });
  assert.deepEqual(
    routing.playable.map((c) => c.id),
    ['top-k'],
  );
  assert.match(routing.unsupported[0]!.reason, /not about retrieval/);
  assert.throws(() => {
    throw new UnsupportedChapterError(routing.unsupported);
  }, /None of the 1 concept/);
});

// --- validation -------------------------------------------------------------------------

const withMechanics = (...mechanics: Mechanic[]): ActSpec[] =>
  fallback.acts.slice(0, mechanics.length).map((act, i) => ({ ...act, mechanic: mechanics[i]! }));

test('the validator rejects misrouted RAG and unplayable mechanics in a generated world', () => {
  const acts = withMechanics(
    { type: 'qualitative', rubric: { mustShow: ['x'], misconceptions: [] } },
    { type: 'ai-system', ragAct: 'grounding', question: 'q', goldFact: 'g' },
    treatment,
  );
  const curriculum: Curriculum = {
    ...fallback.curriculum,
    concepts: fallback.curriculum.concepts.map((c) =>
      c.id === acts[1]!.conceptId
        ? { ...c, name: 'Edge maps', keyRule: 'Hysteresis links weak edges.', quote: 'q' }
        : c,
    ),
  };
  const errors = validateRuntimeSupport(curriculum, acts).errors;
  assert.deepEqual(codes(errors), ['unsupported-mechanic', 'misrouted-rag']);
  assert.deepEqual(validateSequenceMechanics(acts).errors, []);
});

test('the prepared Oracle world still validates: its retrieval is the fixture table', () => {
  assert.deepEqual(validateScript({ script: fallback, chapterText, evaluator }).errors, []);
});

// --- the world the player gets -----------------------------------------------------------

test('acts with no completion path are left out of the world and named, never shipped locked', () => {
  const acts = withMechanics(
    { type: 'qualitative', rubric: { mustShow: ['x'], misconceptions: [] } },
    { ...treatment },
    { type: 'ai-system', ragAct: 'grounding', question: 'q', goldFact: 'g' },
  );
  const script = { ...fallback, acts };
  const world = toWorld(script, mapScenes(script));
  assert.deepEqual(
    world.acts.map((a) => a.id),
    [acts[1]!.id],
  );
  assert.deepEqual(
    world.omitted?.map((o) => o.actId),
    [acts[0]!.id, acts[2]!.id],
  );
  for (const omitted of world.omitted ?? []) assert.ok(omitted.reason.length > 0);

  const played = world.acts[0] as Act;
  assert.equal(played.mechanic?.type, 'sequence');
  assert.equal(completionOf(played).ok, true);
  assert.ok(played.objective, 'the concept key rule travels with the act');
  assert.match(played.steps?.[0] ?? '', /press E/);
});

test('a world in which nothing can be finished is refused, not served', () => {
  const acts = withMechanics({
    type: 'qualitative',
    rubric: { mustShow: ['x'], misconceptions: [] },
  });
  const script = { ...fallback, acts };
  assert.throws(() => toWorld(script, mapScenes(script)), NoPlayableActsError);
});

// --- the guide does not recite the order ----------------------------------------------------

test('the guide may explain one link but not walk through the winning order', () => {
  const act = { mechanic: treatment } as Act;
  assert.equal(
    leakedOrder(
      'Dose the coagulant, then slow-stir the flocs, then let the flocs settle.',
      act,
      false,
    ),
    true,
  );
  assert.equal(
    leakedOrder(
      'Ask yourself whether the sand filter could cope with water that has not had time to let the flocs settle.',
      act,
      false,
    ),
    false,
  );
  assert.equal(
    leakedOrder(
      'Dose the coagulant, then slow-stir the flocs, then let the flocs settle.',
      act,
      true,
    ),
    false,
  );
});
