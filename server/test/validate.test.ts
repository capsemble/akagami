import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActSpec, Curriculum, GameScript, Outline, SimSpec } from '@chapter-quest/shared';
import { repoRoot } from '../src/paths.js';
import {
  validateAiSystemMechanics,
  validateContent,
  validateFormulaMechanics,
  validateGrounding,
  validateScript,
  validateStructure,
} from '../src/validate.js';
import { compile, randomWinRate, simulate, variablesOf } from '@chapter-quest/shared';

/** The real evaluator, shaped to the interface validate.ts consumes. */
const evaluator = { compile, variablesOf, simulate, randomWinRate };

const chapterText = readFileSync(
  join(repoRoot, 'server/scripts/fixtures/sample-chapter.md'),
  'utf8',
);

const fallback = JSON.parse(
  readFileSync(join(repoRoot, 'server/fixtures/fallback-script.json'), 'utf8'),
) as GameScript;

const codes = (errors: { code: string }[]) => errors.map((e) => e.code);

// --- a formula act that is actually a good act ------------------------------

/** Braking: the train coasts to the marker, then decelerates. Narrow win band. */
const brakingSpec: SimSpec = {
  constants: { u0: 22, brakeRate: 1.6, sidingEnd: 180 },
  state: { x: '0', v: 'u0' },
  step: { v: 'v - brakeRate * dt', x: 'x + v * dt' },
  outputs: { stopX: 'flagPosition + x' },
  win: 'stopX <= sidingEnd && stopX >= sidingEnd - 12',
  dt: 0.05,
  maxTime: 40,
  until: 'v <= 0',
};

function formulaAct(overrides: Partial<ActSpec> = {}): ActSpec {
  return {
    id: 'act1',
    conceptId: 'braking',
    title: 'The Runaway',
    goal: 'Plant the brake marker, then drive.',
    verbs: ['plant_marker', 'drive'],
    prediction: {
      question: 'Move the marker 10 m down the grade. The stopping distance…',
      options: ['Shrinks', 'Stays the same', 'Grows'],
      correctIndex: 1,
    },
    explainAfter: 'Stopping distance depends on speed and braking, not on where braking starts.',
    analogy: {
      text: 'The marker is a diving board.',
      breaksWhere: 'A diver leaves the board once; a train brakes the whole way.',
    },
    dialogue: [{ speaker: 'Inspector Rane', line: 'The siding ends at the water tank.' }],
    scene: {
      name: 'Falling Grade',
      description: 'A wet descending track.',
      objects: [{ id: 'marker-spike', label: 'Brake marker', look: 'Red-topped iron spike.' }],
      exitSide: 'east',
    },
    mechanic: {
      type: 'formula',
      spec: brakingSpec,
      params: [{ name: 'flagPosition', min: 0, max: 60, default: 5, solution: 22 }],
    },
    ...overrides,
  };
}

function formulaCurriculum(): Curriculum {
  return {
    title: 'Kinematics',
    subject: 'physics',
    concepts: [
      {
        id: 'braking',
        name: 'Braking distance',
        keyRule: 'Stopping distance grows with the square of speed.',
        requires: [],
        difficulty: 3,
        misconceptions: ['Braking earlier shortens the stopping distance'],
        kind: 'formula',
        quote: 'placeholder',
        page: 1,
      },
    ],
  };
}

function formulaOutline(): Outline {
  return {
    title: 'The Ghost of Ghat 9',
    logline: 'A bandit robs the monsoon mail train.',
    artStyle: '1950s hill railway.',
    villain: 'Station Master Dalvi',
    twist: 'The timetable is forged.',
    cast: [
      { id: 'inspector', name: 'Inspector Rane', look: 'Soaked khaki coat.', persona: 'Patient.' },
    ],
    acts: [
      {
        id: 'act1',
        conceptId: 'braking',
        title: 'The Runaway',
        sceneName: 'Falling Grade',
        oneLine: 'Stop the train inside the siding.',
      },
    ],
  };
}

test('a good formula act passes', () => {
  const result = validateFormulaMechanics([formulaAct()], evaluator);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});

test('a guessable act is rejected', () => {
  // A win band covering most of the marker's range: ~65% of random positions win.
  const act = formulaAct({
    mechanic: {
      type: 'formula',
      spec: { ...brakingSpec, win: 'stopX <= sidingEnd + 10' },
      params: [{ name: 'flagPosition', min: 0, max: 60, default: 5, solution: 22 }],
    },
  });
  const result = validateFormulaMechanics([act], evaluator);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('guessable'));
  assert.match(result.errors.find((e) => e.code === 'guessable')!.message, /guessable \(\d+%\)/);
});

test('an act whose solution does not win is rejected', () => {
  const act = formulaAct({
    mechanic: {
      type: 'formula',
      spec: brakingSpec,
      // 55 overshoots the siding, so the declared solution loses.
      params: [{ name: 'flagPosition', min: 0, max: 60, default: 5, solution: 55 }],
    },
  });
  const result = validateFormulaMechanics([act], evaluator);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('solution-does-not-win'));
});

test('an act that is already solved at its default is rejected', () => {
  const act = formulaAct({
    mechanic: {
      type: 'formula',
      spec: brakingSpec,
      params: [{ name: 'flagPosition', min: 0, max: 60, default: 22, solution: 22 }],
    },
  });
  const result = validateFormulaMechanics([act], evaluator);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('default-already-wins'));
});

