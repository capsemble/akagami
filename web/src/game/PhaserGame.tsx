import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { Scene as WorldSceneData } from '@chapter-quest/shared';
import { WorldScene } from './WorldScene';

interface Props {
  scene: WorldSceneData;
  /** True while a React panel is on top, so the player stops walking behind it. */
  paused?: boolean;
}

/** Mounts one Phaser game and hands it the scene data. Events come back on gameBus. */
export function PhaserGame({ scene, paused = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

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

    // add(key, scene, autoStart, data) — the only form that guarantees init()
    // gets the data, whether or not the game has finished booting.
    game.scene.add(WorldScene.KEY, WorldScene, true, { scene });

    return () => {
      gameRef.current = null;
      game.destroy(true);
    };
  }, [scene]);

  useEffect(() => {
    const manager = gameRef.current?.scene;
    if (!manager) return;
    if (paused) manager.pause(WorldScene.KEY);
    else manager.resume(WorldScene.KEY);
  }, [paused]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
