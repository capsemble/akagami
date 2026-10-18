/**
 * Adaptation: a failed attempt, read for the wrong idea behind it.
 *
 * `/api/adapt` has returned one canned teaching move about torn scrolls since
 * the first scaffold, whatever world you were in. This is the real one, and it
 * is built in the same two halves as everything else here:
 *
 * 1. **What happened is computed, not asked.** The attempt is re-judged from
 *    the act's own data — the miss and which way each dial pushes it for a
 *    formula act, the broken rule for a sequence, the wrong pin and what that
 *    document actually shows for an evidence board. Those facts are the only
 *    account of the attempt the model is given.
 *
 * 2. **The model chooses, within bounds.** It picks which misconception
 *    explains the facts — by number, from the list the curriculum wrote, never
 *    one of its own — picks a teaching move, and writes two short lines: the
 *    character who personifies that misconception cheering the mistake on, and
 *    the guide's correction. Both lines are checked for the answer before they
 *    are shown, exactly as the guide's are.
 *
 * No model, a timeout, or a reply that keeps leaking: the player still gets a
 * correction, built from the computed facts and flagged `offline`.
 */
import type { Act, AttemptReport, Character, Concept, TeachingMove } from '@chapter-quest/shared';
import {
  gradeRun,
  judgeEvidence,
  judgeSequence,
  sharedTerms,
  winningBand,
} from '@chapter-quest/shared';
import { generateJson } from './gemini.js';
import { directions, guideContext, leakedAnswer, leakedOrder } from './guide.js';
import { designOf } from './library.js';
import { ADAPT_SCHEMA } from './schemas.js';

export interface AdaptRequest {
  worldId: string;
  actId: string;
  attempt: AttemptReport;
  failures: number;
}

/** One wrong idea the model may choose, and who in the cast, if anyone, embodies it. */
export interface Misconception {
  text: string;
  owner?: { id: string; name: string };
}

export interface AdaptContext {
  act: Act;
  guide: Character;
  cast: Character[];
  concept?: Concept;
  misconceptions: Misconception[];
}

/** What the game computed about the attempt. The model's only view of it. */
export interface Diagnosis {
  facts: string[];
  /** A correction that needs no model: used when none answers. */
  fallback: string;
}

// --- the request ------------------------------------------------------------------

const MAX_ITEMS = 16;
const id = (v: unknown) => (typeof v === 'string' && /^[\w.:-]{1,64}$/.test(v) ? v : null);

function numberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_ITEMS)
      .filter(([k, n]) => id(k) && typeof n === 'number' && Number.isFinite(n)),
  ) as Record<string, number>;
}

/** Validate a request body. Null if it is not an attempt. */
export function readAdaptRequest(body: unknown): AdaptRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const worldId = id(b.worldId);
  const actId = id(b.actId);
  const a = b.attempt as Record<string, unknown> | undefined;
  if (!worldId || !actId || !a || typeof a !== 'object') return null;
  const failures = Math.max(1, Math.min(20, Math.round(Number(b.failures) || 1)));

  let attempt: AttemptReport | null = null;
  if (a.kind === 'formula') {
    attempt = { kind: 'formula', settings: numberMap(a.settings), outputs: numberMap(a.outputs) };
  } else if (a.kind === 'sequence' && Array.isArray(a.order)) {
    const order = a.order.slice(0, MAX_ITEMS).map(id);
    if (order.every(Boolean)) attempt = { kind: 'sequence', order: order as string[] };
  } else if (a.kind === 'evidence' && a.pins && typeof a.pins === 'object') {
    const pins = Object.entries(a.pins as Record<string, unknown>)
      .slice(0, MAX_ITEMS)
      .filter(([k, v]) => id(k) && id(v));
    attempt = { kind: 'evidence', pins: Object.fromEntries(pins) as Record<string, string> };
  }
  return attempt ? { worldId, actId, attempt, failures } : null;
}

