/**
 * Grounding, in two halves that are tested separately on purpose.
 *
 * DETERMINISTIC (shared/grounding.ts, validate.ts): the quotation exists in the
 * notes, it is about the cards or claims it is cited for, and dated passages do
 * not run backwards. These tests prove those checks.
 *
 * MODEL-BASED (pipeline/judge.ts): whether a passage *supports* a statement.
 * Here the model is replaced by a scripted asker, so these tests prove what the
 * pipeline does with each verdict — reject, accept, fail closed — and nothing
 * about whether a real model's verdicts are right. That is measured by the
 * live builds, and reported as a model's reading, not a proof.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  ActSpec,
  EvidenceMechanic,
  GroundingVerdict,
  SequenceMechanic,
} from '@chapter-quest/shared';
import {
  applyEvidence,
  completionOf,
  dateConflict,
  evidenceGroundingProblems,
  evidenceProblems,
  evidenceWinRate,
  initialEvidenceState,
  judgeEvidence,
  quoteInSource,
  sequenceGroundingProblems,
} from '@chapter-quest/shared';
import { repoRoot } from '../src/paths.js';
import {
  assess,
  judgeGrounding,
  pruneUnsupportedRules,
  statementsOf,
} from '../src/pipeline/judge.js';
import type { GroundingAsker } from '../src/pipeline/judge.js';
import { validateCitations } from '../src/validate.js';
import { toMechanic } from '../src/wire.js';

const notes = (name: string) =>
  readFileSync(join(repoRoot, `server/scripts/fixtures/${name}.md`), 'utf8');
const HISTORY = notes('history-july-crisis');
const BIOLOGY = notes('biology-protein-synthesis');
const codes = (problems: { code: string }[]) => problems.map((p) => p.code);

// --- a July-crisis sequence, cited from the history notes --------------------

const july = (rules: SequenceMechanic['rules']): SequenceMechanic => ({
  type: 'sequence',
  prompt: 'Order the decisions of July 1914.',
  items: [
    {
      id: 'cheque',
      label: "Germany's blank cheque",
      detail: 'A promise of unconditional German support.',
    },
    { id: 'ultimatum', label: 'The ultimatum to Serbia' },
    { id: 'war', label: 'Austria-Hungary declares war on Serbia' },
    { id: 'mobilise', label: 'Russia orders general mobilisation' },
  ],
  rules,
  initial: ['mobilise', 'war', 'ultimatum', 'cheque'],
  solution: ['cheque', 'ultimatum', 'war', 'mobilise'],
});

const CHEQUE_TO_ULTIMATUM = {
  before: 'cheque',
  after: 'ultimatum',
  why: 'Only with German backing did Vienna risk an ultimatum Russia might answer.',
  evidence: [
    'Confident of German backing, Austria-Hungary sent Serbia an ultimatum with demands designed to be almost impossible to accept in full.',
  ],
};
const WAR_TO_MOBILISE = {
  before: 'war',
  after: 'mobilise',
  why: 'Russia mobilised to protect Serbia once Austria-Hungary had declared war on it.',
  evidence: [
    '**28 July:** Austria-Hungary declared war on Serbia.',
    '**30 July:** Russia, determined to protect Serbia, ordered general mobilisation.',
  ],
};

/** A scripted judge: every statement gets `verdict`, except the ones overridden. */
const judgeSaying =
  (
    verdict: GroundingVerdict['verdict'],
    overrides: Record<string, GroundingVerdict['verdict']> = {},
  ): GroundingAsker =>
  async (prompt) => ({
    verdicts: [...prompt.matchAll(/^\[([^\]]+)\]/gm)].map(([, ref]) => ({
      ref: ref!,
      verdict: overrides[ref!] ?? verdict,
      reason: 'scripted',
    })),
  });

// --- 1. a valid, directly supported rule -----------------------------------------

test('DETERMINISTIC: a directly supported rule passes every citation check', () => {
  const act = july([CHEQUE_TO_ULTIMATUM, WAR_TO_MOBILISE]);
  assert.deepEqual(sequenceGroundingProblems(act, HISTORY), []);
});

