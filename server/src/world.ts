/**
 * GameScript → World. Design-time artifacts into the runtime contract.
 *
 * The pipeline thinks in `ActSpec` and `SceneSpec`: prose, a mechanic, a list
 * of objects. The game thinks in `Act` and `Scene`: a scene id to load, a stage
 * bound to real geometry, portraits with file paths. This is the seam, and it
 * is the last place anything is allowed to be missing — every field the client
 * reads has to exist by the time it leaves here.
 */
import type { Act, Character, GameScript, Scene, World, WorldArt } from '@chapter-quest/shared';
import { completionOf } from '@chapter-quest/shared';
import { settleUnbound } from './pipeline/balance.js';
import { bindStage, mapScene, stepsFor } from './pipeline/mapper.js';

/** Scene ids are derived, not generated, so an act always finds its room. */
export const sceneIdFor = (actId: string): string => `scene-${actId}`;

/** Lay out every act's room once, keyed by the id the act will ask for. */
export function mapScenes(script: GameScript): Map<string, Scene> {
  const castIds = script.outline.cast.map((c) => c.id);
  const scenes = new Map<string, Scene>();
  for (const act of script.acts) {
    const id = sceneIdFor(act.id);
    // A painted floor arrives with its own clutter, so the mapper is told not
    // to scatter drawn crates over the top of it.
    const floor = script.art?.rooms?.[act.id];
    const room = mapScene(act.scene, id, {
      verbs: act.verbs,
      castIds,
      ...(floor ? { furnish: false } : {}),
    });
    scenes.set(id, hang(room, act.id, script.art));
  }
  return scenes;
}

/**
 * Hang the painted props on the rects the mapper already placed.
 *
 * The art director paints one sprite per interactable, keyed by the same id the
 * mapper lays out — that is the whole reason it paints props rather than a
 * backdrop. The url simply had nowhere to travel: `Interactable` carried a
 * label and a look and no way to say "and here is the picture of it", so every
 * prop in every generated world arrived at the client unpainted.
 *
 * Nothing load-bearing moves. A prop with no painting keeps its rect and the
 * renderer keeps drawing it.
 */
function hang(scene: Scene, actId: string, art?: WorldArt): Scene {
  if (!art) return scene;
  const floor = art.rooms?.[actId];
  return {
    ...scene,
    // The seam `Scene.imageUrl` was written for and nothing ever filled: a
    // painted floor for a room the mapper laid out. Absent, the client draws
    // its own, which is what every generated world has done so far.
    ...(floor ? { imageUrl: floor } : {}),
    interactables: scene.interactables.map((target) => {
      const url = art.props[target.id];
      return url ? { ...target, imageUrl: url } : target;
    }),
  };
}

/**
 * Portraits and sprites, painted if the art director got to them and placeholder
 * paths if it did not. The client never has to know which.
 */
function castOf(script: GameScript, art?: WorldArt): Character[] {
  return script.outline.cast.map((member) => {
    const painted = art?.portraits[member.id];
    const portrait = painted ?? `/mock-art/portrait-${member.id}-neutral.svg`;
    return {
      id: member.id,
      name: member.name,
      persona: member.persona,
      // One painted portrait stands in for all three moods: a generated cast
      // gets one plate each, and a missing mood would blank the dialogue box.
      portraits: painted
        ? { neutral: painted, pleased: painted, worried: painted }
        : {
            neutral: portrait,
            pleased: `/mock-art/portrait-${member.id}-pleased.svg`,
            worried: `/mock-art/portrait-${member.id}-worried.svg`,
          },
      sprite: art?.sprites[member.id] ?? `/mock-art/sprite-${member.id}.svg`,
    };
  });
}

/**
 * Who the player can ask. The first of the cast who is not there to be wrong:
 * the writers' room gives some characters a misconception to personify, and
 * sending a confused student to the character who embodies the confusion is a
 * trap, not a guide. Failing that, anyone — a guide with a flaw beats no guide.
 */
export function guideOf(script: Pick<GameScript, 'outline'>): string | undefined {
  const cast = script.outline.cast;
  return (cast.find((member) => !member.misconception?.trim()) ?? cast[0])?.id;
}

