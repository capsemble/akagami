import Phaser from 'phaser';
import type {
  ActStage,
  ParamBinding,
  ParamSpec,
  Playback,
  Point,
  Rect,
  Scene as WorldSceneData,
  SimSample,
  SimSpec,
  WorldPath,
} from '@chapter-quest/shared';
import {
  Run,
  compile,
  evaluate,
  isoDepth,
  isoDiamond,
  isoInputToWorld,
  isoProject,
  isoView,
} from '@chapter-quest/shared';
import type { CompiledExpr, ExprScope, IsoView } from '@chapter-quest/shared';
import { gameBus } from './bus';

const PLAYER_SPEED = 260;
const INTERACT_RADIUS = 110;
/** How close to the line you must stand before a marker can go down. */
const PLANT_RADIUS = 220;
/** Auto-repeat while an arrow is held: slow at first, then quick. A tap is
 *  always exactly one step, so the last few can be placed exactly. */
const NEEDLE_SLOW = 8;
const NEEDLE_FAST = 28;
const NEEDLE_RAMP = 500;
/** How many past attempts stay on the track. Enough to see the pattern. */
const GHOST_LIMIT = 4;
const DEBUG_COLOR = 0xff00ff;
const GOLD = 0xd9a441;
const GREEN = 0x6fbf73;
const RED = 0xc05746;
const PARCHMENT = 0xf4ecd8;

export interface WorldSceneInit {
  scene: WorldSceneData;
  /** How this act is staged. Absent leaves the scene a plain walkable room. */
  stage?: ActStage | null;
  params?: ParamSpec[];
  /**
   * The physics, for an act driven live. A run stepped by the player cannot
   * round-trip through React every frame, so the scene holds the spec and
   * reports the result — `simulate` and the live `Run` are the same engine.
   */
  spec?: SimSpec | null;
  /** The winning span along the playback path, in that path's units. */
  target?: { from: number; to: number; label?: string } | null;
}

/** What the player is doing right now. Walking is the only mode that moves. */
type Mode = 'walk' | 'needle' | 'aim' | 'playing' | 'driving';

/** One finished attempt, kept on the track so the next one has something to beat. */
interface Ghost {
  points: Point[];
  won: boolean;
  /**
   * Where the control first went on, and how far it took to stop from there.
   * Three attempts side by side show that span staying the same while the
   * whole thing slides down the hill — which is the entire concept.
   */
  mark?: { index: number; span: number; unit?: string };
}

/**
 * Walk a painted scene and play the act inside it.
 *
 * Colliders and interactables come straight from the Scene fixture, so the art
 * and the physics can never drift apart. The world is always a flat plane of
 * axis-aligned rectangles and Arcade physics always runs on that plane. An
 * isometric scene changes only how the plane is drawn: positions are projected,
 * sprites are depth-sorted back to front, and input is rotated so "up" walks
 * away from the camera.
 *
 * On top of that sits the stage. A mechanic's params are numbers, and a binding
 * says where each number comes from — a place you walk to and mark, a needle you
 * push off its band, a vector you drag out of a launcher. The run that follows
 * is acted out here too: the train really rolls, the satchel really falls short.
 * The chart is something you ask for afterwards, once you have already seen it.
 *
 * WASD / arrows move · E acts · F runs · R resets · B colliders.
 */
export class WorldScene extends Phaser.Scene {
  static readonly KEY = 'WorldScene';

  private sceneData!: WorldSceneData;
  private stage: ActStage | null = null;
  private params: ParamSpec[] = [];
  private target: { from: number; to: number; label?: string } | null = null;
  private simSpec: SimSpec | null = null;
  private iso: IsoView | null = null;

  /** Physics body on the world plane. Invisible when isometric. */
  private player!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  /** What the player actually sees. Same sprite when top-down. */
  private avatar!: Phaser.GameObjects.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<
    'up' | 'down' | 'left' | 'right' | 'interact' | 'run' | 'reset' | 'control' | 'debug',
    Phaser.Input.Keyboard.Key
  >;

  private prompt!: Phaser.GameObjects.Text;
  private readout!: Phaser.GameObjects.Text;
  private debugLayer!: Phaser.GameObjects.Graphics;
  /** The path and its target band. Redrawn only when the act changes state. */
  private stageLayer!: Phaser.GameObjects.Graphics;
  /** The marker ghost and the aim vector, which move every frame. */
  private ghostLayer!: Phaser.GameObjects.Graphics;
  /** The needle face, which is screen-space. */
  private hudLayer!: Phaser.GameObjects.Graphics;
  private trailLayer!: Phaser.GameObjects.Graphics;
  /** Finished attempts, dimmed. The lesson is in the difference between them. */
  private ghostLayer2!: Phaser.GameObjects.Graphics;
  private stageLabels: Phaser.GameObjects.Text[] = [];
  private ghostLabel!: Phaser.GameObjects.Text;
  private actor: Phaser.GameObjects.Graphics | null = null;
  /** Whoever else is moving on this path. Visible before you commit, so the
   *  pressure is something you see rather than something you are told. */
  private rival: Phaser.GameObjects.Graphics | null = null;

  private debugOn = false;
  private nearby: string | null = null;
  private mode: Mode = 'walk';
  /** Current param values. Starts at the declared defaults, which never win. */
  private values: Record<string, number> = {};
  /** Set once a marker binding has been planted, so F knows the act is armed. */
  private planted = false;
  /** Milliseconds an arrow has been held, for the needle's auto-repeat. */
  private needleHeld = 0;
  /** The live run, while one is being driven. */
  private run: Run | null = null;
  private alongExpr: CompiledExpr | null = null;
  private liftExpr: CompiledExpr | null = null;
  private live: Point[] = [];
  private ghosts: Ghost[] = [];
  private ghostTexts: Phaser.GameObjects.Text[] = [];
  /** Index into `live` where the control first went on, and the value there. */
  private braked: { index: number; value: number } | null = null;
  /** True while the camera is left looking at where a run ended. */
  private cameraParked = false;

  constructor() {
    super(WorldScene.KEY);
  }