// --- who is in the room ---------------------------------------------------------------

export async function adaptContext(req: AdaptRequest): Promise<AdaptContext | null> {
  const ctx = await guideContext({
    worldId: req.worldId,
    actId: req.actId,
    characterId: '',
    playerSays: '-',
    history: [],
    solved: false,
  });
  if (!ctx) return null;
  const design = await designOf(req.worldId);
  const misconceptions: Misconception[] = [];
  const seen = new Set<string>();
  const add = (text: string | undefined, owner?: Misconception['owner']) => {
    const t = text?.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    misconceptions.push({ text: t, ...(owner ? { owner } : {}) });
  };
  // The cast's first: those are the ones somebody can walk in and voice.
  for (const member of design?.outline?.cast ?? []) {
    add(member.misconception, { id: member.id, name: member.name });
  }
  for (const text of ctx.concept?.misconceptions ?? []) add(text);
  return {
    act: ctx.act,
    guide: ctx.guide,
    cast: ctx.world.cast,
    ...(ctx.concept ? { concept: ctx.concept } : {}),
    misconceptions,
  };
}

// --- what happened, computed ----------------------------------------------------------

const round = (n: number) => `${Math.round(n * 100) / 100}`;
const humanise = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();

export function diagnose(act: Act, attempt: AttemptReport): Diagnosis {
  const m = act.mechanic;

  if (m?.type === 'formula' && attempt.kind === 'formula') {
    const facts = [
      `They set: ${Object.entries(attempt.settings)
        .map(([k, v]) => `${humanise(k)} ${round(v)}`)
        .join(', ')}.`,
    ];
    const readout = act.stage?.readout;
    let fallback = 'Change one dial at a time and watch which way the result moves.';
    if (readout && Number.isFinite(attempt.outputs[readout.output])) {
      const value = attempt.outputs[readout.output]!;
      const unit = readout.unit ? ` ${readout.unit}` : '';
      const band = winningBand(m.spec, m.params, readout.output);
      let miss = '';
      if (band) {
        const g = gradeRun(value, band);
        miss =
          g.miss > 0
            ? `, ${round(g.miss)}${unit} past the winning span`
            : g.miss < 0
              ? `, ${round(-g.miss)}${unit} short of the winning span`
              : '';
      }
      facts.push(`The run ended at ${readout.label} ${round(value)}${unit}${miss}.`);
      const pushes = directions(m.spec, m.params, readout.output);
      if (pushes.length) {
        facts.push('Measured by running the act (true, trust over intuition):', ...pushes);
        const first = pushes[0]!.replace(/^- /, '');
        fallback = `Your run ended at ${round(value)}${unit}${miss}. One thing to hold on to: ${first}.`;
      }
    }
    return { facts, fallback };
  }

  if (m?.type === 'sequence' && attempt.kind === 'sequence') {
    const label = new Map(m.items.map((i) => [i.id, i.label]));
    const judged = judgeSequence(m, attempt.order);
    const facts = [
      `Their order: ${attempt.order.map((i) => label.get(i) ?? i).join(' → ')}.`,
      `${judged.kept} of ${judged.total} ordering rules hold.`,
      ...judged.broken.map(
        (r) =>
          `Broken: "${label.get(r.before)}" has to come before "${label.get(r.after)}", because ${r.why}`,
      ),
    ];
    const first = judged.broken[0];
    return {
      facts,
      fallback: first
        ? `Look at "${label.get(first.before)}" and "${label.get(first.after)}" again. ${first.why}`
        : 'Every card is placed; check the board again.',
    };
  }

  if (m?.type === 'evidence' && attempt.kind === 'evidence') {
    const doc = new Map(m.evidence.map((e) => [e.id, e]));
    const claim = new Map(m.claims.map((c) => [c.id, c.text]));
    const judged = judgeEvidence(m, attempt.pins);
    const facts = [
      `${judged.backed} of ${judged.total} claims are backed.`,
      ...judged.wrong.map(
        (w) =>
          `They pinned "${doc.get(w.evidence)?.title}" to "${claim.get(w.claim)}". That document shows: ${doc.get(w.evidence)?.shows}`,
      ),
      ...judged.empty.map((c) => `Nothing is pinned to "${claim.get(c)}".`),
    ];
    const wrong = judged.wrong[0];
    return {
      facts,
      fallback: wrong
        ? `Read "${doc.get(wrong.evidence)?.title}" again: it shows ${doc.get(wrong.evidence)?.shows} Does that prove the claim you pinned it to?`
        : 'Some claims still have nothing pinned to them.',
    };
  }

  return { facts: ['The attempt did not match this act.'], fallback: 'Try the act again.' };
}