test('an expression referencing an unknown variable is rejected', () => {
  const act = formulaAct({
    mechanic: {
      type: 'formula',
      spec: { ...brakingSpec, win: 'stopX <= sidingEnd && weather > 2' },
      params: [{ name: 'flagPosition', min: 0, max: 60, default: 5, solution: 22 }],
    },
  });
  const result = validateFormulaMechanics([act], evaluator);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('unknown-variable'));
});

test('formula checks are skipped, not failed, when the evaluator is absent', () => {
  const result = validateFormulaMechanics([formulaAct()], null);
  assert.equal(result.ok, true);
});

// --- grounding --------------------------------------------------------------

test('an invented quote is rejected', () => {
  const curriculum: Curriculum = {
    title: 'RAG',
    subject: 'machine-learning',
    concepts: [
      {
        ...fallback.curriculum.concepts[0]!,
        quote: 'Chunking is the process by which documents are thoughtfully subdivided.',
      },
    ],
  };
  const result = validateGrounding(curriculum, chapterText);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.errors), ['invented-concept']);
  assert.equal(result.errors[0]!.path, 'curriculum.concepts[0].quote');
});

test('a verbatim quote passes, including across a line break and odd quote marks', () => {
  const curriculum: Curriculum = {
    title: 'RAG',
    subject: 'machine-learning',
    concepts: [
      {
        ...fallback.curriculum.concepts[0]!,
        // Spans a newline in the source and uses a curly apostrophe.
        quote: 'the useful question is not “what size is best” but',
      },
    ],
  };
  assert.equal(validateGrounding(curriculum, chapterText).ok, true);
});

// --- content ----------------------------------------------------------------

test('a missing breaksWhere is rejected', () => {
  const act = formulaAct({
    analogy: { text: 'The marker is a diving board.', breaksWhere: '   ' },
  });
  const result = validateContent(formulaCurriculum(), [act]);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('analogy-has-no-edge'));
  assert.equal(result.errors[0]!.path, 'acts[0].analogy.breaksWhere');
});

test('a banned quantum claim is rejected', () => {
  const curriculum: Curriculum = { ...formulaCurriculum(), subject: 'quantum physics' };
  const act = formulaAct({
    explainAfter: 'The particle stays undecided until consciousness causes the collapse.',
  });
  const result = validateContent(curriculum, [act]);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('banned-claim'));
});

test('banned claims for another subject do not fire', () => {
  const act = formulaAct({
    explainAfter: 'The particle stays undecided until consciousness causes the collapse.',
  });
  assert.equal(validateContent(formulaCurriculum(), [act]).ok, true);
});

// --- structure --------------------------------------------------------------

test('an act pointing at a concept that does not exist is rejected', () => {
  const result = validateStructure(formulaCurriculum(), formulaOutline(), [
    formulaAct({ conceptId: 'nope' }),
  ]);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('unknown-concept'));
});

test('a correctIndex outside the options is rejected', () => {
  const act = formulaAct({
    prediction: { question: 'Which?', options: ['a', 'b'], correctIndex: 5 },
  });
  const result = validateStructure(formulaCurriculum(), formulaOutline(), [act]);
  assert.ok(codes(result.errors).includes('index-out-of-range'));
});

test('duplicate prediction options are rejected', () => {
  const act = formulaAct({
    prediction: {
      question: 'Which?',
      options: ['Stays the same', 'stays the same '],
      correctIndex: 0,
    },
  });
  const result = validateStructure(formulaCurriculum(), formulaOutline(), [act]);
  assert.ok(codes(result.errors).includes('duplicate-option'));
});

test('a dialogue line over 25 words is rejected', () => {
  const act = formulaAct({
    dialogue: [{ speaker: 'Inspector Rane', line: `${'word '.repeat(26)}`.trim() }],
  });
  const result = validateStructure(formulaCurriculum(), formulaOutline(), [act]);
  assert.ok(codes(result.errors).includes('line-too-long'));
});

test('a speaker who is not in the cast is rejected', () => {
  const act = formulaAct({ dialogue: [{ speaker: 'Some Stranger', line: 'Hello.' }] });
  const result = validateStructure(formulaCurriculum(), formulaOutline(), [act]);
  assert.ok(codes(result.errors).includes('unknown-speaker'));
});

test('a mechanic that does not match the concept kind is rejected', () => {
  const act = formulaAct({
    mechanic: {
      type: 'ai-system',
      ragAct: 'chunking',
      question: 'What dose?',
      goldFact: 'forty milligrams',
    },
  });
  const result = validateStructure(formulaCurriculum(), formulaOutline(), [act]);
  assert.ok(codes(result.errors).includes('mechanic-kind-mismatch'));
});

// --- ai-system --------------------------------------------------------------

test('an empty gold fact is rejected', () => {
  const act = fallback.acts[0]!;
  const broken: ActSpec = {
    ...act,
    mechanic: { type: 'ai-system', ragAct: 'chunking', question: 'What dose?', goldFact: '  ' },
  };
  const result = validateAiSystemMechanics([broken]);
  assert.equal(result.ok, false);
  assert.ok(codes(result.errors).includes('empty-gold-fact'));
});

// --- the whole thing --------------------------------------------------------

test('the cached fallback script validates against the sample chapter', () => {
  const result = validateScript({ script: fallback, chapterText, evaluator: evaluator });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
});