  init(init: WorldSceneInit): void {
    this.sceneData = init.scene;
    this.stage = init.stage ?? null;
    this.params = init.params ?? [];
    this.target = init.target ?? null;
    this.simSpec = init.spec ?? null;
    this.iso =
      init.scene.projection === 'isometric' ? isoView(init.scene.width, init.scene.height) : null;
    this.mode = 'walk';
    this.planted = false;
    this.values = Object.fromEntries(this.params.map((p) => [p.name, p.default]));
    this.stageLabels = [];
    this.actor = null;
    this.rival = null;
    this.run = null;
    this.live = [];
    this.ghosts = [];
    this.ghostTexts = [];
    this.braked = null;
    this.cameraParked = false;
  }

  preload(): void {
    const view = this.viewSize();
    if (this.sceneData.imageUrl) {
      this.load.svg(`bg-${this.sceneData.id}`, this.sceneData.imageUrl, {
        width: view.width,
        height: view.height,
      });
    }
    this.load.svg('player', '/mock-art/player.svg', { width: 32, height: 48 });
  }

  /** Pixel size of the drawn scene, which is not the world size when isometric. */
  private viewSize(): { width: number; height: number } {
    if (this.sceneData.view) return this.sceneData.view;
    if (this.iso) return { width: this.iso.width, height: this.iso.height };
    return { width: this.sceneData.width, height: this.sceneData.height };
  }

  /** World plane point → where it is drawn. */
  private toScreen(x: number, y: number): Point {
    return this.iso ? isoProject(x, y, this.iso) : { x, y };
  }