// --- the answer must not be in it -----------------------------------------------------

/** An evidence pairing given away: a document named alongside the claim it proves. */
export function leakedPairing(text: string, act: Act): boolean {
  if (act.mechanic?.type !== 'evidence') return false;
  const said = text.toLowerCase();
  const claim = new Map(act.mechanic.claims.map((c) => [c.id, c.text]));
  return act.mechanic.links.some((l) => {
    const title =
      act.mechanic?.type === 'evidence'
        ? act.mechanic.evidence.find((e) => e.id === l.evidence)?.title.toLowerCase()
        : undefined;
    return !!title && said.includes(title) && sharedTerms(claim.get(l.claim) ?? '', text) >= 3;
  });
}

const leaks = (text: string, act: Act) =>
  leakedAnswer(text, act, false) !== null ||
  leakedOrder(text, act, false) ||
  leakedPairing(text, act);

/** A worked example of an order maps onto the answer step by step; never for a sequence. */
const givesAway = (reply: AdaptReply, act: Act) =>
  leaks(`${reply.voiceLine} ${reply.message}`, act) ||
  (act.mechanic?.type === 'sequence' && reply.technique === 'worked_example');

// --- asking ------------------------------------------------------------------------

export interface AdaptReply {
  misconceptionIndex: number;
  because: string;
  technique: TeachingMove['technique'];
  voiceLine: string;
  message: string;
}

export type AdaptAsker = (prompt: string, system: string) => Promise<AdaptReply>;

const defaultAsker: AdaptAsker = (prompt, system) =>
  generateJson<AdaptReply>(prompt, ADAPT_SCHEMA, {
    // The diagnosis is already computed; the model only chooses and phrases,
    // and a lesson that lands twenty seconds after the miss lands on nobody.
    role: 'fast',
    temperature: 0.5,
    systemInstruction: system,
    agent: 'Teaching director',
  });

