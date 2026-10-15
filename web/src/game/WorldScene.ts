import Phaser from 'phaser';
import type { Rect, Scene as WorldSceneData } from '@chapter-quest/shared';
import { isoDepth, isoDiamond, isoInputToWorld, isoProject, isoView } from '@chapter-quest/shared';
import type { IsoView } from '@chapter-quest/shared';
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
 * The world is always a flat plane of axis-aligned rectangles and Arcade
 * physics always runs on that plane. An isometric scene changes only how the
 * plane is drawn: positions are projected, sprites are depth-sorted back to
 * front, and input is rotated so "up" walks away from the camera.
 *
 * WASD / arrows to move, E to interact, B for the collider overlay.
 */
export class WorldScene extends Phaser.Scene {
  static readonly KEY = 'WorldScene';

  private sceneData!: WorldSceneData;
  private iso: IsoView | null = null;
  /** Physics body on the world plane. Invisible when isometric. */
  private player!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  /** What the player actually sees. Same sprite when top-down. */
  private avatar!: Phaser.GameObjects.Sprite;
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
    this.iso =
      init.scene.projection === 'isometric' ? isoView(init.scene.width, init.scene.height) : null;
  }

  preload(): void {
    const view = this.viewSize();
    this.load.svg(`bg-${this.sceneData.id}`, this.sceneData.imageUrl, {
      width: view.width,
      height: view.height,
    });
    this.load.svg('player', '/mock-art/player.svg', { width: 32, height: 48 });
  }

  /** Pixel size of the drawn scene, which is not the world size when isometric. */
  private viewSize(): { width: number; height: number } {
    if (this.sceneData.view) return this.sceneData.view;
    if (this.iso) return { width: this.iso.width, height: this.iso.height };
    return { width: this.sceneData.width, height: this.sceneData.height };
  }

  /** World plane point → where it is drawn. */
  private toScreen(x: number, y: number): { x: number; y: number } {
    return this.iso ? isoProject(x, y, this.iso) : { x, y };
  }

  create(): void {
    const { width, height, blocked, interactables, exits, spawn } = this.sceneData;
    const view = this.viewSize();

    this.add.image(0, 0, `bg-${this.sceneData.id}`).setOrigin(0, 0).setDepth(0);
    this.physics.world.setBounds(0, 0, width, height);

    const walls = blocked.map((rect) => {
      const zone = this.add.zone(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w, rect.h);
      this.physics.add.existing(zone, true);
      return zone;
    });

    if (this.iso) this.drawVolumes(blocked, interactables);

    this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player');
    this.player.setCollideWorldBounds(true);
    this.player.body.setSize(24, 20).setOffset(4, 28); // feet only, so the head overlaps shelves
    this.physics.add.collider(this.player, walls);

    if (this.iso) {
      // The body stays on the plane; a separate sprite is drawn at the
      // projected position so the camera and depth sorting work in screen space.
      this.player.setVisible(false);
      this.avatar = this.add.sprite(0, 0, 'player').setOrigin(0.5, 0.85);
      this.syncAvatar();
    } else {
      this.player.setDepth(10);
      this.avatar = this.player;
    }

    this.cameras.main.setBounds(0, 0, view.width, view.height);
    this.cameras.main.startFollow(this.avatar, true, 0.12, 0.12);
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
      .setDepth(10000)
      .setVisible(false);

    this.debugLayer = this.add.graphics().setDepth(9000).setVisible(false);
    this.drawDebug(blocked, interactables, exits);

    keyboard.on('keydown-B', () => {
      this.debugOn = !this.debugOn;
      this.debugLayer.setVisible(this.debugOn);
    });

    keyboard.on('keydown-E', () => {
      if (this.nearby) gameBus.emit('interact', { id: this.nearby });
    });

    gameBus.emit('ready', { sceneId: this.sceneData.id });
  }

  /**
   * Placeholder props: every blocked rect is extruded into an isometric box at
   * runtime, so the shelves line up with the colliders by construction and the
   * player can walk behind them. Painted props replace this, same geometry.
   */
  private drawVolumes(blocked: Rect[], interactables: (Rect & { id: string })[]): void {
    if (!this.iso) return;
    const view = this.iso;

    const volumes: (Rect & { tint: number })[] = [
      ...blocked.map((r) => ({ ...r, tint: 0x3a2514 })),
      ...interactables.map((r) => ({ ...r, height: r.height ?? 34, tint: 0xd9a441 })),
    ];

    for (const volume of volumes) {
      const lift = volume.height ?? 70;
      const top = isoDiamond(volume, view).map((p) => ({ x: p.x, y: p.y - lift }));
      const base = isoDiamond(volume, view);
      const g = this.add.graphics();

      // Left and right faces, darker, so the box reads as solid.
      g.fillStyle(darken(volume.tint, 0.55), 1);
      g.beginPath();
      g.moveTo(base[3]!.x, base[3]!.y);
      g.lineTo(base[2]!.x, base[2]!.y);
      g.lineTo(top[2]!.x, top[2]!.y);
      g.lineTo(top[3]!.x, top[3]!.y);
      g.closePath();
      g.fillPath();

      g.fillStyle(darken(volume.tint, 0.75), 1);
      g.beginPath();
      g.moveTo(base[1]!.x, base[1]!.y);
      g.lineTo(base[2]!.x, base[2]!.y);
      g.lineTo(top[2]!.x, top[2]!.y);
      g.lineTo(top[1]!.x, top[1]!.y);
      g.closePath();
      g.fillPath();

      g.fillStyle(volume.tint, 1);
      g.beginPath();
      g.moveTo(top[0]!.x, top[0]!.y);
      for (const corner of top.slice(1)) g.lineTo(corner.x, corner.y);
      g.closePath();
      g.fillPath();

      // Depth from the front corner: the player passes in front once past it.
      g.setDepth(isoDepth(volume.x + volume.w, volume.y + volume.h));
    }
  }

  private drawDebug(
    blocked: Rect[],
    interactables: (Rect & { id: string })[],
    exits: Rect[],
  ): void {
    const outline = (rect: Rect, color: number) => {
      this.debugLayer.lineStyle(2, color, 1);
      this.debugLayer.fillStyle(color, 0.18);
      if (this.iso) {
        const points = isoDiamond(rect, this.iso).map((p) => new Phaser.Geom.Point(p.x, p.y));
        this.debugLayer.fillPoints(points, true);
        this.debugLayer.strokePoints(points, true);
      } else {
        this.debugLayer.fillRect(rect.x, rect.y, rect.w, rect.h);
        this.debugLayer.strokeRect(rect.x, rect.y, rect.w, rect.h);
      }
    };

    for (const rect of blocked) outline(rect, DEBUG_COLOR);
    for (const rect of interactables) outline(rect, 0x6fb6ff);
    for (const rect of exits) outline(rect, 0x3f7f2e);
  }

  private syncAvatar(): void {
    if (!this.iso) return;
    const p = isoProject(this.player.x, this.player.y, this.iso);
    this.avatar.setPosition(p.x, p.y);
    this.avatar.setDepth(isoDepth(this.player.x, this.player.y) + 1);
  }

  override update(): void {
    const body = this.player.body;
    const left = this.cursors.left.isDown || this.keys.left.isDown;
    const right = this.cursors.right.isDown || this.keys.right.isDown;
    const up = this.cursors.up.isDown || this.keys.up.isDown;
    const down = this.cursors.down.isDown || this.keys.down.isDown;

    const ix = (right ? 1 : 0) - (left ? 1 : 0);
    const iy = (down ? 1 : 0) - (up ? 1 : 0);

    // Isometric input is rotated into world space, so the keys match the screen.
    const move = this.iso ? isoInputToWorld(ix, iy) : normalise(ix, iy);
    body.setVelocity(move.x * PLAYER_SPEED, move.y * PLAYER_SPEED);
    if (ix !== 0) this.avatar.setFlipX(ix < 0);

    this.syncAvatar();

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

function normalise(x: number, y: number): { x: number; y: number } {
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
}

function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}
