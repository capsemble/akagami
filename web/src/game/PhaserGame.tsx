import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import type { Scene as WorldSceneData } from '@chapter-quest/shared';
import { WorldScene } from './WorldScene';

interface Props {
  scene: WorldSceneData;
}

/** Mounts one Phaser game and hands it the scene data. Events come back on gameBus. */
export function PhaserGame({ scene }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

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
      scene: [WorldScene],
    });

    game.scene.start(WorldScene.KEY, { scene });

    return () => game.destroy(true);
  }, [scene]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />;
}