export function adaptPrompt(
  ctx: AdaptContext,
  req: AdaptRequest,
  diagnosis: Diagnosis,
): { system: string; prompt: string } {
  const system = `You are the teaching director of an educational game. A player has just
failed an act. Decide which wrong idea best explains what they did, then write
two short lines that teach.

Rules:
- THE FACTS below are computed by the game from the player's attempt. They are
  true. Never contradict them; never invent other facts about the attempt.
- misconceptionIndex: the number of the listed wrong idea that the facts best
  point to, or -1 if none of them fits. Never describe a wrong idea of your own.
  When an idea with an OWNER fits the facts as well as one without, choose the
  owned one: that character can walk in and say it. Never force a poor fit.
- because: one sentence linking a specific fact to that wrong idea.
- voiceLine: if the chosen wrong idea has an OWNER, that character says it, in
  character, cheering the player's mistake on — under 25 words. It must sound
  like the wrong idea, confidently. Empty if there is no owner.
- message: ${ctx.guide.name}, the guide, answers with one teaching move, under 60
  words, in their own voice:
    contrast — set their attempt beside what would change it;
    worked_example — a small parallel example with different numbers or items,
      covering at most two or three steps — never an analogy that maps onto
      every step of the answer, which is the answer in costume;
    simpler_wording — the rule again, in plainer words;
    debug_mistake — walk through their own attempt to the step that broke.
  ${
    ctx.act.mechanic?.type === 'sequence'
      ? `This is an ordering act: NEVER use worked_example — any parallel example
  of an order is the answer in costume. Escalate: 1st failure contrast or
  simpler_wording, 2nd or later debug_mistake on a different broken link.`
      : `Escalate with repeated failure: 1st failure contrast or simpler_wording,
  2nd debug_mistake, 3rd or later worked_example.`
  }
- Never give the winning setting, the winning order, or which document proves
  which claim. Teach the idea that finds it.`;

  const list = ctx.misconceptions.length
    ? ctx.misconceptions
        .map((m, i) => `${i}. ${m.text}${m.owner ? ` (OWNER: ${m.owner.name})` : ''}`)
        .join('\n')
    : '(none listed)';

  const prompt = [
    `ACT: "${ctx.act.title}" — ${ctx.act.goal}`,
    ...(ctx.concept
      ? [
          `THE RULE THE ACT TEACHES: ${ctx.concept.keyRule}`,
          `FROM THE CHAPTER: "${ctx.concept.quote}"`,
        ]
      : []),
    '',
    'WRONG IDEAS (choose by number):',
    list,
    '',
    `THE FACTS (failure number ${req.failures} on this act):`,
    ...diagnosis.facts,
  ].join('\n');
  return { system, prompt };
}

function offlineMove(ctx: AdaptContext, diagnosis: Diagnosis): TeachingMove {
  return {
    technique: 'debug_mistake',
    speaker: ctx.guide.name,
    speakerId: ctx.guide.id,
    message: diagnosis.fallback,
    offline: true,
  };
}

/** Diagnose, ask, check, and fall back honestly. Never throws. */
export async function adapt(
  ctx: AdaptContext,
  req: AdaptRequest,
  ask: AdaptAsker = defaultAsker,
): Promise<TeachingMove> {
  const diagnosis = diagnose(ctx.act, req.attempt);
  const { system, prompt } = adaptPrompt(ctx, req, diagnosis);
  const techniques: TeachingMove['technique'][] = [
    'contrast',
    'worked_example',
    'simpler_wording',
    'debug_mistake',
  ];

  let reply: AdaptReply;
  try {
    reply = await ask(prompt, system);
    if (givesAway(reply, ctx.act)) {
      reply = await ask(
        `${prompt}\n\nYour previous lines gave the answer away. Write them again without any winning value, order or pairing, and without a worked example of an order.`,
        system,
      );
      if (givesAway(reply, ctx.act)) return offlineMove(ctx, diagnosis);
    }
  } catch (err) {
    console.warn('[adapt] no answer:', err instanceof Error ? err.message.slice(0, 160) : err);
    return offlineMove(ctx, diagnosis);
  }

  const message = String(reply.message ?? '')
    .trim()
    .slice(0, 600);
  if (!message) return offlineMove(ctx, diagnosis);
  const index = Number.isInteger(reply.misconceptionIndex) ? reply.misconceptionIndex : -1;
  const chosen = index >= 0 ? ctx.misconceptions[index] : undefined;
  const voiceLine = String(reply.voiceLine ?? '')
    .trim()
    .slice(0, 240);
  // Only a listed owner can walk in, and only one who is actually in the cast.
  const owner = chosen?.owner && ctx.cast.find((c) => c.id === chosen.owner!.id);

  return {
    technique: techniques.includes(reply.technique) ? reply.technique : 'contrast',
    speaker: ctx.guide.name,
    speakerId: ctx.guide.id,
    message,
    ...(chosen ? { misconception: chosen.text } : {}),
    ...(chosen && reply.because?.trim() ? { because: reply.because.trim().slice(0, 300) } : {}),
    ...(owner && voiceLine
      ? { voice: { characterId: owner.id, speaker: owner.name, line: voiceLine } }
      : {}),
  };
}
