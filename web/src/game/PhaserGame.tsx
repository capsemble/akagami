import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type {
  ActStage,
  Character,
  ParamSpec,
  SimSpec,
  Scene as WorldSceneData,
} from '@chapter-quest/shared';
import { WorldScene } from './WorldScene';
import { gameBus } from './bus';
import type { GameEvents } from './bus';

interface Props {
  scene: WorldSceneData;
  /** Who stands in the room. The scene says where; this says who and what they
   *  look like. */
  cast?: Character[];
  /** How this act is staged. Absent leaves the scene a plain walkable room. */
  stage?: ActStage | null;
  params?: ParamSpec[];
  /** The physics, for an act the player drives live. */
  spec?: SimSpec | null;
  /** The winning span along the playback path, in that path's units. */
  target?: { from: number; to: number; label?: string } | null;
  /** True while a React panel is on top, so the player stops walking behind it. */
  paused?: boolean;
  /** The cast member the player can walk up to and ask. */
  guide?: string;
  /**
   * True while the player is typing into a React field. Phaser captures W, A,
   * S, D, E, F, R and Space with preventDefault, so without this a question
   * could not contain the letter e.
   */
  typing?: boolean;
  /** The way out of the room, and whether it is open yet. */
  gate?: GameEvents['gate'];
  /** The player's painted walk sheet. Absent, the player is drawn. */
  playerSheet?: string;
}

/** Mounts one Phaser game and hands it the act. Events go both ways on gameBus. */
export function PhaserGame({
  scene,
  cast,
  stage = null,
  params,
  spec = null,
  target = null,
  paused = false,
  guide,
  typing = false,
  gate,
  playerSheet,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  // Read when a game is built, never a reason to build one: winning the act
  // opens the gate, and tearing the whole scene down to do it would throw the
  // player back to the spawn at the exact moment they earned the way out.
  const gateRef = useRef(gate);
  gateRef.current = gate;

  useEffect(() => {
    if (!hostRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: hostRef.current,
      width: 1280,
      height: 720,
      backgroundColor: '#1f140d',
      pixelArt: true,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 } } },
    });
    gameRef.current = game;
    // A handle on the running game, in dev only.
    //
    // Everything about this project's look is decided inside a canvas, and a
    // canvas is opaque: a screenshot says the room is wrong and nothing says
    // why. With this, a browser console or a headless script can ask the live
    // scene where the player actually is, how many objects are in the display
    // list, what the collider count is and what the frame rate is — which is
    // the difference between "it compiles" and "it works".
    if (import.meta.env.DEV) {
      (window as unknown as { chapterQuestGame?: Phaser.Game }).chapterQuestGame = game;
    }

    // add(key, scene, autoStart, data) — the only form that guarantees init()
    // gets the data, whether or not the game has finished booting.
    game.scene.add(WorldScene.KEY, WorldScene, true, {
      scene,
      cast,
      stage,
      params,
      spec,
      target,
      guide,
      gate: gateRef.current,
      playerSheet,
    });

    return () => {
      gameRef.current = null;
      if (import.meta.env.DEV) {
        delete (window as unknown as { chapterQuestGame?: Phaser.Game }).chapterQuestGame;
      }
      game.destroy(true);
    };
  }, [scene, cast, stage, params, spec, target, guide, playerSheet]);

  useEffect(() => {
    const manager = gameRef.current?.scene;
    if (!manager) return;
    if (paused) manager.pause(WorldScene.KEY);
    else manager.resume(WorldScene.KEY);
  }, [paused]);

  // Changes after that go to the running scene.
  useEffect(() => {
    if (gate) gameBus.emit('gate', gate);
  }, [gate?.open, gate?.leadsTo, gate?.last]);

  useEffect(() => {
    const game = gameRef.current;
    const keyboard = game?.input.keyboard;
    if (!game || !keyboard) return;
    keyboard.enabled = !typing;
    // A key released while Phaser was not listening would read as still held,
    // and the player would walk off on their own the moment the panel closed.
    if (!typing) game.scene.getScene(WorldScene.KEY)?.input.keyboard?.resetKeys();
  }, [typing]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
