/**
 * The sequence mechanic: put the cards in the order the concept demands.
 *
 * Everything here is pure and deterministic, and it is the only judge. The
 * cards, the rules and the explanations are written by a model, but nothing a
 * model wrote is ever run: a rule is two ids and a sentence, and an order wins
 * exactly when no rule is broken. The validator, the audit, the tests and the
 * panel the player uses all call the same functions, so the act that was
 * proved finishable is the act that is played.
 */
import type { SequenceMechanic, SequenceRule } from './types.js';

/** Fewer cards than this and ordering them is a guess; more and it is a chore. */
export const SEQUENCE_MIN_ITEMS = 4;
export const SEQUENCE_MAX_ITEMS = 8;
/**
 * Stricter than the formula acts' one-half: a coin flip between two cards is
 * not knowing the order. A real partial order sits far below this — five
 * cards with three unordered in the middle is 5%.
 */
export const SEQUENCE_MAX_WIN_RATE = 0.2;

export interface SequenceJudgement {
  won: boolean;
  /** Rules the order breaks, in the order the first offending card appears. */
  broken: SequenceRule[];
  /** How many rules hold, out of `total`. */
  kept: number;
  total: number;
  /** Set when the order is not a permutation of the items, which never wins. */
  invalid?: string;
}

export interface SequenceState {
  order: string[];
  /** How many times the player has checked. */
  checks: number;
  /** The verdict of the last check, cleared by any move. */
  last: SequenceJudgement | null;
  /** Latched: once won, the act stays won even if the cards are moved again. */
  solved: boolean;
}

export type SequenceAction =
  /** Move one card to a position, shifting the rest. */
  | { kind: 'move'; id: string; to: number }
  /** Swap two cards. */
  | { kind: 'swap'; a: string; b: string }
  | { kind: 'check' }
  /** Back to the starting order. Solved stays solved: progression is not undone. */
  | { kind: 'reset' };

function permutationProblem(mechanic: SequenceMechanic, order: string[]): string | null {
  const ids = mechanic.items.map((i) => i.id);
  if (order.length !== ids.length) return `${order.length} cards placed, ${ids.length} expected`;
  const want = new Set(ids);
  const seen = new Set<string>();
  for (const id of order) {
    if (!want.has(id)) return `"${id}" is not one of the cards`;
    if (seen.has(id)) return `"${id}" is placed twice`;
    seen.add(id);
  }
  return null;
}

export function judgeSequence(mechanic: SequenceMechanic, order: string[]): SequenceJudgement {
  const total = mechanic.rules.length;
  const invalid = permutationProblem(mechanic, order);
  if (invalid) return { won: false, broken: [], kept: 0, total, invalid };

  const at = new Map(order.map((id, i) => [id, i]));
  const broken = mechanic.rules
    .filter((r) => (at.get(r.before) ?? -1) > (at.get(r.after) ?? -1))
    .sort(
      (a, b) =>
        Math.min(at.get(a.before)!, at.get(a.after)!) -
        Math.min(at.get(b.before)!, at.get(b.after)!),
    );
  return { won: broken.length === 0, broken, kept: total - broken.length, total };
}

export function initialSequenceState(mechanic: SequenceMechanic): SequenceState {
  return { order: [...mechanic.initial], checks: 0, last: null, solved: false };
}

/** The whole interaction, as a reducer. Unknown ids are ignored, never thrown. */
export function applySequence(
  mechanic: SequenceMechanic,
  state: SequenceState,
  action: SequenceAction,
): SequenceState {
  switch (action.kind) {
    case 'move': {
      const from = state.order.indexOf(action.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(state.order.length - 1, Math.round(action.to)));
      if (to === from) return state;
      const order = state.order.filter((id) => id !== action.id);
      order.splice(to, 0, action.id);
      return { ...state, order, last: null };
    }
    case 'swap': {
      const i = state.order.indexOf(action.a);
      const j = state.order.indexOf(action.b);
      if (i < 0 || j < 0 || i === j) return state;
      const order = [...state.order];
      order[i] = action.b;
      order[j] = action.a;
      return { ...state, order, last: null };
    }
    case 'check': {
      const last = judgeSequence(mechanic, state.order);
      return { ...state, checks: state.checks + 1, last, solved: state.solved || last.won };
    }
    case 'reset':
      return { ...state, order: [...mechanic.initial], last: null };
  }
}

/**
 * Where the cards start, decided here rather than by the model: a seeded
 * shuffle of the solution, kept only if it breaks at least half the rules, so
 * the act opens visibly wrong but not as a mirror image of the answer. The
 * reversed solution breaks every rule and is the last resort. Same act id,
 * same start, every time.
 */
export function startingOrder(
  mechanic: Pick<SequenceMechanic, 'rules' | 'solution'>,
  seedText: string,
): string[] {
  let seed = 2166136261;
  for (const ch of seedText) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const probe = {
    prompt: '',
    items: mechanic.solution.map((id) => ({ id, label: id })),
    initial: [],
  };
  const want = Math.max(1, Math.ceil(mechanic.rules.length / 2));
  for (let attempt = 0; attempt < 64; attempt++) {
    const order = [...mechanic.solution];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const judged = judgeSequence(
      { ...probe, type: 'sequence', rules: mechanic.rules, solution: mechanic.solution },
      order,
    );
    if (judged.broken.length >= want) return order;
  }
  return [...mechanic.solution].reverse();
}

