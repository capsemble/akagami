import type { SimSample } from '@chapter-quest/shared';

/**
 * The only wire between Phaser and React. Keep it this narrow — if a component
 * reaches into the scene, it gets messy fast.
 *
 * It runs both ways now. Phaser owns the act while it is being played: the
 * player plants a marker or pulls an aim vector, and the scene reports the
 * numbers that came out of it. React owns the simulation and the verdict: it
 * runs the physics on those numbers and hands the samples back to be acted out.
 * Nothing else crosses.
 */
export interface GameEvents {
  // --- Phaser → React ---
  /** E on an interactable that is not a readable and not the act's own control. */
  interact: { id: string };
  ready: { sceneId: string };
  /** Live while the player is still choosing, so the HUD can echo the value. */
  aiming: { values: Record<string, number> };
  /** The player has committed. Run the simulation on exactly these. */
  commit: { values: Record<string, number> };
  /** E on something the stage says can be read. */
  read: { id: string };
  /** The run has finished and the verdict can land. A live act reports its own
   *  outputs, because React never simulated it — the player did. */
  played: { won: boolean; outputs?: Record<string, number> };
  /** E beside the guide: open the conversation. */
  ask: { characterId: string };
  /** The player has walked through the open gate. Take them to what is beyond it. */
  exit: Record<string, never>;

  // --- React → Phaser ---
  /** A finished run, to act out in the scene. */
  outcome: { won: boolean; values: Record<string, number>; samples: SimSample[] };
  /** Back to unsolved: clear the marker, the trail, the needle. */
  reset: Record<string, never>;
  /**
   * The way out of the room. Shut until the act is won; then it opens onto the
   * next act, or onto the end of the story from the last one.
   */
  gate: { open: boolean; leadsTo: string; last: boolean };
}

type Handler<K extends keyof GameEvents> = (payload: GameEvents[K]) => void;

class GameBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(event: K, handler: Handler<K>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as Handler<never>);
    this.handlers.set(event, set);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as Handler<K>)(payload);
    }
  }
}

export const gameBus = new GameBus();