test('MODEL (scripted): a rule the judge finds supported is accepted, and the verdict is kept', async () => {
  const act = july([CHEQUE_TO_ULTIMATUM, WAR_TO_MOBILISE]);
  const { record, problems } = await judgeGrounding(
    act,
    HISTORY,
    judgeSaying('supported'),
    'test-judge',
  );
  assert.deepEqual(problems, []);
  assert.equal(record.judge, 'test-judge');
  assert.equal(record.verdicts.length, statementsOf(act).length);
});

// --- 2. a quotation that does not exist in the notes -----------------------------------

test('DETERMINISTIC: a paraphrase is not a quotation and is rejected', () => {
  const act = july([
    {
      ...CHEQUE_TO_ULTIMATUM,
      evidence: [
        'Germany promised Austria-Hungary unconditional support on 5 July, so it sent the ultimatum.',
      ],
    },
  ]);
  assert.deepEqual(codes(sequenceGroundingProblems(act, HISTORY)), ['evidence-not-in-source']);
});

test('DETERMINISTIC: whitespace, curly quotes and markdown emphasis are forgiven; words are not', () => {
  assert.equal(quoteInSource('28 July: Austria-Hungary declared war on Serbia.', HISTORY), true);
  assert.equal(quoteInSource('the  “blank cheque”  — a promise', HISTORY), true);
  assert.equal(quoteInSource('28 July: Austria-Hungary declared war on Russia.', HISTORY), false);
});

test('DETERMINISTIC: a fragment too short to establish anything is rejected', () => {
  const act = july([{ ...CHEQUE_TO_ULTIMATUM, evidence: ['German backing'] }]);
  assert.deepEqual(codes(sequenceGroundingProblems(act, HISTORY)), ['quote-too-short']);
});

test('DETERMINISTIC: a rule with no citation at all is rejected', () => {
  const act = july([{ ...CHEQUE_TO_ULTIMATUM, evidence: [] }]);
  assert.deepEqual(codes(sequenceGroundingProblems(act, HISTORY)), ['missing-evidence']);
});

// --- 3. a real quotation used to support an invalid conclusion -------------------------

test('a real, on-topic quotation cited for the WRONG order passes the deterministic checks — exact matching proves nothing about meaning', () => {
  // Russia's mobilisation cited as coming BEFORE the declaration of war, from a
  // single real sentence that mentions both and carries one date.
  const backwards = {
    before: 'mobilise',
    after: 'war',
    why: 'Russia mobilised first, so Austria-Hungary declared war.',
    evidence: ['**30 July:** Russia, determined to protect Serbia, ordered general mobilisation.'],
  };
  const act = july([backwards]);
  assert.deepEqual(
    sequenceGroundingProblems(act, HISTORY),
    [],
    'the deterministic layer cannot see this error, and must not be claimed to',
  );
});

test('MODEL (scripted): the same rule judged contradicted is rejected', async () => {
  const act = july([
    {
      before: 'mobilise',
      after: 'war',
      why: 'Russia mobilised first, so Austria-Hungary declared war.',
      evidence: [
        '**30 July:** Russia, determined to protect Serbia, ordered general mobilisation.',
      ],
    },
  ]);
  const { problems } = await judgeGrounding(
    act,
    HISTORY,
    judgeSaying('supported', { 'rule:0': 'contradicted' }),
  );
  assert.deepEqual(codes(problems), ['evidence-contradicts']);
});

// --- 4. conflicting evidence ------------------------------------------------------------

test('DETERMINISTIC: dated passages that run against the rule are a conflict', () => {
  const act = july([{ ...WAR_TO_MOBILISE, before: 'mobilise', after: 'war' }]);
  assert.deepEqual(codes(sequenceGroundingProblems(act, HISTORY)), ['evidence-conflict']);
  // And no conflict is claimed where the dates agree, or are absent.
  assert.equal(
    dateConflict('war on Serbia', 'Russia mobilisation', WAR_TO_MOBILISE.evidence),
    null,
  );
  assert.equal(dateConflict('blank cheque', 'ultimatum', CHEQUE_TO_ULTIMATUM.evidence), null);
});