/** Every act as the runtime will see it, finishable or not. The audit reads this. */
export function buildActs(script: GameScript, scenes: Map<string, Scene>): Act[] {
  const objectives = new Map(script.curriculum?.concepts.map((c) => [c.id, c.keyRule]) ?? []);
  return script.acts.map((spec) => {
    const sceneId = sceneIdFor(spec.id);
    const scene = scenes.get(sceneId);
    const stage = scene ? bindStage(scene, spec) : undefined;
    const mechanic = spec.mechanic ? settleUnbound(spec.mechanic, stage) : undefined;
    return {
      id: spec.id,
      conceptId: spec.conceptId,
      title: spec.title,
      ...(objectives.get(spec.conceptId) ? { objective: objectives.get(spec.conceptId)! } : {}),
      goal: spec.goal,
      verbs: spec.verbs,
      sceneId,
      explainAfter: spec.explainAfter,
      ...(spec.prediction ? { prediction: spec.prediction } : {}),
      ...(mechanic ? { mechanic } : {}),
      // Written from the bindings, not by the model: the bindings are the only
      // thing that knows which key actually does what in this act.
      ...(scene
        ? {
            steps:
              mechanic?.type === 'sequence'
                ? sequenceSteps(scene)
                : mechanic?.type === 'evidence'
                  ? evidenceSteps(scene)
                  : stepsFor(stage, scene),
          }
        : {}),
      ...(stage ? { stage } : {}),
      ...(spec.dialogue?.length ? { dialogue: spec.dialogue } : {}),
      ...(spec.analogy?.text ? { analogy: spec.analogy } : {}),
    };
  });
}

/**
 * A sequence act is played at a board: E on any prop in the room opens it.
 * Named after the first prop, which is the one the act writer listed first.
 */
export function sequenceSteps(scene: Scene): string[] {
  const at = scene.interactables[0];
  const name = at?.label ?? at?.id.replace(/[-_]/g, ' ') ?? 'the board';
  return [
    `Walk up to the ${name} — WASD or the arrow keys — and press E to lay out the cards.`,
    'Put them in the order the concept demands: drag a card, or use the arrows beside it.',
    'Check the order. A broken link tells you why it is broken; fix it and check again.',
    'Reset puts the cards back where they started.',
  ];
}

/** An evidence act is played at a board too: documents on one side, claims on the other. */
export function evidenceSteps(scene: Scene): string[] {
  const at = scene.interactables[0];
  const name = at?.label ?? at?.id.replace(/[-_]/g, ' ') ?? 'the board';
  return [
    `Walk up to the ${name} — WASD or the arrow keys — and press E to spread out the documents.`,
    'Read each document. Pick one up, then pin it to the claim it proves — or drag it there.',
    'Not every document proves something. Check the board when every claim has its proof.',
    'Reset puts every document back on the table.',
  ];
}

/**
 * Throws when not one act of the script can be finished: a world of locked
 * rooms is not a world, and saying so beats handing one over.
 */
export class NoPlayableActsError extends Error {
  constructor(readonly omitted: NonNullable<World['omitted']>) {
    super(
      `No act in this world can be finished: ${omitted.map((o) => `${o.title} (${o.reason})`).join('; ')}`,
    );
    this.name = 'NoPlayableActsError';
  }
}

export function toWorld(script: GameScript, scenes: Map<string, Scene>): World {
  // An act the runtime cannot finish would be a room whose gate never opens,
  // and every act after it unreachable. Leave it out and say so on screen —
  // a shorter story the player is told about, never a softlock.
  const omitted: NonNullable<World['omitted']> = [];
  const acts = buildActs(script, scenes).filter((act) => {
    const completion = completionOf(act);
    if (!completion.ok)
      omitted.push({ actId: act.id, title: act.title, reason: completion.reason });
    return completion.ok;
  });
  if (acts.length === 0) throw new NoPlayableActsError(omitted);

  return {
    id: script.id,
    title: script.outline.title,
    logline: script.outline.logline,
    artStyle: script.outline.artStyle,
    cast: castOf(script, script.art),
    acts,
    status: 'ready',
    ...(script.art?.styleUrl ? { styleUrl: script.art.styleUrl } : {}),
    ...(guideOf(script) ? { guide: guideOf(script)! } : {}),
    ...(script.art?.playerSheet ? { playerSheet: script.art.playerSheet } : {}),
    ...(script.outline.villain ? { villain: script.outline.villain } : {}),
    ...(script.outline.twist ? { twist: script.outline.twist } : {}),
    ...(omitted.length ? { omitted } : {}),
  };
}
