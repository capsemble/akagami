/**
 * Deterministic grounding: what can be checked about a citation without
 * asking anyone.
 *
 * Three checks, and what each one does and does not prove:
 *
 * 1. **The quote is in the notes** (`quoteInSource`). Exact match after
 *    normalising whitespace, curly quotes, dashes, letter case and markdown
 *    emphasis — the characters a copy loses, never the words. This proves the
 *    passage exists. It proves nothing about what the passage means: a real
 *    sentence can be cited for a conclusion it does not support.
 *
 * 2. **The quote is about the right things** (`sharedTerms`). Each thing a
 *    rule or link talks about must share at least one content word with the
 *    passage cited for it. A necessary condition only — a passage can name
 *    both cards and still not say which came first.
 *
 * 3. **Dates do not contradict the order** (`dateConflict`). When the passage
 *    matched to each end of a rule carries an explicit date, the earlier date
 *    has to be on the `before` end. Catches one kind of error outright; says
 *    nothing when there are no dates.
 *
 * Whether a passage actually *supports* a statement is a question of meaning,
 * and is left to the evidence judge (server/src/pipeline/judge.ts), which is a
 * model and is recorded as one.
 */
import type { EvidenceMechanic, SequenceMechanic } from './types.js';

/** Shorter than this and a "quotation" is a phrase that could support anything. */
export const MIN_QUOTE_WORDS = 5;

export function normaliseSource(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const words = (text: string) => normaliseSource(text).split(' ').filter(Boolean);

export function quoteInSource(quote: string, source: string): boolean {
  const needle = normaliseSource(quote);
  return needle.length > 0 && normaliseSource(source).includes(needle);
}

const STOP = new Set(
  'that this with from they them have were which their there into only then than when what also each after before first next must will been being does more most some such very over under about because while where these those other between would could should still just even made make used uses using'.split(
    ' ',
  ),
);

/**
 * Content words, cut to a four-letter stem so "declared" meets "declares" and
 * "invaded" meets "invasion". Crude on purpose: it is a floor, not a reader.
 */
export function contentTerms(text: string): Set<string> {
  return new Set(
    words(text)
      .map((w) => w.replace(/[^a-z0-9]/g, ''))
      .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
      .map((w) => w.slice(0, 4)),
  );
}

export function sharedTerms(a: string, b: string): number {
  const left = contentTerms(a);
  let n = 0;
  for (const term of contentTerms(b)) if (left.has(term)) n++;
  return n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE =
  /\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/i;

export interface SourceDate {
  year?: number;
  month: number;
  day: number;
}

/** The first day-and-month date in a passage, e.g. "5–6 July" or "28 June 1914". */
export function firstDate(text: string): SourceDate | null {
  const match = DATE.exec(text.replace(/\*/g, ''));
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]!.toLowerCase().slice(0, 3));
  return {
    day: Number(match[1]),
    month,
    ...(match[3] ? { year: Number(match[3]) } : {}),
  };
}

/** Negative: a is earlier. Null when the two cannot be compared honestly. */
export function compareDates(a: SourceDate, b: SourceDate): number | null {
  if ((a.year === undefined) !== (b.year === undefined)) return null;
  return ((a.year ?? 0) - (b.year ?? 0)) * 400 + (a.month - b.month) * 32 + (a.day - b.day);
}

/** The cited passage that talks most about `subject`, or null if none does. */
function bestPassage(subject: string, passages: string[]): string | null {
  let best: string | null = null;
  let score = 0;
  for (const passage of passages) {
    const n = sharedTerms(subject, passage);
    if (n > score) {
      score = n;
      best = passage;
    }
  }
  return best;
}

/**
 * Two passages dated the wrong way round for the order they are cited for.
 * Null when there is nothing to compare — which is not the same as agreement.
 */
export function dateConflict(before: string, after: string, passages: string[]): string | null {
  const a = bestPassage(before, passages);
  const b = bestPassage(after, passages);
  if (!a || !b || a === b) return null;
  const da = firstDate(a);
  const db = firstDate(b);
  if (!da || !db) return null;
  const order = compareDates(da, db);
  return order !== null && order > 0
    ? `the passage dated ${da.day}/${da.month + 1} is cited for the earlier event and the one dated ${db.day}/${db.month + 1} for the later`
    : null;
}

export interface GroundingProblem {
  /** Relative to the mechanic, e.g. "rules[2].evidence[0]". */
  at: string;
  code: string;
  message: string;
}

function checkQuote(
  quote: string,
  at: string,
  source: string,
  add: (at: string, code: string, message: string) => void,
): boolean {
  if (words(quote).length < MIN_QUOTE_WORDS) {
    add(at, 'quote-too-short', `"${quote}" is under ${MIN_QUOTE_WORDS} words, too short to cite`);
    return false;
  }
  if (!quoteInSource(quote, source)) {
    add(at, 'evidence-not-in-source', `not found in the notes: "${quote.slice(0, 90)}"`);
    return false;
  }
  return true;
}

/** Every deterministic grounding problem in a sequence act. */
export function sequenceGroundingProblems(
  mechanic: SequenceMechanic,
  source: string,
): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const add = (at: string, code: string, message: string) => problems.push({ at, code, message });
  const card = new Map(mechanic.items.map((i) => [i.id, `${i.label} ${i.detail ?? ''}`.trim()]));

  mechanic.rules.forEach((rule, i) => {
    const at = `rules[${i}]`;
    const quotes = rule.evidence ?? [];
    if (quotes.length === 0) {
      add(`${at}.evidence`, 'missing-evidence', 'the rule cites nothing from the notes');
      return;
    }
    const real = quotes.filter((q, j) => checkQuote(q, `${at}.evidence[${j}]`, source, add));
    if (real.length < quotes.length) return;

    const cited = real.join(' ');
    for (const end of ['before', 'after'] as const) {
      const subject = card.get(rule[end]);
      if (subject && sharedTerms(subject, cited) === 0) {
        add(
          `${at}.evidence`,
          'evidence-off-topic',
          `the cited text never mentions "${subject.split(' ').slice(0, 6).join(' ')}…"`,
        );
      }
    }
    const conflict = dateConflict(card.get(rule.before) ?? '', card.get(rule.after) ?? '', real);
    if (conflict) add(`${at}.evidence`, 'evidence-conflict', conflict);
  });
  return problems;
}

/** Every deterministic grounding problem in an evidence act. */
export function evidenceGroundingProblems(
  mechanic: EvidenceMechanic,
  source: string,
): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const add = (at: string, code: string, message: string) => problems.push({ at, code, message });
  const excerpt = new Map<string, string>();

  mechanic.evidence.forEach((item, i) => {
    if (!checkQuote(item.excerpt, `evidence[${i}].excerpt`, source, add)) return;
    excerpt.set(item.id, item.excerpt);
    if (sharedTerms(item.shows, item.excerpt) === 0) {
      add(
        `evidence[${i}].shows`,
        'evidence-off-topic',
        `what "${item.title}" is said to show has nothing in common with its excerpt`,
      );
    }
  });
  const claim = new Map(mechanic.claims.map((c) => [c.id, c.text]));
  mechanic.links.forEach((link, i) => {
    const text = excerpt.get(link.evidence);
    const said = claim.get(link.claim);
    if (text && said && sharedTerms(said, text) === 0) {
      add(
        `links[${i}]`,
        'evidence-off-topic',
        `the excerpt cited for "${said.slice(0, 60)}" shares nothing with it`,
      );
    }
  });
  return problems;
}