test('MODEL (scripted): a rule whose citations the judge finds contradictory is rejected', async () => {
  const act = july([CHEQUE_TO_ULTIMATUM]);
  const { problems } = await judgeGrounding(
    act,
    HISTORY,
    judgeSaying('supported', { 'rule:0': 'contradicted' }),
  );
  assert.deepEqual(codes(problems), ['evidence-contradicts']);
});

// --- 5. insufficient evidence ----------------------------------------------------------

test('insufficient evidence: on-topic passages that do not settle the order pass the deterministic layer and are rejected by the judge', async () => {
  // The error a real build shipped: "the drive on Paris came before Britain
  // declared war". The notes name both, and never order them.
  const act: SequenceMechanic = {
    type: 'sequence',
    prompt: 'Order the opening of the war in the west.',
    items: [
      {
        id: 'paris',
        label: 'Germany drives toward France',
        detail: 'Aiming to defeat France quickly.',
      },
      { id: 'britain', label: 'Britain declares war on Germany' },
      { id: 'belgium', label: 'German troops invade Belgium' },
      { id: 'mobilise', label: 'Russia orders general mobilisation' },
    ],
    rules: [
      {
        before: 'paris',
        after: 'britain',
        why: 'The sweep into France brought Britain in.',
        evidence: [
          "It planned to defeat France quickly by marching through neutral Belgium, before Russia's slow mobilisation was complete.",
          'Because Britain had guaranteed Belgian neutrality in the Treaty of London (1839), Britain declared war on Germany the same day.',
        ],
      },
    ],
    initial: ['britain', 'paris', 'belgium', 'mobilise'],
    solution: ['mobilise', 'belgium', 'paris', 'britain'],
  };
  assert.deepEqual(sequenceGroundingProblems(act, HISTORY), []);
  const { problems } = await judgeGrounding(
    act,
    HISTORY,
    judgeSaying('supported', { 'rule:0': 'insufficient' }),
  );
  assert.deepEqual(codes(problems), ['evidence-insufficient']);
});

// --- 6. a source that does not contain what the puzzle needs ----------------------------

test('DETERMINISTIC: a card the cited text never mentions is off-topic evidence', () => {
  const act = july([
    {
      before: 'war',
      after: 'mobilise',
      why: 'w',
      evidence: ['**28 July:** Austria-Hungary declared war on Serbia.'],
    },
  ]);
  const swapped = {
    ...act,
    items: act.items.map((i) =>
      i.id === 'mobilise' ? { id: 'mobilise', label: 'Kaiser abdicates in November 1918' } : i,
    ),
  };
  assert.deepEqual(codes(sequenceGroundingProblems(swapped, HISTORY)), ['evidence-off-topic']);
});

test('MODEL (scripted): a card adding a fact the notes do not give is rejected', async () => {
  const act = july([CHEQUE_TO_ULTIMATUM]);
  const { problems } = await judgeGrounding(
    act,
    HISTORY,
    judgeSaying('supported', { 'card:war': 'insufficient' }),
  );
  assert.deepEqual(codes(problems), ['card-unsupported']);
});

// --- the judge fails closed ------------------------------------------------------------

test('a judge that cannot answer, or skips a statement, rejects rather than accepts', async () => {
  const act = july([CHEQUE_TO_ULTIMATUM]);
  const dead: GroundingAsker = async () => {
    throw new Error('503 overloaded');
  };
  const down = await judgeGrounding(act, HISTORY, dead);
  assert.ok(down.failure?.includes('503'));
  assert.ok(down.problems.length > 0);
  assert.ok(codes(down.problems).every((c) => c === 'grounding-unchecked'));

  const partial: GroundingAsker = async () => ({
    verdicts: [
      { ref: 'rule:0', verdict: 'supported', reason: 'r' },
      { ref: 'rule:99', verdict: 'supported', reason: 'invented ref, ignored' },
    ],
  });
  const half = await judgeGrounding(act, HISTORY, partial);
  assert.ok(codes(half.problems).includes('grounding-unchecked'));
  assert.equal(half.record.verdicts.length, 1, 'verdicts on refs it was never shown are dropped');
});

