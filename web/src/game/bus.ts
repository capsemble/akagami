/**
 * The only wire between Phaser and React. Phaser emits, React listens.
 * Keep it this narrow — if a component reaches into the scene, it gets messy fast.
 */
export interface GameEvents {
  interact: { id: string };
  ready: { sceneId: string };
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
