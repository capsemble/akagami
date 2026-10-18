/**
 * The evidence mechanic: pin each document to the claim it proves.
 *
 * Pure and deterministic, like shared/sequence.ts. The links are written by a
 * model and checked before a player ever sees them — every excerpt against
 * the notes (shared/grounding.ts), every pairing by the evidence judge — and
 * from then on the links are the only judge. The runtime never asks a model
 * whether a pin is right.
 */
import type { EvidenceLink, EvidenceMechanic } from './types.js';

export const EVIDENCE_MIN_CLAIMS = 2;
export const EVIDENCE_MAX_CLAIMS = 5;
export const EVIDENCE_MIN_ITEMS = 3;
export const EVIDENCE_MAX_ITEMS = 7;
/** Same bar as a sequence: pinning at random must almost always lose. */
export const EVIDENCE_MAX_WIN_RATE = 0.2;

export interface EvidenceJudgement {
  won: boolean;
  /** Claims with at least one correct document pinned and nothing wrong. */
  backed: number;
  total: number;
  /** Pins that are not links, in the order the documents sit on the table. */
  wrong: { evidence: string; claim: string }[];
  /** Claims with nothing pinned to them. */
  empty: string[];
}

export interface EvidenceState {
  /** evidence id → claim id. A document is pinned to one claim at most. */
  pins: Record<string, string>;
  checks: number;
  last: EvidenceJudgement | null;
  /** Latched: once won, the act stays won. */
  solved: boolean;
}

export type EvidenceAction =
  | { kind: 'pin'; evidence: string; claim: string }
  | { kind: 'unpin'; evidence: string }
  | { kind: 'check' }
  /** Every document back on the table. Solved stays solved. */
  | { kind: 'reset' };

const linked = (links: EvidenceLink[]) =>
  new Set(links.map((l) => `${l.claim}\u0000${l.evidence}`));

export function judgeEvidence(
  mechanic: EvidenceMechanic,
  pins: Record<string, string>,
): EvidenceJudgement {
  const valid = linked(mechanic.links);
  const wrong: EvidenceJudgement['wrong'] = [];
  const good = new Set<string>();
  const bad = new Set<string>();
  for (const item of mechanic.evidence) {
    const claim = pins[item.id];
    if (!claim) continue;
    if (valid.has(`${claim}\u0000${item.id}`)) good.add(claim);
    else {
      wrong.push({ evidence: item.id, claim });
      bad.add(claim);
    }
  }
  const pinnedTo = new Set(Object.values(pins));
  const empty = mechanic.claims.map((c) => c.id).filter((id) => !pinnedTo.has(id));
  const backed = mechanic.claims.filter((c) => good.has(c.id) && !bad.has(c.id)).length;
  return {
    won: wrong.length === 0 && backed === mechanic.claims.length,
    backed,
    total: mechanic.claims.length,
    wrong,
    empty,
  };
}

export function initialEvidenceState(): EvidenceState {
  return { pins: {}, checks: 0, last: null, solved: false };
}

export function applyEvidence(
  mechanic: EvidenceMechanic,
  state: EvidenceState,
  action: EvidenceAction,
): EvidenceState {
  switch (action.kind) {
    case 'pin': {
      const known =
        mechanic.evidence.some((e) => e.id === action.evidence) &&
        mechanic.claims.some((c) => c.id === action.claim);
      if (!known || state.pins[action.evidence] === action.claim) return state;
      return { ...state, pins: { ...state.pins, [action.evidence]: action.claim }, last: null };
    }
    case 'unpin': {
      if (!(action.evidence in state.pins)) return state;
      const pins = { ...state.pins };
      delete pins[action.evidence];
      return { ...state, pins, last: null };
    }
    case 'check': {
      const last = judgeEvidence(mechanic, state.pins);
      return { ...state, checks: state.checks + 1, last, solved: state.solved || last.won };
    }
    case 'reset':
      return { ...state, pins: {}, last: null };
  }
}

/**
 * The fraction of all ways to lay the documents out — each on one claim or
 * left on the table — that win. Counted exactly: at most 6^7 layouts.
 */