test('a stored record is re-read deterministically: the audit trail decides, not a re-ask', () => {
  const act = july([CHEQUE_TO_ULTIMATUM]);
  const record = {
    judge: 'test',
    checkedAt: 'now',
    verdicts: statementsOf(act).map((s) => ({
      ref: s.ref,
      verdict: 'supported' as const,
      reason: 'r',
    })),
  };
  assert.deepEqual(assess(act, record), []);
  assert.ok(assess(act, undefined).length > 0);
});

test('a generated rule cannot carry its own verdict across the wire', () => {
  const mechanic = toMechanic(
    {
      type: 'sequence',
      sequence: {
        prompt: 'p',
        items: [],
        rules: [{ ...CHEQUE_TO_ULTIMATUM, ...({ support: 'supported' } as object) }],
        solution: [],
      },
    },
    'act1',
  ) as SequenceMechanic;
  assert.deepEqual(Object.keys(mechanic.rules[0]!).sort(), ['after', 'before', 'evidence', 'why']);
  assert.equal(mechanic.grounding, undefined);
});

// --- the evidence mechanic ------------------------------------------------------------------

const exam: EvidenceMechanic = {
  type: 'evidence',
  prompt: 'Pin each document to the claim it proves.',
  claims: [
    { id: 'belgium', text: "Britain's entry was decided by the invasion of Belgium." },
    { id: 'cheque', text: 'German backing made the ultimatum to Serbia possible.' },
  ],
  evidence: [
    {
      id: 'london',
      title: 'Treaty of London, 1839',
      excerpt:
        'Because Britain had guaranteed Belgian neutrality in the Treaty of London (1839), Britain declared war on Germany the same day.',
      shows: 'Britain declared war because it had guaranteed Belgian neutrality.',
    },
    {
      id: 'confident',
      title: 'Vienna cable, 23 July',
      excerpt:
        'Confident of German backing, Austria-Hungary sent Serbia an ultimatum with demands designed to be almost impossible to accept in full.',
      shows: 'Austria-Hungary sent the ultimatum because it was confident of German backing.',
    },
    {
      id: 'princip',
      title: 'Sarajevo police report',
      excerpt:
        'Archduke Franz Ferdinand, heir to the Austro-Hungarian throne, was assassinated in Sarajevo by Gavrilo Princip',
      shows: 'Who killed the Archduke, and where.',
    },
  ],
  links: [
    {
      claim: 'belgium',
      evidence: 'london',
      why: 'The treaty guarantee is the reason given for the declaration.',
    },
    {
      claim: 'cheque',
      evidence: 'confident',
      why: 'The ultimatum was sent confident of that backing.',
    },
  ],
};

test('an evidence act is sound, finishable and not guessable', () => {
  assert.deepEqual(evidenceProblems(exam), []);
  assert.equal(completionOf({ mechanic: exam }).ok, true);
  // 3 documents, each on one of 2 claims or none: 27 layouts, 1 wins.
  assert.equal(evidenceWinRate(exam), 1 / 27);
  assert.deepEqual(evidenceGroundingProblems(exam, HISTORY), []);
});

