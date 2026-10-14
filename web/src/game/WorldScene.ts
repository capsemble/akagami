import Phaser from 'phaser';
import type { Scene as WorldSceneData } from '@chapter-quest/shared';
import { gameBus } from './bus';

const PLAYER_SPEED = 260;
const INTERACT_RADIUS = 110;
const DEBUG_COLOR = 0xff00ff;

export interface WorldSceneInit {
  scene: WorldSceneData;
}

/**
 * Walk a painted scene. Colliders and interactables come straight from the
 * Scene fixture, so the art and the physics can never drift apart.
 *
 * WASD / arrows to move, E to interact, B for the collider overlay.
 */
export class WorldScene extends Phaser.Scene {
  static readonly KEY = 'WorldScene';

  private sceneData!: WorldSceneData;
  private player!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<
    'up' | 'down' | 'left' | 'right' | 'interact' | 'debug',
    Phaser.Input.Keyboard.Key
  >;
  private prompt!: Phaser.GameObjects.Text;
  private debugLayer!: Phaser.GameObjects.Graphics;
  private debugOn = false;
  private nearby: string | null = null;

  constructor() {
    super(WorldScene.KEY);
  }

  init(init: WorldSceneInit): void {
    this.sceneData = init.scene;
  }

  preload(): void {
    this.load.svg(`bg-${this.sceneData.id}`, this.sceneData.imageUrl, {
      width: this.sceneData.width,
      height: this.sceneData.height,
    });
    this.load.svg('player', '/mock-art/player.svg', { width: 32, height: 48 });
  }

  create(): void {
    const { width, height, blocked, interactables, exits, spawn } = this.sceneData;

    this.add.image(0, 0, `bg-${this.sceneData.id}`).setOrigin(0, 0).setDepth(0);
    this.physics.world.setBounds(0, 0, width, height);

    const walls = blocked.map((rect) => {
      const zone = this.add.zone(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w, rect.h);
      this.physics.add.existing(zone, true);
      return zone;
    });

    this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player').setDepth(10);
    this.player.setCollideWorldBounds(true);
    this.player.body.setSize(24, 20).setOffset(4, 28); // feet only, so the head overlaps shelves
    this.physics.add.collider(this.player, walls);

    this.cameras.main.setBounds(0, 0, width, height);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setBackgroundColor('#1f140d');

    const keyboard = this.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.keys = {
      up: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      interact: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E),
      debug: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.B),
    };

    this.prompt = this.add
      .text(this.scale.width / 2, this.scale.height - 48, '', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: '#f4ecd8',
        backgroundColor: '#000000bb',
        padding: { x: 10, y: 6 },
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(100)
      .setVisible(false);

    this.debugLayer = this.add.graphics().setDepth(90).setVisible(false);
    this.debugLayer.lineStyle(2, DEBUG_COLOR, 1);
    this.debugLayer.fillStyle(DEBUG_COLOR, 0.18);
    for (const rect of blocked) {
      this.debugLayer.fillRect(rect.x, rect.y, rect.w, rect.h);
      this.debugLayer.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
    this.debugLayer.lineStyle(2, 0x6fb6ff, 1);
    for (const it of interactables) this.debugLayer.strokeRect(it.x, it.y, it.w, it.h);
    for (const exit of exits) this.debugLayer.strokeRect(exit.x, exit.y, exit.w, exit.h);

    keyboard.on('keydown-B', () => {
      this.debugOn = !this.debugOn;
      this.debugLayer.setVisible(this.debugOn);
    });

    keyboard.on('keydown-E', () => {
      if (this.nearby) gameBus.emit('interact', { id: this.nearby });
    });

    gameBus.emit('ready', { sceneId: this.sceneData.id });
  }

  override update(): void {
    const body = this.player.body;
    const left = this.cursors.left.isDown || this.keys.left.isDown;
    const right = this.cursors.right.isDown || this.keys.right.isDown;
    const up = this.cursors.up.isDown || this.keys.up.isDown;
    const down = this.cursors.down.isDown || this.keys.down.isDown;

    const vx = (right ? 1 : 0) - (left ? 1 : 0);
    const vy = (down ? 1 : 0) - (up ? 1 : 0);
    body.setVelocity(vx * PLAYER_SPEED, vy * PLAYER_SPEED);
    if (vx !== 0 && vy !== 0) body.velocity.normalize().scale(PLAYER_SPEED);
    if (vx !== 0) this.player.setFlipX(vx < 0);

    this.nearby = this.closestInteractable();
    this.prompt.setVisible(this.nearby !== null);
    if (this.nearby) this.prompt.setText(`Press E — ${this.nearby.replace(/-/g, ' ')}`);
  }

  private closestInteractable(): string | null {
    let best: string | null = null;
    let bestDistance = INTERACT_RADIUS;
    for (const it of this.sceneData.interactables) {
      const distance = Phaser.Math.Distance.Between(
        this.player.x,
        this.player.y,
        it.x + it.w / 2,
        it.y + it.h / 2,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = it.id;
      }
    }
    return best;
  }
}