export function evidenceWinRate(mechanic: EvidenceMechanic): number {
  const items = mechanic.evidence.map((e) => e.id);
  const claims = mechanic.claims.map((c) => c.id);
  if (items.length > EVIDENCE_MAX_ITEMS || claims.length > EVIDENCE_MAX_CLAIMS) return 1;
  const choices = [null, ...claims];
  const pins: Record<string, string> = {};
  let wins = 0;
  let all = 0;
  const place = (i: number) => {
    if (i === items.length) {
      all++;
      if (judgeEvidence(mechanic, pins).won) wins++;
      return;
    }
    for (const claim of choices) {
      if (claim) pins[items[i]!] = claim;
      else delete pins[items[i]!];
      place(i + 1);
    }
    delete pins[items[i]!];
  };
  place(0);
  return wins / all;
}

export interface EvidenceProblem {
  at: string;
  code: string;
  message: string;
}

/** Everything that makes an evidence act unplayable, unfinishable or guessable. */
export function evidenceProblems(mechanic: EvidenceMechanic): EvidenceProblem[] {
  const problems: EvidenceProblem[] = [];
  const add = (at: string, code: string, message: string) => problems.push({ at, code, message });

  if (!mechanic.prompt?.trim()) add('prompt', 'empty', 'the board says nothing about what to do');
  const nClaims = mechanic.claims.length;
  const nItems = mechanic.evidence.length;
  if (nClaims < EVIDENCE_MIN_CLAIMS || nClaims > EVIDENCE_MAX_CLAIMS) {
    add(
      'claims',
      'claim-count',
      `${nClaims} claims; ${EVIDENCE_MIN_CLAIMS} to ${EVIDENCE_MAX_CLAIMS} needed`,
    );
  }
  if (nItems < EVIDENCE_MIN_ITEMS || nItems > EVIDENCE_MAX_ITEMS) {
    add(
      'evidence',
      'item-count',
      `${nItems} documents; ${EVIDENCE_MIN_ITEMS} to ${EVIDENCE_MAX_ITEMS} needed`,
    );
  }

  const ids = new Set<string>();
  const unique = (id: string, at: string) => {
    if (!id.trim()) add(at, 'empty', 'missing id');
    if (ids.has(id)) add(at, 'duplicate-id', `id "${id}" used twice`);
    ids.add(id);
  };
  mechanic.claims.forEach((c, i) => {
    unique(c.id, `claims[${i}].id`);
    if (!c.text.trim()) add(`claims[${i}].text`, 'empty', 'a claim that says nothing');
  });
  mechanic.evidence.forEach((e, i) => {
    unique(e.id, `evidence[${i}].id`);
    if (!e.title.trim()) add(`evidence[${i}].title`, 'empty', 'a document with no title');
    if (!e.excerpt.trim()) add(`evidence[${i}].excerpt`, 'empty', 'a document with no text');
    if (!e.shows.trim()) {
      add(
        `evidence[${i}].shows`,
        'empty',
        'nothing to tell a player who pins it in the wrong place',
      );
    }
  });

  const claimIds = new Set(mechanic.claims.map((c) => c.id));
  const itemIds = new Set(mechanic.evidence.map((e) => e.id));
  const seen = new Set<string>();
  mechanic.links.forEach((link, i) => {
    if (!claimIds.has(link.claim))
      add(`links[${i}].claim`, 'unknown-claim', `"${link.claim}" is not a claim`);
    if (!itemIds.has(link.evidence)) {
      add(`links[${i}].evidence`, 'unknown-evidence', `"${link.evidence}" is not a document`);
    }
    const key = `${link.claim}\u0000${link.evidence}`;
    if (seen.has(key)) add(`links[${i}]`, 'duplicate-link', 'the same pairing is listed twice');
    seen.add(key);
    if (!link.why.trim()) add(`links[${i}].why`, 'empty', 'a link with no reason teaches nothing');
  });
  for (const claim of mechanic.claims) {
    if (!mechanic.links.some((l) => l.claim === claim.id)) {
      add(
        'links',
        'unbacked-claim',
        `no document backs "${claim.text.slice(0, 60)}", so it cannot be won`,
      );
    }
  }
  if (problems.length > 0) return problems;

  const rate = evidenceWinRate(mechanic);
  if (rate > EVIDENCE_MAX_WIN_RATE) {
    add(
      'links',
      'guessable',
      `${Math.round(rate * 100)}% of random layouts win; add decoys or claims`,
    );
  }
  return problems;
}