test('a player can play it: wrong pin explained by what the document shows, then win, then reset', () => {
  let state = initialEvidenceState();
  state = applyEvidence(exam, state, { kind: 'pin', evidence: 'princip', claim: 'belgium' });
  state = applyEvidence(exam, state, { kind: 'pin', evidence: 'confident', claim: 'cheque' });
  state = applyEvidence(exam, state, { kind: 'check' });
  assert.equal(state.last?.won, false);
  assert.deepEqual(state.last?.wrong, [{ evidence: 'princip', claim: 'belgium' }]);
  assert.equal(state.last?.backed, 1);
  assert.equal(state.solved, false);
  // The feedback the panel shows for that pin is the decoy's own `shows`:
  // what it proves, never which claim the right document is.
  assert.equal(exam.evidence.find((e) => e.id === 'princip')!.shows.includes('Britain'), false);

  state = applyEvidence(exam, state, { kind: 'unpin', evidence: 'princip' });
  state = applyEvidence(exam, state, { kind: 'pin', evidence: 'london', claim: 'belgium' });
  state = applyEvidence(exam, state, { kind: 'check' });
  assert.equal(state.last?.won, true);
  assert.equal(state.solved, true);

  state = applyEvidence(exam, state, { kind: 'reset' });
  assert.deepEqual(state.pins, {});
  assert.equal(state.solved, true, 'reset does not undo progression');
});

test('an empty claim is reported, and unknown ids change nothing', () => {
  const state = applyEvidence(exam, initialEvidenceState(), { kind: 'check' });
  assert.deepEqual(state.last?.empty, ['belgium', 'cheque']);
  const same = initialEvidenceState();
  assert.equal(
    applyEvidence(exam, same, { kind: 'pin', evidence: 'ghost', claim: 'belgium' }),
    same,
  );
  assert.equal(applyEvidence(exam, same, { kind: 'unpin', evidence: 'london' }), same);
});

test('pinning every document everywhere never wins: a decoy pinned anywhere is wrong', () => {
  const judged = judgeEvidence(exam, { london: 'belgium', confident: 'cheque', princip: 'cheque' });
  assert.equal(judged.won, false);
  assert.equal(judged.backed, 1);
});

test('DETERMINISTIC: an invented excerpt and an unbacked claim are rejected', () => {
  const invented = {
    ...exam,
    evidence: exam.evidence.map((e) =>
      e.id === 'london'
        ? { ...e, excerpt: 'Britain went to war to honour its alliance with France.' }
        : e,
    ),
  };
  assert.deepEqual(codes(evidenceGroundingProblems(invented, HISTORY)), ['evidence-not-in-source']);

  const unbacked = { ...exam, links: exam.links.slice(1) };
  assert.ok(codes(evidenceProblems(unbacked)).includes('unbacked-claim'));
});

test('MODEL (scripted): a decoy that actually backs a claim makes the act ambiguous and it is rejected', async () => {
  const { problems } = await judgeGrounding(
    exam,
    HISTORY,
    // The judge reads the Sarajevo report as backing the cheque claim: the
    // game would then mark a defensible answer wrong.
    judgeSaying('supported', {
      'pair:belgium:confident': 'insufficient',
      'pair:belgium:princip': 'insufficient',
      'pair:cheque:london': 'insufficient',
      'pair:cheque:princip': 'supported',
    }),
  );
  assert.deepEqual(codes(problems), ['ambiguous-evidence']);
});

test('MODEL (scripted): a link the excerpt does not establish is rejected', async () => {
  const { problems } = await judgeGrounding(
    exam,
    HISTORY,
    judgeSaying('insufficient', {
      'shows:london': 'supported',
      'shows:confident': 'supported',
      'shows:princip': 'supported',
      'pair:cheque:confident': 'supported',
    }),
  );
  assert.deepEqual(codes(problems), ['evidence-insufficient']);
});

// --- through the validator, as the pipeline runs it --------------------------------------

