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
import { bindStage, mapScene } from './pipeline/mapper.js';

/** Scene ids are derived, not generated, so an act always finds its room. */
export const sceneIdFor = (actId: string): string => `scene-${actId}`;

/** Lay out every act's room once, keyed by the id the act will ask for. */
export function mapScenes(script: GameScript): Map<string, Scene> {
  const castIds = script.outline.cast.map((c) => c.id);
  const scenes = new Map<string, Scene>();
  for (const act of script.acts) {
    const id = sceneIdFor(act.id);
    scenes.set(id, mapScene(act.scene, id, { verbs: act.verbs, castIds }));
  }
  return scenes;
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

export function toWorld(script: GameScript, scenes: Map<string, Scene>): World {
  const acts: Act[] = script.acts.map((spec) => {
    const sceneId = sceneIdFor(spec.id);
    const scene = scenes.get(sceneId);
    const stage = scene ? bindStage(scene, spec) : undefined;
    return {
      id: spec.id,
      conceptId: spec.conceptId,
      title: spec.title,
      goal: spec.goal,
      verbs: spec.verbs,
      sceneId,
      explainAfter: spec.explainAfter,
      ...(spec.prediction ? { prediction: spec.prediction } : {}),
      ...(spec.mechanic ? { mechanic: spec.mechanic } : {}),
      ...(stage ? { stage } : {}),
      ...(spec.dialogue?.length ? { dialogue: spec.dialogue } : {}),
    };
  });

  return {
    id: script.id,
    title: script.outline.title,
    logline: script.outline.logline,
    artStyle: script.outline.artStyle,
    cast: castOf(script, script.art),
    acts,
    status: 'ready',
    ...(script.outline.villain ? { villain: script.outline.villain } : {}),
    ...(script.outline.twist ? { twist: script.outline.twist } : {}),
  };
}