  create(): void {
    const { width, height, blocked, interactables, exits, spawn } = this.sceneData;
    const view = this.viewSize();

    if (this.sceneData.imageUrl) {
      this.add.image(0, 0, `bg-${this.sceneData.id}`).setOrigin(0, 0).setDepth(0);
    } else {
      this.drawGround(width, height);
    }
    this.physics.world.setBounds(0, 0, width, height);

    const walls = blocked.map((rect) => {
      const zone = this.add.zone(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w, rect.h);
      this.physics.add.existing(zone, true);
      return zone;
    });

    this.stageLayer = this.add.graphics().setDepth(1);

    if (this.iso) this.drawVolumes(blocked, interactables);

    this.ghostLayer = this.add.graphics().setDepth(8500);
    this.ghostLayer2 = this.add.graphics().setDepth(8550);
    this.trailLayer = this.add.graphics().setDepth(8600);

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
      run: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.F),
      reset: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R),
      control: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      debug: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.B),
    };
    keyboard.addCapture('SPACE'); // or the page scrolls out from under the train

    this.prompt = this.screenText(this.scale.height - 44, 18, '#f4ecd8');
    this.readout = this.screenText(this.scale.height - 86, 26, '#d9a441');
    this.ghostLabel = this.add
      .text(0, 0, '', {
        fontFamily: 'monospace',
        fontSize: '17px',
        color: '#d9a441',
        backgroundColor: '#0b0806dd',
        padding: { x: 7, y: 4 },
      })
      .setOrigin(0.5, 1)
      .setDepth(9200)
      .setVisible(false);

    this.hudLayer = this.add.graphics().setScrollFactor(0).setDepth(9500);
    this.debugLayer = this.add.graphics().setDepth(9000).setVisible(false);
    this.drawDebug(blocked, interactables, exits);

    keyboard.on('keydown-B', () => {
      this.debugOn = !this.debugOn;
      this.debugLayer.setVisible(this.debugOn);
    });

    keyboard.on('keydown-E', () => this.onAct());
    keyboard.on('keydown-F', () => this.onRun());
    keyboard.on('keydown-R', () => this.resetStage());
    keyboard.on('keydown-ESC', () => {
      if (this.mode === 'needle' || this.mode === 'aim') this.leaveFocus();
    });

    this.setUpAim();
    this.drawStage();

    // The bus outlives the scene: every act swap builds a new one, so a
    // subscription left behind would be a dead scene still being handed runs.
    const off = [
      gameBus.on('outcome', (payload) => this.playOutcome(payload)),
      gameBus.on('reset', () => this.resetStage()),
    ];
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => off.forEach((remove) => remove()));
    this.events.on(Phaser.Scenes.Events.PAUSE, () => this.showChrome(false));
    this.events.on(Phaser.Scenes.Events.RESUME, () => this.showChrome(true));
    this.events.once(Phaser.Scenes.Events.DESTROY, () => off.forEach((remove) => remove()));

    gameBus.emit('ready', { sceneId: this.sceneData.id });
  }

  /** The canvas draws over the DOM, so its own chrome has to stand down when a
   *  React panel comes up. */
  private showChrome(visible: boolean): void {
    if (!visible) {
      this.prompt.setVisible(false);
      this.readout.setVisible(false);
      this.ghostLabel.setVisible(false);
    } else if (this.mode === 'needle') {
      this.drawNeedle();
    }
  }

  /**
   * The floor, drawn rather than loaded. A room the mapper built has no painted
   * backdrop, and an isometric scene with no ground plane is a void with props
   * floating in it. Same geometry the art generator uses, so a painted room and
   * a generated one line up exactly.
   */
  private drawGround(width: number, height: number): void {
    const g = this.add.graphics().setDepth(0);
    const corner = (x: number, y: number) => this.toScreen(x, y);
    const plane = [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)];

    g.fillStyle(0x241709, 1);
    g.beginPath();
    g.moveTo(plane[0]!.x, plane[0]!.y);
    for (const p of plane.slice(1)) g.lineTo(p.x, p.y);
    g.closePath();
    g.fillPath();

    // A tile grid, so distance is readable while walking.
    g.lineStyle(1.5, 0x2d1e12, 0.65);
    const tile = 200;
    for (let x = 0; x <= width; x += tile) {
      const a = corner(x, 0);
      const b = corner(x, height);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokePath();
    }
    for (let y = 0; y <= height; y += tile) {
      const a = corner(0, y);
      const b = corner(width, y);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokePath();
    }

    g.fillStyle(0x2f5d8a, 0.8);
    for (const exit of this.sceneData.exits) {
      if (this.iso) {
        const points = isoDiamond(exit, this.iso).map((p) => new Phaser.Geom.Point(p.x, p.y));
        g.fillPoints(points, true);
      } else {
        g.fillRect(exit.x, exit.y, exit.w, exit.h);
      }
    }
  }

  private screenText(y: number, size: number, color: string): Phaser.GameObjects.Text {
    return this.add
      .text(this.scale.width / 2, y, '', {
        fontFamily: 'monospace',
        fontSize: `${size}px`,
        color,
        backgroundColor: '#000000cc',
        padding: { x: 11, y: 6 },
        align: 'center',
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(10000)
      .setVisible(false);
  }

  // --- stage geometry -----------------------------------------------------

  private binding<K extends ParamBinding['kind']>(
    kind: K,
  ): Extract<ParamBinding, { kind: K }> | null {
    const found = this.stage?.bindings.find((b) => b.kind === kind);
    return (found as Extract<ParamBinding, { kind: K }> | undefined) ?? null;
  }

  private spec(name: string): ParamSpec | undefined {
    return this.params.find((p) => p.name === name);
  }

  /** A value in path units → where that is on the world plane. Not clamped: an
   * overshoot has to be visible, because overshooting is how you lose. */
  private alongPath(path: WorldPath, value: number): Point {
    const span = path.toValue - path.fromValue;
    const t = span === 0 ? 0 : (value - path.fromValue) / span;
    return {
      x: path.from.x + (path.to.x - path.from.x) * t,
      y: path.from.y + (path.to.y - path.from.y) * t,
    };
  }

  /** A point on the plane → the nearest value on the path, clamped to its ends. */
  private valueAt(path: WorldPath, point: Point): { value: number; at: Point; distance: number } {
    const dx = path.to.x - path.from.x;
    const dy = path.to.y - path.from.y;
    const lengthSq = dx * dx + dy * dy;
    const raw =
      lengthSq === 0 ? 0 : ((point.x - path.from.x) * dx + (point.y - path.from.y) * dy) / lengthSq;
    const t = Phaser.Math.Clamp(raw, 0, 1);
    const at = { x: path.from.x + dx * t, y: path.from.y + dy * t };
    return {
      value: path.fromValue + (path.toValue - path.fromValue) * t,
      at,
      distance: Phaser.Math.Distance.Between(point.x, point.y, at.x, at.y),
    };
  }

  /** Screen pixels per path unit, for scaling heights off the same ruler. */
  private pathScale(path: WorldPath): number {
    const a = this.toScreen(path.from.x, path.from.y);
    const b = this.toScreen(path.to.x, path.to.y);
    const span = Math.abs(path.toValue - path.fromValue);
    return span === 0 ? 1 : Phaser.Math.Distance.Between(a.x, a.y, b.x, b.y) / span;
  }

  private clearLabels(): void {
    for (const label of this.stageLabels) label.destroy();
    this.stageLabels = [];
  }

  private label(at: Point, text: string, color = '#f4ecd8', size = 15, below = false): void {
    this.stageLabels.push(
      this.add
        .text(at.x, at.y, text, {
          fontFamily: 'monospace',
          fontSize: `${size}px`,
          color,
          backgroundColor: '#0b0806cc',
          padding: { x: 6, y: 3 },
        })
        .setOrigin(0.5, below ? 0 : 1)
        .setDepth(9100),
    );
  }

  private strokeSegment(
    g: Phaser.GameObjects.Graphics,
    from: Point,
    to: Point,
    color: number,
    alpha: number,
    width: number,
  ): void {
    const a = this.toScreen(from.x, from.y);
    const b = this.toScreen(to.x, to.y);
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.strokePath();
  }

  /** A little flag standing on the plane, drawn in screen space at `at`. */
  private drawFlag(g: Phaser.GameObjects.Graphics, at: Point, color: number, alpha: number): void {
    const p = this.toScreen(at.x, at.y);
    g.lineStyle(3, color, alpha);
    g.beginPath();
    g.moveTo(p.x, p.y);
    g.lineTo(p.x, p.y - 54);
    g.strokePath();
    g.fillStyle(color, alpha);
    g.beginPath();
    g.moveTo(p.x, p.y - 54);
    g.lineTo(p.x + 30, p.y - 44);
    g.lineTo(p.x, p.y - 34);
    g.closePath();
    g.fillPath();
    g.fillStyle(color, alpha * 0.35);
    g.fillEllipse(p.x, p.y, 34, 17);
  }

  /** The line you walk and the span you are trying to stop inside. */
  private drawStage(): void {
    this.stageLayer.clear();
    this.clearLabels();
    const stage = this.stage;
    if (!stage) return;

    const marker = this.binding('marker');
    const playback = stage.playback;

    // The route, as a line on the ground. Sleepers along it so distance reads.
    const route = playback?.path ?? marker?.path;
    if (route) {
      this.strokeSegment(this.stageLayer, route.from, route.to, PARCHMENT, 0.22, 7);
      const span = route.toValue - route.fromValue;
      const stepSize = niceStep(Math.abs(span));
      for (let v = route.fromValue; v <= route.toValue + 1e-6; v += stepSize) {
        const p = this.toScreen(...pointArgs(this.alongPath(route, v)));
        this.stageLayer.fillStyle(PARCHMENT, 0.3);
        this.stageLayer.fillRect(p.x - 9, p.y - 2, 18, 4);
      }
      const end = this.toScreen(...pointArgs(this.alongPath(route, route.toValue)));
      this.label(
        { x: end.x, y: end.y - 8 },
        `${format(route.toValue)}${route.unit ?? ''}`,
        '#f4ecd899',
        13,
      );
    }

    // Where the marker may go: the stretch of route you are allowed to use.
    if (marker) {
      this.strokeSegment(this.stageLayer, marker.path.from, marker.path.to, GOLD, 0.5, 9);
      if (this.planted) {
        const value = this.values[marker.param] ?? 0;
        this.drawFlag(this.stageLayer, this.alongPath(marker.path, value), GOLD, 1);
        const p = this.toScreen(...pointArgs(this.alongPath(marker.path, value)));
        this.label(
          { x: p.x, y: p.y - 58 },
          `marker — ${format(value)}${marker.path.unit ?? ''}`,
          '#d9a441',
        );
      }
    }

    // Whoever is racing you, at the moment the run would start.
    if (playback?.rival) {
      const at = this.rivalPoint(playback, 0);
      if (at) {
        this.rival?.destroy();
        this.rival = this.makeRival().setPosition(at.x, at.y);
        this.label({ x: at.x, y: at.y - 46 }, playback.rival.label, '#c05746', 14);
      }
    }

    // The span that counts as a win, painted where it actually is.
    if (this.target && playback) {
      const from = this.alongPath(playback.path, this.target.from);
      const to = this.alongPath(playback.path, this.target.to);
      this.strokeSegment(this.stageLayer, from, to, GREEN, 0.75, 13);
      const mid = this.toScreen(...pointArgs(this.alongPath(playback.path, midpoint(this.target))));
      this.label(
        { x: mid.x, y: mid.y + 26 },
        this.target.label ?? 'land in here',
        '#6fbf73',
        15,
        true,
      );
    }
  }

  // --- what E and F do ----------------------------------------------------

  private onAct(): void {
    if (this.mode === 'playing') return;
    if (this.mode === 'needle') {
      this.commit();
      return;
    }
    if (this.mode === 'aim') return; // the drag itself commits

    const readable = this.nearestReadable();
    if (readable) {
      gameBus.emit('read', { id: readable });
      return;
    }

    const needle = this.binding('needle');
    if (needle && this.nearAnchor(needle.at)) {
      this.mode = 'needle';
      this.drawNeedle();
      return;
    }

    const aim = this.binding('aim');
    if (aim && this.nearAnchor(aim.at)) {
      this.mode = 'aim';
      this.drawAim(null);
      return;
    }

    const marker = this.binding('marker');
    if (marker) {
      const hit = this.valueAt(marker.path, { x: this.player.x, y: this.player.y });
      if (hit.distance <= PLANT_RADIUS) {
        this.values[marker.param] = clampToSpec(hit.value, this.spec(marker.param));
        this.planted = true;
        this.ghostLayer.clear();
        this.ghostLabel.setVisible(false);
        this.drawStage();
        this.cameras.main.flash(120, 217, 164, 65);
        gameBus.emit('aiming', { values: { ...this.values } });
        return;
      }
    }

    if (this.nearby) gameBus.emit('interact', { id: this.nearby });
  }

  private onRun(): void {
    if (this.mode === 'playing' || this.mode === 'driving' || !this.stage) return;
    if (this.binding('control')) {
      this.startDrive();
      return;
    }
    if (this.binding('marker') && !this.planted) return;
    if (this.binding('aim') && this.mode !== 'aim' && !this.hasAimed) return;
    this.commit();
  }

  // --- driving ------------------------------------------------------------

  /**
   * Let her go. From here the physics is stepped by the frame with whatever the
   * player is holding, so the answer is *when* they act, not what they typed.
   */
  private startDrive(): void {
    const control = this.binding('control');
    const playback = this.stage?.playback;
    if (!control || !playback || !this.simSpec || !this.spec(control.param)) return;

    this.leaveFocus('keep');
    this.live = [];
    this.braked = null;
    this.trailLayer.clear();
    this.run = new Run(this.simSpec, { ...this.values });
    this.alongExpr = compile(playback.along);
    this.liftExpr = playback.lift ? compile(playback.lift) : null;

    this.actor?.destroy();
    this.actor = this.makeActor(playback.actor);
    const start = this.pathPoint(playback, playback.path.fromValue, 0);
    this.actor.setPosition(start.x, start.y);

    this.mode = 'driving';
    this.cameras.main.startFollow(this.actor, true, 0.16, 0.16);
    gameBus.emit('aiming', { values: { ...this.values } });
  }

  private tickDrive(delta: number): void {
    const control = this.binding('control');
    const playback = this.stage?.playback;
    const run = this.run;
    if (!control || !playback || !run || !this.alongExpr) return;
    this.player.body.setVelocity(0, 0);

    const held = this.keys.control.isDown || this.input.activePointer.isDown;
    const resting = this.spec(control.param)?.min ?? 0;
    run.advance(delta / 1000, { [control.param]: held ? control.held : resting });

    const scope = run.scope as ExprScope;
    const value = this.alongExpr.evaluate(scope);
    const here = this.pathPoint(playback, value, this.liftExpr ? this.liftExpr.evaluate(scope) : 0);
    this.actor?.setPosition(here.x, here.y);
    if (this.live.length === 0 || Phaser.Math.Distance.BetweenPoints(this.live.at(-1)!, here) > 2) {
      this.live.push(here);
    }
    if (held && !this.braked) this.braked = { index: this.live.length - 1, value };

    this.trailLayer.clear();
    this.strokePoints(this.trailLayer, this.live, held ? RED : GOLD, 0.9, 4);

    this.prompt
      .setText(
        held ? `${(control.label ?? 'brake').toUpperCase()} — hard on` : 'hold SPACE to brake',
      )
      .setColor(held ? '#c05746' : '#f4ecd8')
      .setPosition(this.scale.width / 2, this.scale.height - 44)
      .setVisible(true);

    if (run.done) this.finishDrive();
  }

  private finishDrive(): void {
    const run = this.run;
    if (!run) return;
    const result = run.finish();
    this.run = null;

    const span = this.braked
      ? (result.outputs.stopX ?? result.state.x ?? 0) - this.braked.value
      : 0;
    this.remember(
      this.live,
      result.won,
      this.braked
        ? {
            index: this.braked.index,
            span,
            ...(this.stage?.playback?.path.unit ? { unit: this.stage.playback.path.unit } : {}),
          }
        : undefined,
    );
    this.braked = null;
    this.trailLayer.clear();
    this.live = [];
    this.prompt.setColor('#f4ecd8');
    this.cameras.main.flash(
      180,
      ...(result.won ? ([111, 191, 115] as const) : ([192, 87, 70] as const)),
    );
    // Stay where she stopped: the player needs to see it before walking off.
    this.cameras.main.stopFollow();
    this.cameraParked = true;
    this.mode = 'walk';
    gameBus.emit('played', { won: result.won, outputs: result.outputs });
  }

  // --- what the last few attempts looked like -----------------------------

  private remember(points: Point[], won: boolean, mark?: Ghost['mark']): void {
    if (points.length < 2) return;
    this.ghosts.push({ points: [...points], won, ...(mark ? { mark } : {}) });
    while (this.ghosts.length > GHOST_LIMIT) this.ghosts.shift();
    this.drawGhosts();
  }

  /**
   * Every attempt stays on the track, in its own lane so they do not hide each
   * other — on a straight run they would otherwise draw the same line four
   * times. The braking stretch is drawn bold and labelled, so three attempts
   * read as three equal spans at three different places. That is the lesson,
   * with nothing to read.
   */
  private drawGhosts(): void {
    this.ghostLayer2.clear();
    for (const text of this.ghostTexts) text.destroy();
    this.ghostTexts = [];

    const count = this.ghosts.length;
    for (const [i, ghost] of this.ghosts.entries()) {
      const lane = count - 1 - i; // 0 is the newest, and sits on the track
      const shift = (p: Point): Point => ({ x: p.x, y: p.y - lane * 17 });
      const latest = lane === 0;
      const points = ghost.points.map(shift);

      this.strokePoints(
        this.ghostLayer2,
        points,
        latest ? (ghost.won ? GREEN : GOLD) : PARCHMENT,
        latest ? 0.85 : 0.3,
        latest ? 3 : 2,
      );

      if (ghost.mark && ghost.mark.index < points.length - 1) {
        const braking = points.slice(ghost.mark.index);
        this.strokePoints(this.ghostLayer2, braking, RED, latest ? 0.9 : 0.45, latest ? 5 : 3);

        const at = braking[0]!;
        this.ghostLayer2.lineStyle(2, RED, latest ? 0.95 : 0.5);
        this.ghostLayer2.beginPath();
        this.ghostLayer2.moveTo(at.x, at.y - 10);
        this.ghostLayer2.lineTo(at.x, at.y + 10);
        this.ghostLayer2.strokePath();

        const middle = braking[Math.floor(braking.length / 2)]!;
        this.ghostTexts.push(
          this.add
            .text(middle.x, middle.y - 12, `${format(ghost.mark.span)}${ghost.mark.unit ?? ''}`, {
              fontFamily: 'monospace',
              fontSize: latest ? '15px' : '13px',
              color: latest ? '#f4ecd8' : '#f4ecd888',
              backgroundColor: '#0b0806cc',
              padding: { x: 5, y: 2 },
            })
            .setOrigin(0.5, 1)
            .setAlpha(latest ? 1 : 0.65)
            .setDepth(8560),
        );
      }

      const end = points.at(-1)!;
      this.ghostLayer2.fillStyle(ghost.won ? GREEN : RED, latest ? 0.95 : 0.45);
      this.ghostLayer2.fillCircle(end.x, end.y, latest ? 8 : 5);
    }
  }

  private strokePoints(
    g: Phaser.GameObjects.Graphics,
    points: Point[],
    color: number,
    alpha: number,
    width: number,
  ): void {
    if (points.length < 2) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) g.lineTo(point.x, point.y);
    g.strokePath();
  }

  /** Hand the numbers to React, which owns the physics and the verdict. */
  private commit(): void {
    // Mode first: React answers on the same tick, so `playing` has to be true
    // before the event leaves or playOutcome will be refused.
    this.leaveFocus('keep');
    this.mode = 'playing';
    this.prompt.setVisible(false);
    gameBus.emit('commit', { values: { ...this.values } });
  }

  private leaveFocus(values: 'keep' | 'reset' = 'keep'): void {
    if (this.mode === 'needle' || this.mode === 'aim') this.mode = 'walk';
    this.hudLayer.clear();
    this.ghostLayer.clear();
    this.readout.setVisible(false);
    if (values === 'reset') this.ghostLabel.setVisible(false);
  }

  private resetStage(): void {
    if (this.mode === 'playing') return;
    this.values = Object.fromEntries(this.params.map((p) => [p.name, p.default]));
    this.planted = false;
    this.hasAimed = false;
    this.dragging = false;
    this.needleHeld = 0;
    this.leaveFocus('reset');
    this.trailLayer.clear();
    this.ghostLayer2.clear();
    for (const text of this.ghostTexts) text.destroy();
    this.ghostTexts = [];
    this.ghosts = [];
    this.live = [];
    this.braked = null;
    this.run = null;
    this.actor?.destroy();
    this.actor = null;
    this.cameras.main.startFollow(this.avatar, true, 0.12, 0.12);
    this.cameraParked = false;
    this.drawStage();
    gameBus.emit('aiming', { values: { ...this.values } });
  }

  private nearAnchor(at: Point): boolean {
    return (
      Phaser.Math.Distance.Between(this.player.x, this.player.y, at.x, at.y) < INTERACT_RADIUS * 1.8
    );
  }

  private nearestReadable(): string | null {
    const readables = this.stage?.readables;
    if (!readables || !this.nearby) return null;
    return this.nearby in readables ? this.nearby : null;
  }

  // --- the needle ---------------------------------------------------------

  /** Geometry of the dial face, in screen space. */
  private needleBar(): { x: number; y: number; w: number; h: number } {
    return { x: this.scale.width / 2 - 290, y: this.scale.height - 168, w: 580, h: 18 };
  }

  private drawNeedle(): void {
    const needle = this.binding('needle');
    const spec = needle && this.spec(needle.param);
    if (!needle || !spec) return;

    const bar = this.needleBar();
    const value = this.values[needle.param] ?? spec.default;
    const at = (v: number) =>
      bar.x +
      ((Phaser.Math.Clamp(v, spec.min, spec.max) - spec.min) / (spec.max - spec.min)) * bar.w;

    const g = this.hudLayer;
    g.clear();

    g.fillStyle(0x0b0806, 0.92);
    g.fillRoundedRect(bar.x - 26, bar.y - 100, bar.w + 52, 158, 10);

    g.fillStyle(0x3a2514, 1);
    g.fillRoundedRect(bar.x, bar.y, bar.w, bar.h, 9);

    // The band is the claim being tested: inside it, a person could have walked.
    if (needle.band) {
      const from = at(needle.band.from);
      const to = at(needle.band.to);
      g.fillStyle(GREEN, 0.75);
      g.fillRoundedRect(from, bar.y, Math.max(2, to - from), bar.h, 9);
    }

    const x = at(value);
    const outside =
      needle.band !== undefined && (value < needle.band.from || value > needle.band.to);
    const tint = outside ? RED : GOLD;
    g.lineStyle(3, tint, 1);
    g.beginPath();
    g.moveTo(x, bar.y - 18);
    g.lineTo(x, bar.y + bar.h + 12);
    g.strokePath();
    g.fillStyle(tint, 1);
    g.beginPath();
    g.moveTo(x, bar.y - 18);
    g.lineTo(x - 11, bar.y - 36);
    g.lineTo(x + 11, bar.y - 36);
    g.closePath();
    g.fillPath();

    const unit = needle.unit ? ` ${needle.unit}` : '';
    this.readout
      .setText(`${format(value)}${unit}`)
      .setColor(outside ? '#c05746' : '#d9a441')
      .setPosition(this.scale.width / 2, bar.y - 66)
      .setVisible(true);

    const caption = needle.band?.label ? `green — ${needle.band.label}` : '';
    this.prompt
      .setText(`← → set the needle · E confirm · Esc step back${caption ? `\n${caption}` : ''}`)
      .setPosition(this.scale.width / 2, bar.y + 92)
      .setVisible(true);
  }

  /**
   * One step per tap, and a steady repeat while held. Discrete on purpose: the
   * answer here is a particular number, and hunting for it with a continuous
   * slider is dexterity, not deduction.
   */
  private tickNeedle(delta: number): void {
    const needle = this.binding('needle');
    const spec = needle && this.spec(needle.param);
    if (!needle || !spec) return;

    this.player.body.setVelocity(0, 0);
    const leftKeys = [this.cursors.left, this.keys.left];
    const rightKeys = [this.cursors.right, this.keys.right];
    const held = (keys: Phaser.Input.Keyboard.Key[]) => keys.some((k) => k.isDown);
    const tapped = (keys: Phaser.Input.Keyboard.Key[]) =>
      keys.some((k) => Phaser.Input.Keyboard.JustDown(k));

    let steps = 0;
    const direction = held(rightKeys) ? 1 : held(leftKeys) ? -1 : 0;
    if (tapped(rightKeys) || tapped(leftKeys)) {
      steps = 1;
      this.needleHeld = 0;
    } else if (direction !== 0) {
      const before = this.needleHeld;
      this.needleHeld += delta;
      steps = repeatsBetween(before, this.needleHeld);
    } else {
      this.needleHeld = 0;
    }
    if (steps === 0 || direction === 0) return;

    const step = needleStep(spec.max - spec.min);
    const next = (this.values[needle.param] ?? spec.default) + direction * steps * step;
    this.values[needle.param] = snap(Phaser.Math.Clamp(next, spec.min, spec.max), step);
    this.drawNeedle();
    gameBus.emit('aiming', { values: { ...this.values } });
  }

  // --- the aim ------------------------------------------------------------

  private hasAimed = false;
  private dragging = false;

  private setUpAim(): void {
    const aim = this.binding('aim');
    if (!aim) return;

    const aimAt = (pointer: Phaser.Input.Pointer) =>
      this.drawAim(this.cameras.main.getWorldPoint(pointer.x, pointer.y));

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      if (this.mode !== 'aim') return;
      this.dragging = true;
      gameBus.emit('aiming', { values: { ...this.values } });
      aimAt(p);
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (this.mode === 'aim' && this.dragging) aimAt(p);
    });
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => {
      if (this.mode !== 'aim' || !this.dragging) return;
      this.dragging = false;
      aimAt(p);
      this.hasAimed = true;
      this.commit();
    });
  }

  /** Where the vector is drawn from: the muzzle, a little above the plane. */
  private aimAnchor(at: Point): Point {
    const p = this.toScreen(at.x, at.y);
    return { x: p.x, y: p.y - 46 };
  }

  private drawAim(pointer: Point | null): void {
    const aim = this.binding('aim');
    const specX = aim && this.spec(aim.paramX);
    const specY = aim && this.spec(aim.paramY);
    if (!aim || !specX || !specY) return;

    const maxDrag = aim.maxDrag ?? 170;
    const anchor = this.aimAnchor(aim.at);
    const dx = pointer ? Phaser.Math.Clamp(pointer.x - anchor.x, 0, maxDrag) : 0;
    const dy = pointer ? Phaser.Math.Clamp(anchor.y - pointer.y, 0, maxDrag) : 0;

    const vx = specX.min + (dx / maxDrag) * (specX.max - specX.min);
    const vy = specY.min + (dy / maxDrag) * (specY.max - specY.min);
    this.values[aim.paramX] = vx;
    this.values[aim.paramY] = vy;

    // Two perpendicular legs and their resultant. The legs are the lesson:
    // one of them buys time in the air, the other buys distance, and the drag
    // is the only place they are ever the same gesture.
    const g = this.ghostLayer;
    g.clear();
    const tip = { x: anchor.x + dx, y: anchor.y - dy };

    g.lineStyle(2, PARCHMENT, 0.45);
    dashed(g, anchor, { x: tip.x, y: anchor.y });
    dashed(g, { x: tip.x, y: anchor.y }, tip);

    g.lineStyle(5, GOLD, 0.95);
    g.beginPath();
    g.moveTo(anchor.x, anchor.y);
    g.lineTo(tip.x, tip.y);
    g.strokePath();
    g.fillStyle(GOLD, 1);
    g.fillCircle(tip.x, tip.y, 7);

    this.ghostLabel
      .setText(`forward ${format(vx)} · up ${format(vy)}`)
      .setPosition(tip.x, tip.y - 12)
      .setVisible(true);

    this.prompt
      .setText('drag from the launcher and release to fire · Esc step back')
      .setPosition(this.scale.width / 2, this.scale.height - 44)
      .setVisible(true);
  }

  // --- playing the run out ------------------------------------------------

  private playOutcome(payload: {
    won: boolean;
    values: Record<string, number>;
    samples: SimSample[];
  }): void {
    if (!this.sys.isActive()) return;
    const playback = this.stage?.playback;
    if (!playback) {
      // Nothing travels in this act: the verdict is the needle itself.
      this.mode = 'walk';
      this.cameras.main.flash(
        200,
        ...(payload.won ? ([111, 191, 115] as const) : ([192, 87, 70] as const)),
      );
      gameBus.emit('played', { won: payload.won });
      return;
    }

    const points = this.pathPoints(playback, payload.samples);
    if (points.length < 2) {
      this.mode = 'walk';
      gameBus.emit('played', { won: payload.won });
      return;
    }

    this.trailLayer.clear();
    this.actor?.destroy();
    this.actor = this.makeActor(playback.actor).setPosition(points[0]!.x, points[0]!.y);
    this.cameras.main.startFollow(this.actor, true, 0.16, 0.16);

    const cursor = { i: 0 };
    this.tweens.add({
      targets: cursor,
      i: points.length - 1,
      duration: (playback.seconds ?? 3) * 1000,
      ease: 'Linear',
      onUpdate: () => {
        const i = Math.floor(cursor.i);
        const here = points[Math.min(i, points.length - 1)]!;
        this.actor?.setPosition(here.x, here.y);
        if (playback.rival && this.rival) {
          const sample = payload.samples[Math.min(i, payload.samples.length - 1)];
          const at = sample ? this.rivalPoint(playback, sample.t ?? 0) : null;
          if (at) this.rival.setPosition(at.x, at.y);
        }
        this.trailLayer.clear();
        this.strokePoints(this.trailLayer, points.slice(0, i + 1), GOLD, 0.85, 3);
      },
      onComplete: () => {
        const last = points[points.length - 1]!;
        this.actor?.setPosition(last.x, last.y);
        this.trailLayer.clear();
        this.remember(points, payload.won);
        this.cameras.main.flash(
          180,
          ...(payload.won ? ([111, 191, 115] as const) : ([192, 87, 70] as const)),
        );
        this.ghostLayer.clear();
        this.ghostLabel.setVisible(false);
        this.cameras.main.stopFollow();
        this.cameraParked = true;
        this.mode = 'walk';
        gameBus.emit('played', { won: payload.won });
      },
    });
  }

  /**
   * Samples → screen points. `along` is read per sample exactly as the chart
   * reads it, so the thing moving here and the curve in the panel are the same
   * numbers. A run that starts partway down the route gets a constant-speed
   * lead-in, because a train that appears at the brake marker has no weight.
   */
  private pathPoint(playback: Playback, value: number, height: number): Point {
    const world = this.alongPath(playback.path, value);
    const p = this.toScreen(world.x, world.y);
    const scale = playback.liftScale ?? this.pathScale(playback.path);
    return { x: p.x, y: p.y - height * scale };
  }

  private pathPoints(playback: Playback, samples: SimSample[]): Point[] {
    if (samples.length === 0) return [];
    const along = compile(playback.along);
    const lift = playback.lift ? compile(playback.lift) : null;
    const place = (value: number, height: number): Point => this.pathPoint(playback, value, height);

    const points: Point[] = [];
    const first = along.evaluate(samples[0]!);
    const span = playback.path.toValue - playback.path.fromValue;
    if (span !== 0 && (first - playback.path.fromValue) / span > 0.02) {
      const height = lift ? lift.evaluate(samples[0]!) : 0;
      for (let k = 0; k < 24; k++) {
        points.push(
          place(playback.path.fromValue + ((first - playback.path.fromValue) * k) / 24, height),
        );
      }
    }
    for (const sample of samples) {
      points.push(place(along.evaluate(sample), lift ? lift.evaluate(sample) : 0));
    }
    return points;
  }

  /** Where the rival stands at simulated time `t`. */
  private rivalPoint(playback: Playback, t: number): Point | null {
    if (!playback.rival || !this.simSpec) return null;
    try {
      const value = evaluate(playback.rival.along, { ...this.simSpec.constants, t });
      const clamped = Phaser.Math.Clamp(
        value,
        Math.min(playback.path.fromValue, playback.path.toValue),
        Math.max(playback.path.fromValue, playback.path.toValue),
      );
      return this.pathPoint(playback, clamped, 0);
    } catch {
      return null; // a rival that will not evaluate simply is not drawn
    }
  }

  private makeRival(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(8650);
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(0, 0, 26, 13);
    g.fillStyle(0x4a2b24, 1);
    g.fillRoundedRect(-7, -32, 14, 24, 4);
    g.fillStyle(0x8a5a4b, 1);
    g.fillCircle(0, -36, 7);
    g.fillStyle(RED, 1);
    g.fillRect(-8, -26, 16, 4);
    return g;
  }

  private makeActor(actor: Playback['actor']): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(8700);
    if (actor === 'train') {
      g.fillStyle(0x2a1b10, 1);
      g.fillRoundedRect(-34, -34, 68, 34, 5);
      g.fillStyle(GOLD, 1);
      g.fillRoundedRect(-34, -44, 68, 12, 4);
      g.fillStyle(0x0b0806, 1);
      g.fillCircle(-20, 2, 7);
      g.fillCircle(20, 2, 7);
    } else {
      g.fillStyle(0x8a5a2b, 1);
      g.fillRoundedRect(-11, -11, 22, 22, 4);
      g.lineStyle(2, GOLD, 1);
      g.strokeRoundedRect(-11, -11, 22, 22, 4);
    }
    return g;
  }

  // --- the room ------------------------------------------------------------

  /**
   * Placeholder props: every blocked rect is extruded into an isometric box at
   * runtime, so the shelves line up with the colliders by construction and the
   * player can walk behind them. Painted props replace this, same geometry.
   */
  private drawVolumes(blocked: Rect[], interactables: (Rect & { id: string })[]): void {
    if (!this.iso) return;
    const view = this.iso;

    // The south and east walls are the ones nearest the camera, so extruding
    // them walls the player off from the viewer — stand at the spawn and you
    // are behind one. Isometric rooms are drawn as cutaways for exactly this
    // reason: the near sides stay flat on the floor.
    const { width, height } = this.sceneData;
    const nearWall = (r: Rect) => r.y + r.h >= height - 1 || r.x + r.w >= width - 1;

    const volumes: (Rect & { tint: number })[] = [
      ...blocked.map((r) => ({ ...r, ...(nearWall(r) ? { height: 0 } : {}), tint: 0x3a2514 })),
      ...interactables.map((r) => ({ ...r, height: r.height ?? 34, tint: 0xd9a441 })),
    ];

    for (const volume of volumes) {
      const lift = volume.height ?? 70;
      const top = isoDiamond(volume, view).map((p) => ({ x: p.x, y: p.y - lift }));
      const base = isoDiamond(volume, view);
      const g = this.add.graphics();

      // Shadow first: painted after the faces it would tint the box it sits under.
      g.fillStyle(0x000000, 0.25);
      g.beginPath();
      g.moveTo(base[0]!.x, base[0]!.y);
      for (const corner of base.slice(1)) g.lineTo(corner.x, corner.y);
      g.closePath();
      g.fillPath();

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

      // An outline and a rim along the lit edge. Three flat fills read as a
      // diagram; the same three with an edge on them read as an object.
      g.lineStyle(2, darken(volume.tint, 0.3), 0.9);
      g.strokePoints(
        top.map((p) => new Phaser.Geom.Point(p.x, p.y)),
        true,
      );
      g.lineStyle(2, lighten(volume.tint, 1.4), 0.75);
      g.beginPath();
      g.moveTo(top[3]!.x, top[3]!.y);
      g.lineTo(top[0]!.x, top[0]!.y);
      g.lineTo(top[1]!.x, top[1]!.y);
      g.strokePath();

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

  override update(_time: number, delta: number): void {
    if (this.mode === 'driving') {
      this.tickDrive(delta);
      return;
    }
    if (this.mode === 'needle') {
      this.tickNeedle(delta);
      return;
    }
    if (this.mode === 'aim' || this.mode === 'playing') {
      this.player.body.setVelocity(0, 0);
      return;
    }

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
    // The camera stays where a run ended until the player walks away from it.
    if (this.cameraParked && (ix !== 0 || iy !== 0)) {
      this.cameras.main.startFollow(this.avatar, true, 0.12, 0.12);
      this.cameraParked = false;
    }
    if (ix !== 0) this.avatar.setFlipX(ix < 0);

    this.syncAvatar();

    this.nearby = this.closestInteractable();
    this.updatePrompt();
  }

  /** The ghost marker that follows you along the route, and the bottom line. */
  private updatePrompt(): void {
    const marker = this.binding('marker');
    if (marker && !this.planted) {
      const hit = this.valueAt(marker.path, { x: this.player.x, y: this.player.y });
      if (hit.distance <= PLANT_RADIUS) {
        const value = clampToSpec(hit.value, this.spec(marker.param));
        this.ghostLayer.clear();
        this.drawFlag(this.ghostLayer, hit.at, GOLD, 0.4);
        const p = this.toScreen(hit.at.x, hit.at.y);
        this.ghostLabel
          .setText(`${format(value)}${marker.path.unit ?? ''}`)
          .setPosition(p.x, p.y - 58)
          .setVisible(true);
        this.prompt
          .setText(`E — ${marker.prompt ?? 'plant the marker'} here`)
          .setPosition(this.scale.width / 2, this.scale.height - 44)
          .setVisible(true);
        return;
      }
      this.ghostLayer.clear();
      this.ghostLabel.setVisible(false);
    }

    const line = this.promptLine();
    this.prompt
      .setText(line ?? '')
      .setPosition(this.scale.width / 2, this.scale.height - 44)
      .setVisible(line !== null);
  }

  private promptLine(): string | null {
    const control = this.binding('control');
    if (control) {
      return this.ghosts.length > 0
        ? 'F — again · R clear the ghosts'
        : `F — ${control.prompt ?? 'let her go'}`;
    }

    if (this.planted) {
      const marker = this.binding('marker');
      return `F — ${marker?.prompt ? 'release the train' : 'run it'} · R replant`;
    }

    const needle = this.binding('needle');
    if (needle && this.nearAnchor(needle.at)) return `E — ${needle.prompt ?? 'the dial'}`;

    const aim = this.binding('aim');
    if (aim && this.nearAnchor(aim.at)) return `E — ${aim.prompt ?? 'take aim'}`;

    const readable = this.nearestReadable();
    if (readable) return `E — read the ${readable.replace(/-/g, ' ')}`;

    if (this.nearby) return `E — ${this.nearby.replace(/-/g, ' ')}`;
    return null;
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

function lighten(color: number, factor: number): number {
  const channel = (shift: number) => Math.min(255, Math.round(((color >> shift) & 0xff) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

function dashed(g: Phaser.GameObjects.Graphics, from: Point, to: Point, dash = 9): void {
  const total = Phaser.Math.Distance.Between(from.x, from.y, to.x, to.y);
  if (total < 1) return;
  const steps = Math.ceil(total / (dash * 2));
  for (let i = 0; i < steps; i++) {
    const a = (i * 2 * dash) / total;
    const b = Math.min(1, (i * 2 * dash + dash) / total);
    g.beginPath();
    g.moveTo(from.x + (to.x - from.x) * a, from.y + (to.y - from.y) * a);
    g.lineTo(from.x + (to.x - from.x) * b, from.y + (to.y - from.y) * b);
    g.strokePath();
  }
}

/** Sleeper spacing that lands on round numbers, whatever the span. */
function niceStep(span: number): number {
  const rough = span / 10;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const normalised = rough / magnitude;
  const step = normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1;
  return step * magnitude;
}

function clampToSpec(value: number, spec: ParamSpec | undefined): number {
  return spec ? Phaser.Math.Clamp(value, spec.min, spec.max) : value;
}

/**
 * How many steps a held arrow has produced by `ms`. The rate eases from slow to
 * quick over NEEDLE_RAMP, so a long way is short to travel and the last stretch
 * is still placeable.
 */
function repeatsSince(ms: number): number {
  if (ms <= 0) return 0;
  const ramp = Math.min(ms, NEEDLE_RAMP);
  const rate = NEEDLE_SLOW + ((NEEDLE_FAST - NEEDLE_SLOW) * ramp) / NEEDLE_RAMP;
  const ramped = ((NEEDLE_SLOW + rate) / 2) * (ramp / 1000);
  return Math.floor(ramped + (NEEDLE_FAST * Math.max(0, ms - NEEDLE_RAMP)) / 1000);
}

function repeatsBetween(from: number, to: number): number {
  return repeatsSince(to) - repeatsSince(from);
}

/** A round increment that puts roughly sixty steps across the range. */
function needleStep(range: number): number {
  const rough = Math.abs(range) / 60;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const normalised = rough / magnitude;
  return (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
}

/** Keep a value on its step grid, so the readout is a number not a reading. */
function snap(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value;
}

function midpoint(span: { from: number; to: number }): number {
  return (span.from + span.to) / 2;
}

function format(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}

/** Spread a Point into the (x, y) pair toScreen takes. */
function pointArgs(p: Point): [number, number] {
  return [p.x, p.y];
}