test('validateCitations reports per act and per rule, on the real biology notes', () => {
  const base = {
    id: 'act1',
    conceptId: 'c',
    title: 't',
    goal: 'g',
    verbs: ['arrange'],
    prediction: { question: 'q', options: ['a', 'b'], correctIndex: 0 },
    explainAfter: 'e',
    analogy: { text: 'a', breaksWhere: 'b' },
    dialogue: [],
    scene: { name: 'n', description: 'd', objects: [], exitSide: 'east' },
  } as unknown as ActSpec;
  const transcription: SequenceMechanic = {
    type: 'sequence',
    prompt: 'Order transcription.',
    items: [
      { id: 'bind', label: 'RNA polymerase binds the promoter' },
      { id: 'unwind', label: 'The enzyme unwinds the double helix' },
      { id: 'build', label: 'A complementary RNA strand is built' },
      { id: 'release', label: 'Pre-mRNA is released at the terminator' },
    ],
    rules: [
      {
        before: 'bind',
        after: 'unwind',
        why: 'The enzyme has to be on the gene before it can open it.',
        evidence: [
          'RNA polymerase binds to the promoter, a region of DNA just before the gene.',
          'The enzyme unwinds a short stretch of the double helix',
        ],
      },
      {
        before: 'build',
        after: 'release',
        why: 'There is nothing to release until the strand is built.',
        evidence: [
          'When RNA polymerase reaches the terminator sequence, it releases the new RNA molecule.',
        ],
      },
    ],
    initial: ['release', 'build', 'unwind', 'bind'],
    solution: ['bind', 'unwind', 'build', 'release'],
  };
  const errors = validateCitations([{ ...base, mechanic: transcription }], BIOLOGY).errors;
  // The second rule's passage never mentions building a strand.
  assert.deepEqual(
    errors.map((e) => `${e.path} ${e.code}`),
    ['acts[0].mechanic.rules[1].evidence evidence-off-topic'],
  );
});

// --- pruning: rejecting a rule without throwing away the act -------------------------------

const chain = (n: number): SequenceMechanic => {
  const ids = Array.from({ length: n }, (_, i) => `s${i}`);
  return {
    type: 'sequence',
    prompt: 'p',
    items: ids.map((id) => ({ id, label: id })),
    rules: ids.slice(1).map((id, i) => ({ before: ids[i]!, after: id, why: 'w', evidence: ['e'] })),
    initial: [...ids].reverse(),
    solution: ids,
  };
};
const allSupported = (m: SequenceMechanic) => ({
  judge: 't',
  checkedAt: 'now',
  verdicts: statementsOf(m).map((s) => ({
    ref: s.ref,
    verdict: 'supported' as const,
    reason: 'r',
  })),
});

test('an unsupported rule is dropped, the cards it ordered go free, and the act survives when still sound', () => {
  const act = chain(5);
  const record = allSupported(act);
  record.verdicts = record.verdicts.map((v) =>
    v.ref === 'rule:1' ? { ...v, verdict: 'insufficient' as const } : v,
  );
  const graded = { ...act, grounding: record };
  const saved = pruneUnsupportedRules(graded, assess(graded, record), 'act1');
  assert.ok(saved);
  assert.equal(saved.mechanic.rules.length, 3);
  assert.deepEqual(
    saved.pruned.map((r) => `${r.before}>${r.after}`),
    ['s1>s2'],
  );
  assert.deepEqual(assess(saved.mechanic, saved.mechanic.grounding), []);
  // The rejected rule stays on the record, renamed, for the audit.
  assert.ok(saved.mechanic.grounding?.verdicts.some((v) => v.ref === 'pruned:s1>s2'));
  assert.equal(completionOf({ mechanic: saved.mechanic }).ok, true);
});

test('pruning that would leave a guessable act, or a card problem, does not save it', () => {
  const act = chain(4);
  const record = allSupported(act);
  record.verdicts = record.verdicts.map((v) =>
    v.ref === 'rule:0' || v.ref === 'rule:2' ? { ...v, verdict: 'insufficient' as const } : v,
  );
  const graded = { ...act, grounding: record };
  assert.equal(pruneUnsupportedRules(graded, assess(graded, record), 'a'), null);
  assert.equal(
    pruneUnsupportedRules(act, [{ at: 'items[0]', code: 'card-unsupported' }], 'a'),
    null,
    'a card that states something the notes do not cannot be pruned away',
  );
});