/**
 * The fraction of all orderings that win, counted exactly. Eight cards is
 * 40 320 orderings, which is nothing; more than that is refused by
 * `sequenceProblems` before anyone asks.
 */
export function sequenceWinRate(mechanic: SequenceMechanic): number {
  const ids = mechanic.items.map((i) => i.id);
  if (ids.length === 0 || ids.length > SEQUENCE_MAX_ITEMS) return 1;
  const index = new Map(ids.map((id, i) => [id, i]));
  const rules = mechanic.rules
    .map((r) => [index.get(r.before), index.get(r.after)] as const)
    .filter(
      (pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined,
    );

  const position = new Array<number>(ids.length).fill(-1);
  let wins = 0;
  let all = 0;
  const place = (slot: number) => {
    if (slot === ids.length) {
      all++;
      if (rules.every(([b, a]) => position[b]! < position[a]!)) wins++;
      return;
    }
    for (let item = 0; item < ids.length; item++) {
      if (position[item]! >= 0) continue;
      position[item] = slot;
      place(slot + 1);
      position[item] = -1;
    }
  };
  place(0);
  return wins / all;
}

export interface SequenceProblem {
  /** Relative to the mechanic, e.g. "rules[2].after". */
  at: string;
  code: string;
  message: string;
}

/**
 * Everything that makes a sequence act unplayable, unfinishable or guessable.
 * Empty means the act is sound: the start loses, the solution wins, and a
 * random order usually loses.
 */
export function sequenceProblems(mechanic: SequenceMechanic): SequenceProblem[] {
  const problems: SequenceProblem[] = [];
  const add = (at: string, code: string, message: string) => problems.push({ at, code, message });

  if (!mechanic.prompt?.trim())
    add('prompt', 'empty', 'the board says nothing about what to order');

  const ids = mechanic.items.map((i) => i.id);
  if (ids.length < SEQUENCE_MIN_ITEMS || ids.length > SEQUENCE_MAX_ITEMS) {
    add(
      'items',
      'item-count',
      `${ids.length} cards; a sequence needs ${SEQUENCE_MIN_ITEMS} to ${SEQUENCE_MAX_ITEMS}`,
    );
  }
  const seen = new Set<string>();
  mechanic.items.forEach((item, i) => {
    if (!item.id.trim()) add(`items[${i}].id`, 'empty', 'card has no id');
    if (seen.has(item.id)) add(`items[${i}].id`, 'duplicate-id', `card id "${item.id}" used twice`);
    seen.add(item.id);
    if (!item.label.trim()) add(`items[${i}].label`, 'empty', 'card has no label');
  });
  const labels = mechanic.items.map((i) => i.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) {
    add(
      'items',
      'duplicate-label',
      'two cards say the same thing, so the player cannot tell them apart',
    );
  }

  if (mechanic.rules.length === 0) add('rules', 'no-rules', 'with no rules every order wins');
  const touched = new Set<string>();
  mechanic.rules.forEach((rule, i) => {
    for (const end of ['before', 'after'] as const) {
      if (!seen.has(rule[end])) {
        add(`rules[${i}].${end}`, 'unknown-item', `"${rule[end]}" is not one of the cards`);
      }
      touched.add(rule[end]);
    }
    if (rule.before === rule.after) {
      add(`rules[${i}]`, 'self-rule', `"${rule.before}" cannot come before itself`);
    }
    if (!rule.why.trim()) {
      add(`rules[${i}].why`, 'empty', 'a broken rule with no reason teaches nothing');
    }
  });
  for (const id of ids) {
    if (!touched.has(id)) {
      add('rules', 'unconstrained-item', `card "${id}" is in no rule, so it can go anywhere`);
    }
  }

  const solution = permutationProblem(mechanic, mechanic.solution);
  if (solution) add('solution', 'not-a-permutation', solution);
  const initial = permutationProblem(mechanic, mechanic.initial);
  if (initial) add('initial', 'not-a-permutation', initial);
  // Past here the orders are judged. Problems that make judging meaningless
  // stop it; the rest (an empty label, a card in no rule) are reported along
  // with whatever judging finds, so one repair can fix them all.
  const FATAL = new Set([
    'item-count',
    'duplicate-id',
    'unknown-item',
    'self-rule',
    'not-a-permutation',
    'no-rules',
  ]);
  if (problems.some((p) => FATAL.has(p.code))) return problems;

  if (!judgeSequence(mechanic, mechanic.solution).won) {
    // Also how a cycle shows up: no order can satisfy a → b → a.
    add('solution', 'solution-loses', 'the declared solution breaks a rule, so nothing may win');
  }
  if (judgeSequence(mechanic, mechanic.initial).won) {
    add('initial', 'starts-solved', 'the cards start in a winning order, so the act is free');
  }
  const rate = sequenceWinRate(mechanic);
  if (rate > SEQUENCE_MAX_WIN_RATE) {
    add(
      'rules',
      'guessable',
      `${Math.round(rate * 100)}% of random orders win; add rules until most orders lose`,
    );
  }
  return problems;
}
