import Phaser from 'phaser';
import type {
  ActStage,
  Character,
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
  ISO_X,
  Run,
  compile,
  evaluate,
  simulate,
  isoDepth,
  isoDiamond,
  isoInputToWorld,
  isoProject,
  isoView,
  propApex,
  propHeight,
  propKindFor,
  propLabel,
  seedOf,
} from '@chapter-quest/shared';
import type {
  CompiledExpr,
  ExprScope,
  Interactable,
  IsoView,
  PropKind,
} from '@chapter-quest/shared';
import { Actor, lookFor } from './actor';
import { BalanceRig } from './balance';
import { castKey, cutout, isPaintedUrl, propKey, sliceSheet } from './painted';
import { PaintedActor } from './painted-actor';
import { dressKey, placeDressing, preloadDressing } from './dressing';
import { gameBus } from './bus';
import type { GameEvents } from './bus';
import { focus, impact, land, punch, relax } from './camera';
import type { Pool } from './light';
import { Motes, addLightPool, addVignette, flicker } from './light';
import type { Rumble } from './sfx';
import { sfx } from './sfx';
import { Steam, chimneyOffset, drawLocomotive, drawTrack } from './track';
import { darken, drawFootprint, drawFurniture, drawProp, drawWall, isWall, lighten } from './props';

const PLAYER_SPEED = 260;
const INTERACT_RADIUS = 110;
/** How close you have to be before the cast turn and look at you. */
const NOTICE_RADIUS = 260;
/** The height the drawn cast stand at, which the painted cast match. */
const CAST_HEIGHT = 64;
/** How close to the line you must stand before a marker can go down. */
const PLANT_RADIUS = 220;
/** Auto-repeat while an arrow is held: slow at first, then quick. A tap is
 *  always exactly one step, so the last few can be placed exactly. */
const NEEDLE_SLOW = 8;
const NEEDLE_FAST = 28;
const NEEDLE_RAMP = 500;
/** Notches across a lever's range while a run is live: steering, not deduction. */
const LEVER_NOTCHES = 10;
/** How many past attempts stay on the track. Enough to see the pattern. */
const GHOST_LIMIT = 4;
const DEBUG_COLOR = 0xff00ff;
const GOLD = 0xd9a441;
const GREEN = 0x6fbf73;
const RED = 0xc05746;
const PARCHMENT = 0xf4ecd8;
/** A sandstone flag in lamplight, before each one is shaded on its own. */
const FLAG = 0x4d3825;
/**
 * Painted in a studio, standing in a lamplit room. A multiply this gentle is
 * not a colour change: it takes the daylight off a cut-out so it belongs to
 * the room it was dropped into.
 */
const WARM = 0xfff0de;
/** Texture key for the player's walk sheet. */
const PLAYER_SHEET = 'art-player-sheet';
/** A touch taller than the cast, so the one figure you steer is the one you find first. */
const PLAYER_HEIGHT = 68;
/** How see-through scenery gets when it stands in front of someone. */
const OCCLUDER_ALPHA = 0.32;
/** How tall the gate's posts stand on screen, in pixels. */
const GATE_HEIGHT = 96;
/** Bars across a locked gate. */
const GATE_BARS = 6;
/** How close counts as standing at the gate, for its prompt and its beacon. */
const GATE_NEAR = 180;
/** How far a painted room is pushed past the frame; see layBackdrop. */
const PLATE_OVERSCAN = 1.12;

/** So two people in one room do not breathe in lockstep. */
const seedPhase = (id: string): number => (seedOf(id) % 628) / 100;

export interface WorldSceneInit {
  scene: WorldSceneData;
  /**
   * Who is standing in the room. Without them a scene is furniture: the cast
   * only ever existed in the dialogue box, so the player walked an empty set
   * and then got talked at by people who were nowhere.
   */
  cast?: Character[];
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
  /** The cast member the player can walk up to and ask anything. */
  guide?: string;
  /** The way out: shut until the act is won. Updates arrive on the bus. */
  gate?: GameEvents['gate'];
  /** The player's painted walk sheet. Absent, the player is drawn. */
  playerSheet?: string;
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
  private cast: Character[] = [];
  private stage: ActStage | null = null;
  private params: ParamSpec[] = [];
  private target: { from: number; to: number; label?: string } | null = null;
  private simSpec: SimSpec | null = null;
  private iso: IsoView | null = null;

  /** Physics body on the world plane. Invisible when isometric. */
  private player!: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
  /** What the player actually sees. Same sprite when top-down. */
  private avatar!: Phaser.GameObjects.Sprite;
  /** The player, drawn with limbs that move. Null in a top-down scene, which
   *  still uses the flat sprite. */
  private walker: Actor | PaintedActor | null = null;
  /** The player's painted walk sheet, if the world has one. */
  private playerSheet: string | undefined;
  /** Everyone else in the room, with where they stand. */
  private extras: {
    /** Drawn with limbs, and able to turn and look at you. */
    actor?: Actor;
    /** Painted: it cannot turn, so it stands and breathes instead. */
    image?: Phaser.GameObjects.Image;
    phase?: number;
    at: Point;
    spot: Point;
    depth: number;
  }[] = [];
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keys!: Record<
    'up' | 'down' | 'left' | 'right' | 'interact' | 'run' | 'reset' | 'control' | 'debug',
    Phaser.Input.Keyboard.Key
  >;

  private prompt!: Phaser.GameObjects.Text;
  private readout!: Phaser.GameObjects.Text;
  /**
   * What the dial's current setting would actually do.
   *
   * Without it a needle act is: pick a number, commit, be told yes or no.
   * The player never sees the relationship they are supposed to be learning,
   * only whether they guessed it. Showing the consequence as they turn is the
   * whole loop — move the tension, watch the drift go to zero, understand why
   * the cable has to carry the weight exactly.
   */
  private consequence!: Phaser.GameObjects.Text;
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
  /**
   * Which dial on the board the player is holding.
   *
   * An act with two params is a trade-off — workers against queue depth, cache
   * hit rate against origin load — and the board needs both. Turning one and
   * leaving the other frozen is not a simplification, it is an act nobody can
   * win.
   */
  private activeNeedle = 0;
  /** Set-dressing uprights, with the screen box each covers. They never move. */
  private scenery: { image: Phaser.GameObjects.Image; box: Phaser.Geom.Rectangle }[] = [];
  /** Uprights standing in front of a person or a prop, which stay see-through. */
  private veiled = new Set<Phaser.GameObjects.Image>();
  /** The way out, and whether it lets you through yet. */
  private gate: GameEvents['gate'] | null = null;
  private gateRect: Rect | null = null;
  private gateLayer: Phaser.GameObjects.Graphics | null = null;
  private gateLabel: Phaser.GameObjects.Text | null = null;
  /** Solid while locked, so a shut gate is something you walk into. */
  private gateCollider: Phaser.Physics.Arcade.Collider | null = null;
  private gateBumped = 0;
  /** Set the moment the player steps through: the scene is on its way out. */
  private exiting = false;
  /** Who answers questions in this room, if anyone does. */
  private guide: string | null = null;
  /** The gold question mark over the guide's head, and where it rests. */
  private guideMark: { text: Phaser.GameObjects.Text; home: number } | null = null;
  /** True while the player is close enough to the guide to ask. */
  private nearGuide = false;
  /** Values as they stood when a live run began, put back when it ends. */
  private preRun: Record<string, number> | null = null;
  /** Which live lever ← → works, when a board has more than one. */
  private activeLever = 0;
  /** How long a lever key has been held mid-run, for the repeat. */
  private leverHeld = 0;
  /** The number the act is judged on, read off the run live so it can be steered by. */
  private gaugeExpr: CompiledExpr | null = null;
  /** One text per dial, so a two-dial board is two named instruments. */
  private dialNames: Phaser.GameObjects.Text[] = [];
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
  /** The run's own noise, open for as long as the run lasts. */
  private rumble: Rumble | null = null;
  /** Anything in the room that burns, so it can gutter. */
  private pools: { pool: Pool; seed: number; motes: Motes }[] = [];
  /** The engine's exhaust, left behind in the world as it goes. */
  private steam: Steam | null = null;
  /** Where the actor was last frame, to spawn steam by distance covered. */
  private actorWas: Point | null = null;
  /** Rings on the floor under the props, redrawn when the one in reach changes. */
  private footprints!: Phaser.GameObjects.Graphics;
  /** Redrawn under the player every frame; see syncAvatar. */
  private playerShadow!: Phaser.GameObjects.Graphics;
  /** One name plate per interactable, so a prop never has to be guessed at. */
  private plates: { id: string; text: Phaser.GameObjects.Text; home: number }[] = [];
  /** Which prop the rings and plates are currently lit for. */
  private highlighted: string | null = null;
  /**
   * The one prop this act is about, and the marker pointing at it.
   *
   * A room generated from a chapter always has more props than bindings — act
   * three of the coal world has a winch tension dial that is wired to the
   * mechanic and an honest weighbridge plate that is wired to nothing. They
   * looked identical: same ring, same plate, same prompt. Walking to the wrong
   * one and pressing E did nothing at all, which reads as a broken game rather
   * than as the wrong prop.
   */
  private focus: string | null = null;
  private beacon!: Phaser.GameObjects.Graphics;
  /** When the player last walked into something, so a held key does not
   *  machine-gun the knock. */
  private lastBump = 0;
  /**
   * Hold a message on the prompt until this time.
   *
   * `update` rewrites the prompt every frame from whatever is in reach, so a
   * line written in response to a keypress was gone 16ms later — the player
   * pressed E, something did happen, and the evidence was overwritten before
   * the next frame could draw it.
   */
  private promptUntil = 0;
  /** The beam and its loads, when the act is a balance. */
  private rig: BalanceRig | null = null;
  /** The beam's tilt as last simulated, radians. Level until a run says otherwise. */
  private rigTilt = 0;
  private rigVerdict: { won: boolean; note: string } | null = null;
  /** Finished runs this act. A centre of mass that never moves is shown after the first. */
  private rigRuns = 0;
  private rigSettle: Phaser.Tweens.Tween | null = null;
  /** The shaft a vertical run climbs, drawn over the props. */
  private shaftLayer: Phaser.GameObjects.Graphics | null = null;
  /** True while the beam shows a run's tilt; false, it rests where the sim starts it. */
  private rigLive = false;
  /** 0 → 1 while a delivered load crosses onto its platform. */
  private rigDelivered = 0;

  constructor() {
    super(WorldScene.KEY);
  }

  init(init: WorldSceneInit): void {
    this.sceneData = init.scene;
    this.cast = init.cast ?? [];
    this.stage = init.stage ?? null;
    this.params = init.params ?? [];
    this.target = init.target ?? null;
    this.simSpec = init.spec ?? null;
    this.guide = init.guide ?? null;
    this.playerSheet = init.playerSheet;
    this.gate = init.gate ?? null;
    this.gateRect = null;
    this.gateLayer = null;
    this.gateLabel = null;
    this.gateCollider = null;
    this.exiting = false;
    this.guideMark = null;
    this.nearGuide = false;
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
    this.lastBump = 0;
    this.promptUntil = 0;
    this.rumble = null;
    this.pools = [];
    this.steam = null;
    this.actorWas = null;
    this.walker = null;
    this.extras = [];
    this.plates = [];
    this.highlighted = null;
    this.focus = null;
    this.rig = null;
    this.rigTilt = 0;
    this.rigVerdict = null;
    this.rigRuns = 0;
    this.rigSettle = null;
    this.rigLive = false;
    this.rigDelivered = 0;
    this.shaftLayer = null;
  }

  preload(): void {
    const view = this.viewSize();
    if (this.sceneData.imageUrl) {
      // The hand-written fixtures point at SVGs, which have to be rasterised
      // at a size. A painted room is already pixels and is stretched onto the
      // plane in create().
      if (/\.svg(\?|$)/i.test(this.sceneData.imageUrl)) {
        this.load.svg(`bg-${this.sceneData.id}`, this.sceneData.imageUrl, {
          width: view.width,
          height: view.height,
        });
      } else {
        this.load.image(`bg-${this.sceneData.id}`, this.sceneData.imageUrl);
      }
    }
    // The player is drawn rather than loaded whatever happens: this is the one
    // body in the room that walks, and a painted plate cannot.
    this.load.svg('player', '/mock-art/player.svg', { width: 32, height: 48 });

    // Everything the art director managed to paint for this world. It arrives
    // as a JPEG on a white field and is keyed and cropped in create(), once
    // the bytes are actually here; see painted.ts.
    for (const target of this.sceneData.interactables) {
      if (isPaintedUrl(target.imageUrl)) this.load.image(propKey(target.id), target.imageUrl);
    }
    for (const member of this.cast) {
      if (isPaintedUrl(member.sprite)) this.load.image(castKey(member.id), member.sprite);
    }
    if (isPaintedUrl(this.playerSheet)) this.load.image(PLAYER_SHEET, this.playerSheet);
    // Scenery. Committed PNGs with their own alpha, so unlike the painted
    // props these go straight into the scene without a keying pass.
    preloadDressing(this, this.sceneData.dressing);
    // An asset that will not load costs its own picture and nothing else.
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      console.info('[art] unpainted, drawing it instead:', file.key);
    });
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
      this.layBackdrop(view);
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

    if (this.iso) {
      // Dressing before the props and the cast: it is scenery, it collides
      // with nothing, and placing it first means a prop and a tree that land
      // on the same screen line are still sorted by `isoDepth` and not by the
      // order they happened to be added in.
      placeDressing(this, this.sceneData.dressing, this.iso);
      this.drawVolumes(blocked, interactables);
      this.placeCast();
      this.findOccluders(interactables);

      const balance = this.stage?.balance;
      if (balance && this.simSpec) {
        this.rig = new BalanceRig(this, balance, this.simSpec, this.params, (x, y) =>
          this.toScreen(x, y),
        );
        // A beam is something you walk round, not through. Only if nobody has
        // to stand where it lies — a collider over the spawn would wall the
        // player into the beam.
        const standing = [spawn, ...Object.values(this.sceneData.npcSpots)];
        const anchor = this.binding('needle')?.at;
        if (anchor) standing.push(anchor);
        for (const fp of this.rig.footprints()) {
          const clear = !standing.some(
            (p) =>
              p.x > fp.x - 20 &&
              p.x < fp.x + fp.w + 20 &&
              p.y > fp.y - 20 &&
              p.y < fp.y + fp.h + 20,
          );
          if (!clear) continue;
          const zone = this.add.zone(fp.x + fp.w / 2, fp.y + fp.h / 2, fp.w, fp.h);
          this.physics.add.existing(zone, true);
          walls.push(zone);
        }
      }
    }

    this.ghostLayer = this.add.graphics().setDepth(8500);
    this.ghostLayer2 = this.add.graphics().setDepth(8550);
    this.trailLayer = this.add.graphics().setDepth(8600);
    this.steam = new Steam(this.add.graphics().setDepth(8650));

    this.player = this.physics.add.sprite(spawn.x, spawn.y, 'player');
    this.player.setCollideWorldBounds(true);
    this.player.body.setSize(24, 20).setOffset(4, 28); // feet only, so the head overlaps shelves
    this.physics.add.collider(this.player, walls);
    this.setUpGate();

    if (this.iso) {
      // The body stays on the plane; a separate sprite is drawn at the
      // projected position so the camera and depth sorting work in screen space.
      this.player.setVisible(false);
      // Over the floor, under everything that stands on it. The painted props
      // and cast each got a contact shadow; without one of its own the player
      // is the only body in the room that hovers.
      this.playerShadow = this.add.graphics().setDepth(0.55);
      // Painted if the world has a walk sheet that cuts cleanly into twelve
      // frames, drawn if not. Either way it walks the same: the painted one
      // takes the drawn one's facing and stride rules (painted-actor.ts).
      const sheet = isPaintedUrl(this.playerSheet) ? sliceSheet(this, PLAYER_SHEET, 3, 4) : null;
      this.walker = sheet
        ? new PaintedActor(this, sheet, PLAYER_HEIGHT, WARM)
        : new Actor(this, lookFor('player'));
      this.syncAvatar();
    } else {
      this.player.setDepth(10);
      this.avatar = this.player;
    }

    this.cameras.main.setBounds(0, 0, view.width, view.height);
    this.cameras.main.startFollow(this.cameraTarget(), true, 0.12, 0.12);
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
    this.consequence = this.screenText(this.scale.height - 120, 17, '#9fd3b0');
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

    keyboard.on('keydown-M', () => {
      const muted = sfx.toggle();
      if (!muted) sfx.near();
      this.prompt
        .setText(muted ? 'sound off' : 'sound on')
        .setPosition(this.scale.width / 2, this.scale.height - 44)
        .setVisible(true);
    });

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
      gameBus.on('gate', (gate) => this.setGate(gate)),
    ];
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => off.forEach((remove) => remove()));
    this.events.on(Phaser.Scenes.Events.PAUSE, () => this.showChrome(false));
    this.events.on(Phaser.Scenes.Events.RESUME, () => this.showChrome(true));
    this.events.once(Phaser.Scenes.Events.DESTROY, () => off.forEach((remove) => remove()));

    addVignette(this);
    // You arrive through a door, so the room comes up out of the dark the way
    // the last one went down into it.
    this.cameras.main.fadeIn(420, 11, 8, 6);

    gameBus.emit('ready', { sceneId: this.sceneData.id });
  }

  /** The canvas draws over the DOM, so its own chrome has to stand down when a
   *  React panel comes up. */
  private showChrome(visible: boolean): void {
    for (const plate of this.plates) plate.text.setVisible(visible);
    this.rig?.showLabels(visible);
    if (!visible) {
      this.prompt.setVisible(false);
      this.readout.setVisible(false);
      this.consequence.setVisible(false);
      for (const label of this.dialNames) label.setVisible(false);
      this.ghostLabel.setVisible(false);
    } else if (this.mode === 'needle') {
      this.drawNeedle();
    }
  }

  /**
   * A painted floor, laid on the plane the mapper measured.
   *
   * `isoView` projects a world plane of any size into a box exactly twice as
   * wide as it is tall, so one aspect ratio serves every room and the plate is
   * simply stretched onto that box.
   *
   * It is deliberately *not* masked to the diamond. The image model paints a
   * room as a diorama — a slab of ground with its own worn edges, sitting on a
   * dark surround — and that surround is the look rather than a mistake to cut
   * away. It gets a little overscan instead, so the painted ground covers the
   * part of the plane that can actually be walked on and the plate's own dark
   * border falls outside the frame.
   *
   * Nothing about how the room *works* comes from the picture. The colliders,
   * the props, the exits and the win band are all laid over it from geometry
   * that was already correct, so a plate that disagrees with its room is a
   * picture that looks wrong, never a room you cannot play.
   */
  private layBackdrop(view: { width: number; height: number }): void {
    const key = `bg-${this.sceneData.id}`;
    if (!this.textures.exists(key)) {
      // It was listed and it did not arrive. Draw the floor instead of leaving
      // the player standing in a void.
      this.drawGround(this.sceneData.width, this.sceneData.height);
      return;
    }

    this.add
      .image(view.width / 2, view.height / 2, key)
      .setOrigin(0.5)
      .setDisplaySize(view.width * PLATE_OVERSCAN, view.height * PLATE_OVERSCAN)
      .setDepth(0);

    // Thresholds are geometry, not decoration: they say where you are allowed
    // to leave, and a painted floor has no idea where the exits are.
    const g = this.add.graphics().setDepth(0.2);
    for (const exit of this.sceneData.exits) this.drawThreshold(g, exit);
  }

  /**
   * The floor, drawn rather than loaded. A room the mapper built has no painted
   * backdrop, and an isometric scene with no ground plane is a void with props
   * floating in it. Same geometry the art generator uses, so a painted room and
   * a generated one line up exactly.
   *
   * Tiled in two shades rather than flat: on an isometric plane a single colour
   * gives the eye nothing to measure against, so you cannot tell whether you
   * have walked two metres or twenty.
   */
  private drawGround(width: number, height: number): void {
    const g = this.add.graphics().setDepth(0);
    const corner = (x: number, y: number) => this.toScreen(x, y);
    const fill = (pts: Point[], color: number, alpha = 1) => {
      g.fillStyle(color, alpha);
      g.beginPath();
      g.moveTo(pts[0]!.x, pts[0]!.y);
      for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
      g.closePath();
      g.fillPath();
    };

    // Grout first: the flags are laid over it with a gap, so every joint is
    // the same dark line without stroking a grid.
    fill([corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)], 0x1e140b);

    // Sandstone flags, each its own shade, lit from the top left: the two edges
    // facing the light catch it, the two facing away fall into shadow. Drawn
    // once — the floor never changes, so it costs nothing per frame.
    const tile = 100;
    const gap = 3;
    const seed = seedOf(this.sceneData.id);
    for (let x = 0; x < width; x += tile) {
      for (let y = 0; y < height; y += tile) {
        const h = hash2(x / tile, y / tile, seed);
        const x0 = x + gap;
        const y0 = y + gap;
        const x1 = Math.min(x + tile, width) - gap;
        const y1 = Math.min(y + tile, height) - gap;
        if (x1 <= x0 || y1 <= y0) continue;
        const stone = lighten(FLAG, 0.84 + ((h % 1000) / 1000) * 0.3);
        const quad = [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)];
        fill(quad, stone);
        g.lineStyle(1.5, lighten(stone, 1.28), 0.55);
        g.beginPath();
        g.moveTo(quad[3]!.x, quad[3]!.y);
        g.lineTo(quad[0]!.x, quad[0]!.y);
        g.lineTo(quad[1]!.x, quad[1]!.y);
        g.strokePath();
        g.lineStyle(1.5, darken(stone, 0.6), 0.6);
        g.beginPath();
        g.moveTo(quad[1]!.x, quad[1]!.y);
        g.lineTo(quad[2]!.x, quad[2]!.y);
        g.lineTo(quad[3]!.x, quad[3]!.y);
        g.strokePath();
        // One flag in nine has cracked. Wear, not noise.
        if (h % 9 === 0) {
          const t = ((h >> 4) % 100) / 100;
          const crack = [
            corner(x0 + (x1 - x0) * t, y0),
            corner(x0 + (x1 - x0) * (0.3 + t * 0.4), y0 + (y1 - y0) * 0.45),
            corner(x0 + (x1 - x0) * (0.55 + t * 0.2), y1),
          ];
          g.lineStyle(1, darken(stone, 0.55), 0.7);
          g.strokePoints(
            crack.map((p) => new Phaser.Geom.Point(p.x, p.y)),
            false,
          );
        }
      }
    }

    // A skirting inside the walls: the floor meeting something is what tells
    // you the room has edges rather than fading out.
    const inset = 28;
    g.lineStyle(3, 0x4a3426, 0.55);
    g.strokePoints(
      [
        corner(inset, inset),
        corner(width - inset, inset),
        corner(width - inset, height - inset),
        corner(inset, height - inset),
      ].map((p) => new Phaser.Geom.Point(p.x, p.y)),
      true,
    );

    for (const exit of this.sceneData.exits) this.drawThreshold(g, exit);
  }

  /**
   * A way out, lit. A flat blue rectangle on the floor is the one thing in the
   * room that looks like a bug rather than a place, so it gets a warm threshold
   * and a chevron pointing the way it leads.
   */
  private drawThreshold(g: Phaser.GameObjects.Graphics, exit: Rect): void {
    const { width, height } = this.sceneData;
    const pad = (k: number): Rect => ({
      x: exit.x + exit.w * k,
      y: exit.y + exit.h * k,
      w: exit.w * (1 - 2 * k),
      h: exit.h * (1 - 2 * k),
    });

    for (const [k, color, alpha] of [
      [0, 0x6b4a22, 0.75],
      [0.14, 0xa8762f, 0.7],
      [0.3, 0xe0b35e, 0.6],
    ] as [number, number, number][]) {
      const rect = pad(k);
      if (this.iso) {
        g.fillStyle(color, alpha);
        g.fillPoints(
          isoDiamond(rect, this.iso).map((p) => new Phaser.Geom.Point(p.x, p.y)),
          true,
        );
      } else {
        g.fillStyle(color, alpha);
        g.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
    }

    // Point the chevron at whichever wall the exit is nearest: an exit is a
    // hole in one of them, and the mapper may have inset it off the edge.
    const cx = exit.x + exit.w / 2;
    const cy = exit.y + exit.h / 2;
    const out = [
      { away: cy, to: { x: 0, y: -1 } },
      { away: height - cy, to: { x: 0, y: 1 } },
      { away: cx, to: { x: -1, y: 0 } },
      { away: width - cx, to: { x: 1, y: 0 } },
    ].reduce((nearest, side) => (side.away < nearest.away ? side : nearest)).to;
    const reach = Math.min(exit.w, exit.h) * 0.7;
    const tip = this.toScreen(cx + out.x * reach, cy + out.y * reach);
    const back = this.toScreen(cx - out.x * reach * 0.5, cy - out.y * reach * 0.5);
    const side = { x: -out.y, y: out.x };
    const wingA = this.toScreen(
      cx - out.x * reach * 0.1 + side.x * reach * 0.6,
      cy - out.y * reach * 0.1 + side.y * reach * 0.6,
    );
    const wingB = this.toScreen(
      cx - out.x * reach * 0.1 - side.x * reach * 0.6,
      cy - out.y * reach * 0.1 - side.y * reach * 0.6,
    );
    g.lineStyle(5, 0xf4ecd8, 0.8);
    g.beginPath();
    g.moveTo(wingA.x, wingA.y);
    g.lineTo(tip.x, tip.y);
    g.lineTo(wingB.x, wingB.y);
    g.strokePath();
    g.lineStyle(3, 0xf4ecd8, 0.35);
    g.beginPath();
    g.moveTo(back.x, back.y);
    g.lineTo(tip.x, tip.y);
    g.strokePath();
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

  /** Every dial on this board, in the order the mapper bound them. */
  private needles(): Extract<ParamBinding, { kind: 'needle' }>[] {
    return (this.stage?.bindings ?? []).filter(
      (b): b is Extract<ParamBinding, { kind: 'needle' }> => b.kind === 'needle',
    );
  }

  /** The dials that stay in hand while the run plays. */
  private liveNeedles(): Extract<ParamBinding, { kind: 'needle' }>[] {
    return this.needles().filter((needle) => needle.live);
  }

  /** The dial currently in hand. */
  private heldNeedle(): Extract<ParamBinding, { kind: 'needle' }> | null {
    const all = this.needles();
    return all[Math.min(this.activeNeedle, all.length - 1)] ?? null;
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
    this.drawRig();

    const marker = this.binding('marker');
    const playback = stage.playback;

    // The route. A train gets permanent way — ballast, sleepers, rails, a stop
    // at the end — laid along the very path the physics runs on, so the two can
    // never disagree. Anything that flies gets a thin guide line instead,
    // because a trajectory is not a track and should not look like one.
    // Something that rises gets a shaft, not a route across the floor.
    if (playback?.shaft) {
      this.drawShaft(playback);
      this.spreadPlates();
      return;
    }
    const route = playback?.path ?? marker?.path;
    if (route) {
      // Absent `track` means the old behaviour: a train runs on rails and
      // nothing else does, which is what the hand-written fixtures assume.
      const rails = playback?.track === 'rails' || (!playback?.track && playback?.actor === 'train');
      if (rails) {
        drawTrack(this.stageLayer, route.from, route.to, (x, y) => this.toScreen(x, y), {
          bufferStop: true,
        });
      } else {
        this.strokeSegment(this.stageLayer, route.from, route.to, PARCHMENT, 0.22, 7);
        const stepSize = niceStep(Math.abs(route.toValue - route.fromValue));
        for (let v = route.fromValue; v <= route.toValue + 1e-6; v += stepSize) {
          const p = this.toScreen(...pointArgs(this.alongPath(route, v)));
          this.stageLayer.fillStyle(PARCHMENT, 0.3);
          this.stageLayer.fillRect(p.x - 9, p.y - 2, 18, 4);
        }
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

    // The stage has just put its own labels on the room, so the name plates
    // move out from under them.
    this.spreadPlates();
  }

  // --- what E and F do ----------------------------------------------------

  private onAct(): void {
    if (this.mode === 'playing' || this.exiting) return;
    if (this.mode === 'needle') {
      // On an act with a held control, the board only sets the situation — the
      // mass, the load — and the run starts on F with a hand on SPACE.
      if (this.binding('control')) {
        this.leaveFocus('keep');
        sfx.commit();
        this.prompt
          .setText(`Set. F — ${this.binding('control')?.prompt ?? 'start the run'}`)
          .setPosition(this.scale.width / 2, this.scale.height - 44)
          .setVisible(true);
        this.promptUntil = this.time.now + 2200;
        return;
      }
      // A board with a live dial does not hand the run to React to replay: the
      // player keeps a hand on the lever and drives it.
      if (this.liveNeedles().length > 0) this.startDrive();
      else this.commit();
      return;
    }
    if (this.mode === 'aim') return; // the drag itself commits

    const readable = this.nearestReadable();
    if (readable) {
      sfx.act();
      gameBus.emit('read', { id: readable });
      return;
    }

    const needle = this.binding('needle');
    if (needle && this.nearAnchor(needle.at)) {
      this.mode = 'needle';
      this.settleRig();
      sfx.act();
      if (this.rig) {
        // The instrument is the whole beam, not the player: frame all of it,
        // up and to the right, clear of the objective panel and the board.
        const centre = this.rig.frame();
        this.cameras.main.stopFollow();
        this.cameras.main.pan(centre.x - 120, centre.y + 90, 320, 'Sine.easeInOut');
        this.drawNeedle();
        return;
      }
      // The room stops being the subject the moment the instrument is.
      focus(this, 1.18);
      this.drawNeedle();
      return;
    }

    const aim = this.binding('aim');
    if (aim && this.nearAnchor(aim.at)) {
      this.mode = 'aim';
      sfx.act();
      focus(this, 1.12);
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
        punch(this, { strength: 0.08, inMs: 90, holdMs: 60, outMs: 240 });
        sfx.commit();
        gameBus.emit('aiming', { values: { ...this.values } });
        return;
      }
    }

    // A staged act is played in the world, so React ignores `interact` while
    // one is running — which meant E on any other prop in the room played a
    // success chime and did nothing whatsoever. Say what the act actually
    // wants instead, and name it.
    // The act's own controls come first; after them, the guide. Standing beside
    // a prop and the guide at once, E means the person you walked up to.
    if (this.nearGuide && this.guide) {
      sfx.act();
      gameBus.emit('ask', { characterId: this.guide });
      return;
    }

    if (this.nearby && this.focus && this.nearby !== this.focus) {
      this.sayNothingHere(this.nearby);
      return;
    }

    if (this.nearby) {
      sfx.act();
      gameBus.emit('interact', { id: this.nearby });
      return;
    }
    // E with nothing in reach is worth a sound too: silence reads as a dropped
    // input, and the player presses it again.
    sfx.deny();
  }

  /** "Nothing to do here — the X is what this act needs." */
  private sayNothingHere(touched: string): void {
    const name = (id: string) =>
      this.sceneData.interactables.find((it) => it.id === id)?.label?.toLowerCase() ??
      id.replace(/[-_]/g, ' ');
    sfx.deny();
    this.cameras.main.shake(90, 0.002);
    this.prompt
      .setText(`Nothing to do at the ${name(touched)} — it is the ${name(this.focus!)} you want`)
      .setColor('#e0b35e')
      .setPosition(this.scale.width / 2, this.scale.height - 44)
      .setVisible(true);
    // Held long enough to read, then the ambient prompt takes over again.
    this.promptUntil = this.time.now + 2800;
    this.time.delayedCall(2800, () => {
      if (!this.sys.isActive()) return;
      this.prompt.setColor('#f4ecd8');
      if (this.mode === 'walk') this.updatePrompt();
    });
  }

  private onRun(): void {
    if (this.exiting) return;
    if (this.mode === 'playing' || this.mode === 'driving' || !this.stage) return;
    if (this.binding('control') || this.liveNeedles().length > 0) {
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
    const levers = this.liveNeedles();
    const playback = this.stage?.playback;
    if (!playback || !this.simSpec) return;
    if (control ? !this.spec(control.param) : levers.length === 0) return;

    this.leaveFocus('keep');
    this.preRun = levers.length > 0 ? { ...this.values } : null;
    this.activeLever = 0;
    this.leverHeld = 0;
    const readout = this.stage?.readout;
    const gauge = readout ? this.simSpec.outputs[readout.output] : undefined;
    try {
      this.gaugeExpr = gauge ? compile(gauge) : null;
    } catch {
      this.gaugeExpr = null; // no live gauge beats a dead run
    }
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
    this.steam?.clear();
    this.actorWas = null;
    this.rumble?.stop();
    this.rumble = sfx.rumble();
    this.cameras.main.startFollow(this.actor, true, 0.16, 0.16);
    gameBus.emit('aiming', { values: { ...this.values } });
    // The moment she moves should land in the hands: a shove of the frame and
    // the latch going, before anything has had time to happen.
    punch(this, { strength: 0.06, inMs: 80, holdMs: 40, outMs: 260 });
    sfx.commit();
    if (levers.length > 0) this.drawLever(levers);
  }

  private tickDrive(delta: number): void {
    const control = this.binding('control');
    const levers = this.liveNeedles();
    const playback = this.stage?.playback;
    const run = this.run;
    if ((!control && levers.length === 0) || !playback || !run || !this.alongExpr) return;
    this.player.body.setVelocity(0, 0);

    // What the hand is holding this frame: a button for a control, wherever the
    // lever sits for a live dial. The next step reads it, never this one.
    const controls: Record<string, number> = {};
    const held = control ? this.keys.control.isDown || this.input.activePointer.isDown : false;
    if (control) {
      const resting = this.spec(control.param)?.min ?? 0;
      controls[control.param] = held ? control.held : resting;
    }
    if (levers.length > 0) {
      this.nudgeLever(delta, levers);
      for (const lever of levers) {
        controls[lever.param] = this.values[lever.param] ?? this.spec(lever.param)?.default ?? 0;
      }
    }
    run.advance(delta / 1000, controls);

    const scope = run.scope as ExprScope;
    const value = this.alongExpr.evaluate(scope);
    const here = this.pathPoint(playback, value, this.liftExpr ? this.liftExpr.evaluate(scope) : 0);
    this.actor?.setPosition(here.x, here.y);
    if (this.live.length === 0 || Phaser.Math.Distance.BetweenPoints(this.live.at(-1)!, here) > 2) {
      this.live.push(here);
    }
    if (held && !this.braked) this.braked = { index: this.live.length - 1, value };
    // The roll follows the actual speed of the actual run, which is the whole
    // reason this is synthesised and not a loop being faded up and down.
    this.rumble?.level(Math.min(1, Math.abs((scope.v as number) ?? 0) / 20));
    if (held) sfx.brake();
    this.puffSteam(delta, here);

    this.trailLayer.clear();
    this.strokePoints(this.trailLayer, this.live, held ? RED : GOLD, 0.9, 4);

    this.prompt
      .setText(
        control
          ? held
            ? `${(control.label ?? 'brake').toUpperCase()} — full on`
            : `hold SPACE — ${control.label ?? 'brake'}`
          : this.leverLine(levers, run),
      )
      .setColor(held ? '#c05746' : '#f4ecd8')
      .setPosition(this.scale.width / 2, this.scale.height - 44)
      .setVisible(true);
    if (levers.length > 0) this.drawLever(levers);

    if (run.done) this.finishDrive();
  }

  /**
   * The lever, worked by hand while the run plays.
   *
   * Coarser than the needle at the board — ten notches across the range rather
   * than sixty — because this is steering, not deduction: the player is
   * reacting to a body in motion and has to cross the range in about a second.
   * Every notch clunks and knocks the frame, so a change of hand is felt the
   * instant it is made.
   */
  private nudgeLever(delta: number, levers: Extract<ParamBinding, { kind: 'needle' }>[]): void {
    if (levers.length > 1) {
      const up = [this.cursors.up, this.keys.up].some((k) => Phaser.Input.Keyboard.JustDown(k));
      const down = [this.cursors.down, this.keys.down].some((k) =>
        Phaser.Input.Keyboard.JustDown(k),
      );
      if (up || down) {
        this.activeLever = (this.activeLever + (down ? 1 : -1) + levers.length) % levers.length;
        this.leverHeld = 0;
        sfx.tick(this.activeLever / Math.max(1, levers.length - 1));
      }
    }
    const lever = levers[Math.min(this.activeLever, levers.length - 1)];
    const spec = lever && this.spec(lever.param);
    if (!lever || !spec) return;

    const leftKeys = [this.cursors.left, this.keys.left];
    const rightKeys = [this.cursors.right, this.keys.right];
    const direction = rightKeys.some((k) => k.isDown) ? 1 : leftKeys.some((k) => k.isDown) ? -1 : 0;
    let steps = 0;
    if ([...rightKeys, ...leftKeys].some((k) => Phaser.Input.Keyboard.JustDown(k))) {
      steps = 1;
      this.leverHeld = 0;
    } else if (direction !== 0) {
      const before = this.leverHeld;
      this.leverHeld += delta;
      steps = repeatsBetween(before, this.leverHeld);
    } else {
      this.leverHeld = 0;
    }
    if (steps === 0 || direction === 0) return;

    const range = spec.max - spec.min;
    const current = this.values[lever.param] ?? spec.default;
    const next = snap(
      Phaser.Math.Clamp(current + (direction * steps * range) / LEVER_NOTCHES, spec.min, spec.max),
      needleStep(range),
    );
    if (next === current) return; // at the stop already
    this.values[lever.param] = next;
    sfx.tick((next - spec.min) / Math.max(1e-6, range));
    this.cameras.main.shake(70, 0.0012);
  }

  /**
   * The lever on screen while it is in hand: where it sits, and the notches to
   * count. Not its number — the number to watch is the one the act is judged
   * on, and that is on the bottom line.
   */
  private drawLever(levers: Extract<ParamBinding, { kind: 'needle' }>[]): void {
    const g = this.hudLayer;
    g.clear();
    const bar = this.needleBar();
    const row = 34;
    const top = bar.y - (levers.length - 1) * row;
    g.fillStyle(0x0b0806, 0.85);
    g.fillRoundedRect(bar.x - 26, top - 18, bar.w + 52, (levers.length - 1) * row + bar.h + 36, 10);
    levers.forEach((lever, i) => {
      const spec = this.spec(lever.param);
      if (!spec) return;
      const y = top + i * row;
      const active = i === this.activeLever;
      const value = this.values[lever.param] ?? spec.default;
      const span = Math.max(1e-6, spec.max - spec.min);
      const fill = ((Phaser.Math.Clamp(value, spec.min, spec.max) - spec.min) / span) * bar.w;
      g.fillStyle(0x3a2514, 1);
      g.fillRoundedRect(bar.x, y, bar.w, bar.h, 9);
      g.fillStyle(GOLD, active ? 0.92 : 0.5);
      g.fillRoundedRect(bar.x, y, Math.max(bar.h, fill), bar.h, 9);
      g.lineStyle(1, 0x0b0806, 0.6);
      for (let n = 1; n < LEVER_NOTCHES; n++) {
        const x = bar.x + (bar.w * n) / LEVER_NOTCHES;
        g.lineBetween(x, y + 3, x, y + bar.h - 3);
      }
      this.dialLabel(i, { x: bar.x - 14, y: y + bar.h / 2 }, humaniseParam(lever.param), active);
    });
  }

  /** The bottom line while driving: the keys, and the judged number, live. */
  private leverLine(levers: Extract<ParamBinding, { kind: 'needle' }>[], run: Run): string {
    const keys = levers.length > 1 ? '← → the lever · ↑ ↓ pick one' : '← → the lever';
    const readout = this.stage?.readout;
    if (!readout || !this.gaugeExpr) return `${keys} · R start over`;
    try {
      const value = this.gaugeExpr.evaluate(run.scope as ExprScope);
      if (!Number.isFinite(value)) return `${keys} · R start over`;
      // A drift is read against zero, so its sign is the whole message.
      const sign = value > 0 && /drift|error|offset/i.test(readout.output) ? '+' : '';
      return `${keys} · R start over      ${readout.label} ${sign}${format(value)}${readout.unit ?? ''}`;
    } catch {
      return `${keys} · R start over`;
    }
  }

  /**
   * R mid-run: throw this attempt away and go again from the same start, now.
   *
   * It used to fall through to the full reset, which cleared the run but left
   * the scene in `driving` — and a driving scene with no run neither moves nor
   * lets the player move. The retry has to be instant; the time between failing
   * and trying again is the whole loop.
   */
  private restartDrive(): void {
    this.run = null;
    this.rumble?.stop();
    this.rumble = null;
    if (this.preRun) this.values = { ...this.preRun };
    this.preRun = null;
    this.braked = null;
    this.live = [];
    this.trailLayer.clear();
    this.mode = 'walk';
    sfx.close();
    this.startDrive();
  }

  private finishDrive(): void {
    const run = this.run;
    if (!run) return;
    const result = run.finish();
    this.run = null;
    // Back to where the lever started, so "again" means the same start and the
    // only thing that differs between attempts is what the hand did.
    if (this.preRun) this.values = { ...this.preRun };
    this.preRun = null;
    this.gaugeExpr = null;
    this.hudLayer.clear();
    for (const label of this.dialNames) label.setVisible(false);
    this.rumble?.stop();
    this.rumble = null;
    sfx.land(result.won);

    const span = this.braked
      ? (result.outputs.stopX ?? result.state.x ?? 0) - this.braked.value
      : 0;
    // "How far it took to stop once the brake went on" is a brake's lesson.
    // A thrust or a winch held on and off has no stopping span to label.
    const braking = (this.binding('control')?.label ?? 'brake') === 'brake';
    this.remember(
      this.live,
      result.won,
      this.braked && braking
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
    // A knock, a push in and the verdict's colour, all at once. The player has
    // just done the hard part; the frame should react to it.
    land(this, result.won);
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
      const shaft = this.stage?.playback?.shaft;
      const shift = (p: Point): Point =>
        shaft ? { x: p.x - lane * 16, y: p.y } : { x: p.x, y: p.y - lane * 17 };
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
    sfx.commit();
    gameBus.emit('commit', { values: { ...this.values } });
  }

  private leaveFocus(values: 'keep' | 'reset' = 'keep'): void {
    if (this.mode === 'needle' || this.mode === 'aim') {
      this.mode = 'walk';
      relax(this);
      // A balance stays framed until the player walks off, like a finished run.
      if (this.rig) this.cameraParked = true;
    }
    this.hudLayer.clear();
    this.consequence.setVisible(false);
    for (const label of this.dialNames) label.setVisible(false);
    this.ghostLayer.clear();
    this.readout.setVisible(false);
    if (values === 'reset') this.ghostLabel.setVisible(false);
  }

  private resetStage(): void {
    if (this.mode === 'driving') {
      this.restartDrive();
      return;
    }
    this.focus = this.focusProp();
    this.rumble?.stop();
    this.rumble = null;
    this.steam?.clear();
    this.actorWas = null;
    if (this.mode === 'playing') return;
    this.values = Object.fromEntries(this.params.map((p) => [p.name, p.default]));
    this.rigSettle?.stop();
    this.rigTilt = 0;
    this.rigLive = false;
    this.rigDelivered = 0;
    this.rigVerdict = null;
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
    this.cameras.main.startFollow(this.cameraTarget(), true, 0.12, 0.12);
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
    const dials = this.needles();
    const held = this.heldNeedle();
    if (!held || dials.length === 0) return;

    const bar = this.needleBar();
    const g = this.hudLayer;
    g.clear();

    // The whole board, sized to how many dials are on it. Tighter past four,
    // or a deck with four loads is a board that covers the deck.
    const row = dials.length > 4 ? 28 : 46;
    const top = bar.y - 100 - (dials.length - 1) * row;
    g.fillStyle(0x0b0806, 0.92);
    g.fillRoundedRect(bar.x - 26, top, bar.w + 52, 158 + (dials.length - 1) * row, 10);

    dials.forEach((needle, i) => {
      const spec = this.spec(needle.param);
      if (!spec) return;
      const y = bar.y - (dials.length - 1 - i) * row;
      const active = i === this.activeNeedle;
      const value = this.values[needle.param] ?? spec.default;
      const at = (v: number) =>
        bar.x +
        ((Phaser.Math.Clamp(v, spec.min, spec.max) - spec.min) / (spec.max - spec.min)) * bar.w;

      g.fillStyle(0x3a2514, active ? 1 : 0.55);
      g.fillRoundedRect(bar.x, y, bar.w, bar.h, 9);

      // The band is the claim being tested: inside it, a person could have walked.
      if (needle.band) {
        const from = at(needle.band.from);
        const to = at(needle.band.to);
        g.fillStyle(GREEN, active ? 0.75 : 0.4);
        g.fillRoundedRect(from, y, Math.max(2, to - from), bar.h, 9);
      }

      const x = at(value);
      const outside =
        needle.band !== undefined && (value < needle.band.from || value > needle.band.to);
      const tint = outside ? RED : GOLD;
      g.lineStyle(active ? 3 : 2, tint, active ? 1 : 0.45);
      g.beginPath();
      g.moveTo(x, y - 18);
      g.lineTo(x, y + bar.h + 12);
      g.strokePath();
      // The pointer over the held dial would sit on the row above on a tight board.
      if (active && row >= 46) {
        g.fillStyle(tint, 1);
        g.beginPath();
        g.moveTo(x, y - 18);
        g.lineTo(x - 11, y - 36);
        g.lineTo(x + 11, y - 36);
        g.closePath();
        g.fillPath();
      }

      // Each dial says its own name, so two of them are two things rather
      // than two identical sliders.
      // A live dial says so: it is the one you will still be holding.
      this.dialLabel(
        i,
        { x: bar.x - 14, y: y + bar.h / 2 },
        `${needle.label ?? humaniseParam(needle.param)}${needle.live ? ' (live)' : ''}`,
        active,
      );
    });

    const spec = this.spec(held.param)!;
    const value = this.values[held.param] ?? spec.default;
    const outside =
      held.band !== undefined && (value < held.band.from || value > held.band.to);
    const unit = held.unit ? ` ${held.unit}` : '';
    this.readout
      .setText(`${format(value)}${unit}`)
      .setColor(outside ? '#c05746' : '#d9a441')
      .setPosition(this.scale.width / 2, top - 34)
      .setVisible(true);

    // The consequence of this setting, not the setting. The verdict is still
    // withheld — this says what happens, never whether it is right.
    const says = this.previewReadout();
    this.consequence
      .setText(says ?? '')
      .setPosition(this.scale.width / 2, top - 70)
      .setVisible(says !== null);

    const caption = held.band?.label ? `green — ${held.band.label}` : '';
    const switcher = dials.length > 1 ? ' · ↑ ↓ pick a dial' : '';
    this.prompt
      .setText(
        this.rig
          ? `← → move it${dials.length > 1 ? ' · ↑ ↓ pick what to change' : ''} · E let go · Esc step back`
          : `← → set the needle${switcher} · ${this.binding('control') ? 'E done, then F to start' : this.liveNeedles().length > 0 ? 'E go — keep your hand on it' : 'E confirm'} · Esc step back${caption ? `\n${caption}` : ''}`,
      )
      .setPosition(this.scale.width / 2, bar.y + 92)
      .setVisible(true);
    this.drawRig();
  }

  /** One name beside each dial, reused between redraws. */
  private dialLabel(index: number, at: Point, text: string, active: boolean): void {
    let label = this.dialNames[index];
    if (!label) {
      label = this.add
        .text(0, 0, '', { fontFamily: 'monospace', fontSize: '13px' })
        .setOrigin(1, 0.5)
        .setScrollFactor(0)
        .setDepth(9600);
      this.dialNames[index] = label;
    }
    label
      .setText(text)
      .setColor(active ? '#d9a441' : '#8a8070')
      .setPosition(at.x, at.y)
      .setVisible(true);
  }


  /**
   * One step per tap, and a steady repeat while held. Discrete on purpose: the
   * answer here is a particular number, and hunting for it with a continuous
   * slider is dexterity, not deduction.
   */
  /**
   * Run the act's own simulation at whatever the dials currently say, and
   * report the number the act is judged on.
   *
   * The same engine that decides the verdict, so the preview can never
   * disagree with the result — and no win condition in it, because being told
   * the answer is not the same as working it out.
   */
  private previewReadout(): string | null {
    const readout = this.stage?.readout;
    if (!readout || !this.simSpec) return null;
    // A centre of mass no dial can move would be the answer printed on the
    // board. It is shown once the beam has been let go and has said so itself.
    if (this.rig && !this.rig.comLive && this.rigRuns === 0 && readout.label.startsWith('centre')) {
      return null;
    }
    // Where a lever will put its load is what releasing it is for. The torques
    // are on the loads already; the height is found out, not read off a board.
    if (this.rig?.delivers) return null;
    try {
      const run = simulate(this.simSpec, { ...this.values });
      const value = run.outputs[readout.output];
      if (value === undefined || !Number.isFinite(value)) return null;
      return `${readout.label} ${format(value)}${readout.unit ?? ''}`;
    } catch {
      // A dial set somewhere the spec cannot cope with says nothing useful.
      return null;
    }
  }

  private tickNeedle(delta: number): void {
    const dials = this.needles();
    const needle = this.heldNeedle();
    const spec = needle && this.spec(needle.param);
    if (!needle || !spec) return;

    this.player.body.setVelocity(0, 0);

    // Up and down pick the dial; left and right turn it. A tap each, so a
    // two-dial board never scrolls away under a held key.
    if (dials.length > 1) {
      const up = [this.cursors.up, this.keys.up].some((k) => Phaser.Input.Keyboard.JustDown(k));
      const down = [this.cursors.down, this.keys.down].some((k) =>
        Phaser.Input.Keyboard.JustDown(k),
      );
      if (up || down) {
        this.activeNeedle =
          (this.activeNeedle + (down ? 1 : -1) + dials.length) % dials.length;
        this.needleHeld = 0;
        sfx.tick(this.activeNeedle / Math.max(1, dials.length - 1));
        this.drawNeedle();
        return;
      }
    }

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
    const landed = snap(Phaser.Math.Clamp(next, spec.min, spec.max), step);
    if (landed !== this.values[needle.param]) {
      // Pitched to where on the scale it has landed, so you can hear the dial
      // climbing without looking away from the board.
      sfx.tick((landed - spec.min) / Math.max(1e-6, spec.max - spec.min));
    }
    this.values[needle.param] = landed;
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
    if (this.rig) {
      this.playBalance(payload);
      return;
    }
    const playback = this.stage?.playback;
    if (!playback) {
      // Nothing travels in this act: the verdict is the needle itself.
      this.mode = 'walk';
      land(this, payload.won);
      if (payload.won) sfx.win();
      else sfx.lose();
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
    sfx.launch();
    this.rumble?.stop();
    this.rumble = sfx.rumble();

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
        // Loudest in the middle of the flight, falling away as it arrives.
        this.rumble?.level(Math.sin((i / Math.max(1, points.length - 1)) * Math.PI) * 0.7);
        if (playback.actor === 'train') this.puffSteam(this.game.loop.delta, here);
      },
      onComplete: () => {
        const last = points[points.length - 1]!;
        this.actor?.setPosition(last.x, last.y);
        this.trailLayer.clear();
        this.rumble?.stop();
        this.rumble = null;
        sfx.land(payload.won);
        this.remember(points, payload.won);
        land(this, payload.won);
        this.ghostLayer.clear();
        this.ghostLabel.setVisible(false);
        this.cameras.main.stopFollow();
        this.cameraParked = true;
        this.mode = 'walk';
        gameBus.emit('played', { won: payload.won });
      },
    });
  }

  // --- a balance, let go ----------------------------------------------------

  /** Draw the beam as it stands: dials, tilt, what is in hand, the verdict. */
  private drawRig(): void {
    if (!this.rig) return;
    const held = this.mode === 'needle' ? (this.heldNeedle()?.param ?? null) : null;
    this.rig.draw({
      values: this.values,
      // At rest the beam lies where the sim's own initial state puts it, so
      // sliding the fulcrum re-seats the plank on the floor as it would.
      tilt: this.rigLive ? this.rigTilt : this.rig.restTilt(this.values),
      held,
      showCom: this.rig.comLive || this.rigRuns > 0,
      verdict: this.rigVerdict ? (this.rigVerdict.won ? 'won' : 'lost') : null,
      ...(this.rigVerdict ? { note: this.rigVerdict.note } : {}),
      delivered: this.rigDelivered,
      time: this.time.now,
    });
  }

  /**
   * Hands off the beam: it plays the run React simulated, sample by sample.
   * The tilt is the sim's angle and the timing is the sim's clock, so a beam
   * that creeps over slowly is a centre of mass that is only just off.
   */
  private playBalance(payload: {
    won: boolean;
    values: Record<string, number>;
    samples: SimSample[];
  }): void {
    const rig = this.rig!;
    this.rigSettle?.stop();
    this.values = { ...payload.values };
    this.rigVerdict = null;
    this.rigDelivered = 0;
    this.rigLive = true;
    const tilts = rig.tilts(payload.samples);
    // The last sample carries the run's outputs: the verdict is told from them.
    const outputs = payload.samples[payload.samples.length - 1];
    let grounded = false;
    const verdict = () => {
      this.rigVerdict = {
        won: payload.won,
        note: rig.explain(this.values, this.rigTilt, payload.won, outputs),
      };
      this.drawStage();
      sfx.land(payload.won);
      land(this, payload.won);
      this.mode = 'walk';
      gameBus.emit('played', { won: payload.won });
    };
    const finish = () => {
      const first = tilts[0] ?? 0;
      this.rigTilt = tilts[tilts.length - 1] ?? this.rigTilt;
      this.rigRuns++;
      this.rumble?.stop();
      this.rumble = null;
      if (!grounded && Math.abs(this.rigTilt - first) > 0.01) {
        // The swing ends with the counterweight's end on the floor.
        impact(this, 0.006, 150);
        sfx.bump();
      }
      if (!payload.won || !rig.delivers) {
        verdict();
        return;
      }
      // Won, and there is somewhere to put it: the crate goes onto the platform
      // first, and only then does the verdict land. The sim has already said
      // it got high enough; this is the consequence, not the decision.
      const slide = { t: 0 };
      this.tweens.add({
        targets: slide,
        t: 1,
        duration: 700,
        ease: 'Linear',
        onUpdate: () => {
          this.rigDelivered = slide.t;
          this.drawRig();
        },
        onComplete: () => {
          this.rigDelivered = 1;
          verdict();
        },
      });
    };

    if (tilts.length < 2) {
      // Nothing turns in this act: a short beat for the centre of mass to
      // settle over the deck, then the verdict.
      this.rigRuns++;
      this.drawRig();
      this.time.delayedCall(450, () => this.sys.isActive() && verdict());
      return;
    }

    const seconds = payload.samples[payload.samples.length - 1]?.t ?? 2;
    const cursor = { i: 0 };
    this.rumble?.stop();
    this.rumble = sfx.rumble();
    this.tweens.add({
      targets: cursor,
      i: tilts.length - 1,
      duration: Phaser.Math.Clamp(seconds * 1000, 900, 3200),
      ease: 'Linear',
      onUpdate: () => {
        const i = Math.floor(cursor.i);
        const a = tilts[i] ?? 0;
        const b = tilts[Math.min(i + 1, tilts.length - 1)] ?? a;
        this.rigTilt = a + (b - a) * (cursor.i - i);
        this.rumble?.level(Math.min(0.6, Math.abs(b - a) * 40));
        if (!grounded && rig.grounded(this.rigTilt, this.values)) {
          // The end meets the floor: that is the moment it has tipped.
          grounded = true;
          impact(this, 0.007, 160);
          sfx.bump();
        }
        this.drawRig();
      },
      onComplete: finish,
    });
  }

  /** Back to rest when the player takes hold again: a new setting, a new try. */
  private settleRig(): void {
    if (!this.rig) return;
    this.rigVerdict = null;
    this.rigDelivered = 0;
    if (!this.rigLive) {
      this.drawRig();
      return;
    }
    this.rigSettle?.stop();
    const state = { tilt: this.rigTilt };
    this.rigSettle = this.tweens.add({
      targets: state,
      tilt: this.rig.restTilt(this.values),
      duration: 320,
      ease: 'Back.easeOut',
      onUpdate: () => {
        this.rigTilt = state.tilt;
        this.drawRig();
      },
      onComplete: () => {
        this.rigLive = false;
        this.drawRig();
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
    if (playback.shaft) {
      const base = this.toScreen(playback.path.from.x, playback.path.from.y);
      const scale = this.shaftScale(playback);
      const climbed = (value - playback.path.fromValue) * scale;
      // Going down, the run starts at the head of the shaft and sinks to its foot.
      const span = Math.abs(playback.path.toValue - playback.path.fromValue) * scale;
      return { x: base.x, y: base.y - (playback.descends ? span - climbed : climbed) };
    }
    const world = this.alongPath(playback.path, value);
    const p = this.toScreen(world.x, world.y);
    const scale = playback.liftScale ?? this.pathScale(playback.path);
    return { x: p.x, y: p.y - height * scale };
  }

  /**
   * Screen px per unit of height up a shaft: as tall as the room lets the
   * camera show above the base, never so tall the top is out of the world.
   */
  private shaftScale(playback: Playback): number {
    if (playback.liftScale) return playback.liftScale;
    const base = this.toScreen(playback.path.from.x, playback.path.from.y);
    const room = Phaser.Math.Clamp(base.y + 120, 220, 460);
    const span = Math.abs(playback.path.toValue - playback.path.fromValue) || 1;
    return room / span;
  }

  /**
   * A shaft: two iron guide rails going straight up from the base, braced and
   * marked every round number, with the band you have to stop in painted
   * across them. Drawn over the props, because the lift is the subject.
   */
  private drawShaft(playback: Playback): void {
    const g = this.shaftLayer ?? (this.shaftLayer = this.add.graphics().setDepth(8400));
    g.clear();
    const at = (v: number) => this.pathPoint(playback, v, 0);
    const base = at(playback.path.fromValue);
    const top = at(playback.path.toValue);
    const w = 30;
    // Footing and the pit it rises from.
    g.fillStyle(0x000000, 0.35);
    g.fillEllipse(base.x, base.y + 4, w * 3.2, w * 1.2);
    g.fillStyle(0x2a2622, 1);
    g.fillRect(base.x - w - 8, base.y - 6, w * 2 + 16, 10);
    // Rails, with a highlight on the lit side.
    for (const dx of [-w, w]) {
      g.lineStyle(6, 0x3c4048, 1);
      g.lineBetween(base.x + dx, base.y, top.x + dx, top.y - 14);
      g.lineStyle(2, 0x8e969e, 0.8);
      g.lineBetween(base.x + dx - 2, base.y, top.x + dx - 2, top.y - 14);
    }
    // Cross-braces and the height scale, at round numbers.
    const span = playback.path.toValue - playback.path.fromValue;
    const step = niceStep(Math.abs(span));
    for (let v = playback.path.fromValue + step; v <= playback.path.toValue + 1e-9; v += step) {
      const p = at(v);
      g.lineStyle(2, 0x3c4048, 0.9);
      g.lineBetween(p.x - w, p.y, p.x + w, p.y);
      this.label({ x: p.x - w - 30, y: p.y + 9 }, `${format(v)}${playback.path.unit ?? ''}`, '#f4ecd8aa', 12);
    }
    // The head frame at the top.
    g.fillStyle(0x3c4048, 1);
    g.fillRect(top.x - w - 10, top.y - 22, w * 2 + 20, 10);
    // The band that wins, across the rails at the heights it covers.
    if (this.target) {
      const a = at(this.target.from);
      const b = at(this.target.to);
      g.fillStyle(GREEN, 0.22);
      g.fillRect(a.x - w, Math.min(a.y, b.y), w * 2, Math.max(4, Math.abs(a.y - b.y)));
      g.lineStyle(4, GREEN, 0.9);
      for (const p of [a, b]) g.lineBetween(p.x - w - 6, p.y, p.x + w + 6, p.y);
      this.label(
        { x: a.x + w + 70, y: (a.y + b.y) / 2 + 9 },
        'stop in here',
        '#6fbf73',
        14,
      );
    }
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

  /**
   * Which way the route points on screen, and how much a world length along it
   * is squashed by the projection. The engine is built in that basis rather
   * than drawn upright and rotated, which would shear its chimney.
   */
  private routeBasis(): { along: Point; squash: number } {
    const path = this.stage?.playback?.path;
    const fallback = { along: { x: 0.894, y: 0.447 }, squash: 0.559 };
    if (!path) return fallback;
    const a = this.toScreen(path.from.x, path.from.y);
    const b = this.toScreen(path.to.x, path.to.y);
    const screen = Math.hypot(b.x - a.x, b.y - a.y);
    const world = Math.hypot(path.to.x - path.from.x, path.to.y - path.from.y);
    if (screen < 1 || world < 1) return fallback;
    return { along: { x: (b.x - a.x) / screen, y: (b.y - a.y) / screen }, squash: screen / world };
  }

  private makeActor(actor: Playback['actor']): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(8700);
    if (actor === 'train') {
      const { along, squash } = this.routeBasis();
      // Half again a person's height. At 1:1 it read as a model on a shelf.
      drawLocomotive(g, along, squash, 1.3);
    } else if (actor === 'body') {
      // The neutral traveller: a slung load. A cage on a cable, a crate on a
      // lorry, a weighed wagon — whatever a generated act is actually moving,
      // this is a thing of mass going somewhere rather than a guess at it.
      const { along } = this.routeBasis();
      const hook = { x: along.x * 0, y: -34 };
      g.lineStyle(3, 0x8e969e, 1);
      g.beginPath();
      g.moveTo(hook.x, hook.y - 26);
      g.lineTo(hook.x, hook.y + 4);
      g.strokePath();
      g.fillStyle(0x6b4a2a, 1);
      g.fillRoundedRect(-20, -30, 40, 34, 4);
      g.fillStyle(0x8a5a2b, 1);
      g.fillRoundedRect(-20, -30, 40, 11, 3);
      g.lineStyle(2.5, 0x4a3426, 1);
      g.strokeRoundedRect(-20, -30, 40, 34, 4);
      g.lineStyle(2, 0x8e969e, 0.9);
      g.beginPath();
      g.moveTo(-20, -14);
      g.lineTo(20, -14);
      g.strokePath();
      g.fillStyle(GOLD, 1);
      g.fillCircle(hook.x, hook.y - 26, 4);
    } else {
      // A satchel: a flap, a buckle and a strap, so what is in the air is a
      // bag of mail and not a brown square.
      g.fillStyle(0x6b4423, 1);
      g.fillRoundedRect(-12, -10, 24, 20, 4);
      g.fillStyle(0x8a5a2b, 1);
      g.fillRoundedRect(-12, -10, 24, 9, 3);
      g.lineStyle(2.5, 0x4a2f18, 1);
      g.strokeRoundedRect(-12, -10, 24, 20, 4);
      g.fillStyle(GOLD, 1);
      g.fillRect(-3, -4, 6, 5);
      g.lineStyle(2, 0x4a2f18, 1);
      g.beginPath();
      g.moveTo(-10, -10);
      g.lineTo(0, -17);
      g.lineTo(10, -10);
      g.strokePath();
    }
    return g;
  }

  // --- the room ------------------------------------------------------------

  /**
   * The room, built.
   *
   * Every rect here is one the mapper already placed, so the art cannot drift
   * from the colliders — but a rect alone is not a prop. Walls get coursed
   * stone and no rim light; interactables get drawn as whatever they actually
   * are, which `props.ts` works out from the name the design pass gave them.
   *
   * Each interactable also gets a ring on the floor and a plate over it with
   * its name on, because the first thing you need to know in a room you have
   * never seen is which of these things you are allowed to touch.
   */
  private drawVolumes(blocked: Rect[], interactables: Interactable[]): void {
    if (!this.iso) return;
    const view = this.iso;

    // The south and east walls are the ones nearest the camera, so extruding
    // them walls the player off from the viewer — stand at the spawn and you
    // are behind one. Isometric rooms are drawn as cutaways for exactly this
    // reason: the near sides stay flat on the floor.
    const { width, height } = this.sceneData;
    const room = { width, height };
    const nearWall = (r: Rect) => r.y + r.h >= height - 1 || r.x + r.w >= width - 1;

    // A painted room arrives with its own edges — cliffs, retaining walls, a
    // shed roof — so drawing the perimeter again stacks grey boxes on top of
    // stonework that is already there. The colliders are untouched: those are
    // physics bodies made in create(), not these graphics.
    const painted = Boolean(this.sceneData.imageUrl);

    for (const rect of blocked) {
      // Depth from the front corner: the player passes in front once past it.
      const depth = isoDepth(rect.x + rect.w, rect.y + rect.h);
      if (!isWall(rect, room)) {
        const g = this.add.graphics();
        const kind = drawFurniture(g, rect, view);
        g.setDepth(depth);
        if (kind === 'lamp') this.lightUp(rect, 150);
        continue;
      }
      if (painted) continue;
      const g = this.add.graphics();
      const flat = nearWall(rect);
      drawWall(g, rect, view, flat);
      g.setDepth(flat ? 0.4 : depth);
    }

    this.footprints = this.add.graphics().setDepth(0.6);
    // Above the world, below the name plates: a marker you cannot lose behind
    // a crate, that never covers the label telling you what you are looking at.
    this.beacon = this.add.graphics().setDepth(9050);

    for (const target of interactables) {
      const kind = this.placeProp(target, view);
      if (kind === 'lamp') this.lightUp(target, 160);

      const apex = propApex(target, view);
      const text = this.add
        .text(apex.x, apex.y, propLabel(target), {
          fontFamily: 'monospace',
          fontSize: '14px',
          color: '#b9ad96',
          backgroundColor: '#0b080699',
          padding: { x: 7, y: 3 },
        })
        .setOrigin(0.5, 1)
        .setDepth(9100);
      this.plates.push({ id: target.id, text, home: apex.y });
    }

    // A way out is a lit way out: the one thing in the room the player is
    // allowed to leave by should read as somewhere light is coming from.
    for (const exit of this.sceneData.exits) this.lightUp(exit, 140, 0xd9a441, 0.3);

    this.focus = this.focusProp();
    // The one object the act actually wants you to touch gets the lamp. The
    // footprint ring says which prop is live; light says which is *the* prop.
    const lit = interactables.find((target) => target.id === this.focus);
    if (lit) this.lightUp(lit, Math.max(lit.w, 170) * 0.95, 0xe2a33c, 0.26);
    this.lightProps(true);
  }

  /**
   * The interactable the act's binding actually sits on, if any.
   *
   * A marker or a drive is about a stretch of track rather than an object, so
   * those have no focus and the beacon stays off — pointing at a prop that is
   * not the point would be worse than pointing at nothing.
   */
  private focusProp(): string | null {
    // A balance's subject is the beam, which is not a prop; see drawBeacon.
    if (this.stage?.balance) return null;
    const anchor = this.binding('needle')?.at ?? this.binding('aim')?.at;
    if (!anchor) return null;
    let best: string | null = null;
    let closest = Infinity;
    for (const it of this.sceneData.interactables) {
      const distance = Phaser.Math.Distance.Between(
        anchor.x,
        anchor.y,
        it.x + it.w / 2,
        it.y + it.h / 2,
      );
      if (distance < closest) {
        closest = distance;
        best = it.id;
      }
    }
    // The anchor is placed just off its own prop; anything further away than
    // that is a coincidence, not the subject.
    return closest <= 300 ? best : null;
  }

  /**
   * The beacon: a ring that breathes and a chevron that bobs, over the prop
   * the act needs. It stops the moment the player is holding the thing,
   * because by then it has done its job and is only in the way.
   */
  private drawBeacon(time: number): void {
    // Only an isometric room draws volumes, so a top-down room has no beacon.
    if (!this.iso || !this.beacon) return;
    this.beacon.clear();
    if (this.mode !== 'walk' || this.exiting) return;

    // Once the act is won there is nothing left to do at the prop: the thing to
    // walk to is the way out, so the beacon moves to the gate.
    let ground: Point;
    let apex: Point;
    let here: boolean;
    const gate = this.gate?.open ? this.gateRect : null;
    if (gate) {
      ground = this.toScreen(gate.x + gate.w / 2, gate.y + gate.h / 2);
      apex = { x: ground.x, y: ground.y - GATE_HEIGHT - 34 };
      here = this.nearGate();
    } else if (this.rig && !this.rigVerdict?.won) {
      ({ ground, apex } = this.rig.beacon());
      const anchor = this.binding('needle')?.at;
      here = anchor ? this.nearAnchor(anchor) : false;
    } else {
      if (!this.focus) return;
      const target = this.sceneData.interactables.find((it) => it.id === this.focus);
      if (!target) return;
      apex = propApex(target, this.iso);
      ground = this.toScreen(target.x + target.w / 2, target.y + target.h / 2);
      here = this.nearby === this.focus;
    }
    const pulse = 0.5 + 0.5 * Math.sin(time / 320);

    // The ring on the floor, breathing.
    const radius = 34 + pulse * 10;
    this.beacon.lineStyle(2.5, GOLD, (here ? 0.5 : 0.85) * (0.45 + 0.55 * (1 - pulse)));
    this.beacon.strokeEllipse(ground.x, ground.y, radius * 2, radius);

    if (here) return; // standing on it: the prompt takes over from here.

    // A chevron above it, bobbing. Down-pointing, because it is pointing at
    // the thing underneath it rather than at the sky.
    const y = apex.y - 26 - pulse * 7;
    this.beacon.fillStyle(GOLD, 0.95);
    this.beacon.fillTriangle(apex.x - 9, y, apex.x + 9, y, apex.x, y + 13);
    this.beacon.fillStyle(GOLD, 0.25 + pulse * 0.2);
    this.beacon.fillTriangle(apex.x - 15, y - 9, apex.x + 15, y - 9, apex.x, y + 8);
  }

  /** A pool of light on the floor under something that burns. */
  private lightUp(rect: Rect, radius: number, tint?: number, alpha?: number): void {
    if (!this.iso) return;
    const at = this.toScreen(rect.x + rect.w / 2, rect.y + rect.h / 2);
    const pool = addLightPool(this, at, radius, tint, alpha);
    // Dust lives in the light, above the world and under the vignette.
    const motes = new Motes(this.add.graphics().setDepth(8800), at, radius);
    this.pools.push({ pool, motes, seed: (rect.x * 7 + rect.y * 13) % 100 });
  }

  /**
   * One prop: painted if the art director reached it, drawn if it did not.
   *
   * The painting is hung on the rect the mapper placed — same footprint, same
   * depth, same name plate — so the collider and the picture cannot drift
   * apart, which is the whole reason this pipeline paints props one at a time
   * instead of painting a backdrop.
   *
   * Scale comes from the prop's own standing height, not from the size of the
   * frame it was painted in, so a dial and a winch drum end up the size the
   * room says they are rather than the size the model happened to crop them.
   */
  private placeProp(target: Interactable, view: IsoView): PropKind {
    const depth = isoDepth(target.x + target.w, target.y + target.h);
    const texture = isPaintedUrl(target.imageUrl) ? cutout(this, propKey(target.id)) : null;

    if (!texture) {
      const g = this.add.graphics().setDepth(depth);
      return drawProp(g, target, view).kind;
    }

    const at = isoProject(target.x + target.w / 2, target.y + target.h / 2, view);
    const image = this.add.image(at.x, at.y, texture).setOrigin(0.5, 1).setDepth(depth);
    const aspect = image.width / image.height;
    let tall = propHeight(target) * 1.3;
    let wide = tall * aspect;
    // A wide subject may not blanket the floor it is standing on: past the
    // diamond it would cover the props behind it and the player walking past.
    const widest = (target.w + target.h) * ISO_X * 1.5;
    if (wide > widest) {
      wide = widest;
      tall = wide / aspect;
    }
    image.setDisplaySize(wide, tall).setTint(WARM);
    this.shadowUnder(at, wide);
    return propKindFor(target);
  }

  /**
   * The dark patch that says a thing is standing on the floor rather than
   * hovering over it. The drawn props shade their own bases; a painted plate
   * has no base to shade.
   */
  private shadowUnder(at: Point, width: number): void {
    const g = this.add.graphics().setDepth(0.5);
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(at.x, at.y, width * 0.7, width * 0.3);
    g.fillStyle(0x000000, 0.22);
    g.fillEllipse(at.x, at.y, width * 0.95, width * 0.42);
  }

  /**
   * The cast, standing where the scene says they stand.
   *
   * Depth-sorted with everything else, so you can walk behind Dalvi, and each
   * one gets their name under them — a figure you cannot name is scenery, and
   * then the dialogue box introduces a stranger.
   */
  private placeCast(): void {
    if (!this.iso) return;
    for (const member of this.cast) {
      const spot = this.sceneData.npcSpots[member.id];
      if (!spot) continue;
      const at = this.toScreen(spot.x, spot.y);
      const depth = isoDepth(spot.x, spot.y);

      const texture = isPaintedUrl(member.sprite) ? cutout(this, castKey(member.id)) : null;
      if (texture) {
        const image = this.add.image(at.x, at.y, texture).setOrigin(0.5, 1).setDepth(depth);
        // Painted to the same height the drawn cast stand at. One room is one
        // scale: a portrait-sized stranger beside a 58px clerk is two games.
        image.setDisplaySize(CAST_HEIGHT * (image.width / image.height), CAST_HEIGHT);
        image.setTint(WARM);
        this.shadowUnder(at, CAST_HEIGHT * 0.52);
        this.extras.push({ image, phase: seedPhase(member.id), at, spot, depth });
      } else {
        const actor = new Actor(this, lookFor(member.id));
        // Turned to face into the room rather than all one way, so the spot
        // reads as somewhere a person chose to stand.
        actor.turn(spot.x < this.sceneData.width / 2 ? 1 : -1, 1);
        actor.step(0, 0, 0, at, depth);
        this.extras.push({ actor, at, spot, depth });
      }

      const plate = member.id === this.guide ? `${member.name} · ask me` : member.name;
      this.plates.push({
        id: `cast-${member.id}`,
        home: at.y + 16,
        text: this.add
          .text(at.x, at.y + 16, plate, {
            fontFamily: 'monospace',
            fontSize: '13px',
            color: '#c9b9a0',
            backgroundColor: '#0b080699',
            padding: { x: 6, y: 2 },
          })
          .setOrigin(0.5, 0)
          .setDepth(9100),
      });

      // The one person in the room you can ask anything gets the mark every
      // game uses for exactly that, so nobody has to be told who it is.
      if (member.id === this.guide) {
        const home = at.y - CAST_HEIGHT - 14;
        this.guideMark = {
          home,
          text: this.add
            .text(at.x, home, '?', {
              fontFamily: 'monospace',
              fontSize: '20px',
              fontStyle: 'bold',
              color: '#0b0806',
              backgroundColor: '#d9a441',
              padding: { x: 8, y: 2 },
            })
            .setOrigin(0.5, 1)
            .setDepth(9100),
        };
      }
    }
    this.spreadPlates();
  }

  /**
   * Scenery that stands between the camera and something that matters.
   *
   * The dressing keeps its footprints clear of people and props, but on an
   * isometric floor that is not the same as staying out of sight: a tree a
   * few metres in front of someone still covers them, canopy and all. The
   * first room this was looked at in hid the guide entirely behind one — a
   * name plate floating over a tree, and nobody under it.
   *
   * So anything upright that sits in front of a person or a prop and overlaps
   * them on screen is drawn see-through, which is what isometric games do. The
   * player is checked every frame in `revealHidden`; everyone else stands
   * still and is checked once, here.
   */
  private findOccluders(interactables: Interactable[]): void {
    if (!this.iso) return;
    const prefix = dressKey('');
    this.scenery = this.children.list
      .filter(
        (o): o is Phaser.GameObjects.Image =>
          o instanceof Phaser.GameObjects.Image &&
          o.texture.key.startsWith(prefix) &&
          o.originY === 1, // uprights stand on their feet; floor decals are centred
      )
      .map((image) => ({ image, box: image.getBounds() }));

    const keep: { box: Phaser.Geom.Rectangle; depth: number }[] = [
      ...this.extras.map(({ at, depth }) => ({
        box: new Phaser.Geom.Rectangle(at.x - 20, at.y - CAST_HEIGHT - 10, 40, CAST_HEIGHT + 10),
        depth,
      })),
      ...interactables.map((target) => {
        const at = isoProject(target.x + target.w / 2, target.y + target.h / 2, this.iso!);
        const wide = (target.w + target.h) * ISO_X * 0.8;
        const tall = propHeight(target) * 1.3;
        return {
          box: new Phaser.Geom.Rectangle(at.x - wide / 2, at.y - tall, wide, tall),
          depth: isoDepth(target.x + target.w, target.y + target.h),
        };
      }),
    ];

    this.veiled.clear();
    for (const { image, box } of this.scenery) {
      if (keep.some((k) => image.depth > k.depth && Phaser.Geom.Rectangle.Overlaps(box, k.box))) {
        this.veiled.add(image);
        image.setAlpha(OCCLUDER_ALPHA);
      }
    }
  }

  /** Fade whatever scenery the player has just walked behind, and restore it after. */
  private revealHidden(delta: number): void {
    if (!this.iso || this.scenery.length === 0) return;
    const p = isoProject(this.player.x, this.player.y, this.iso);
    const body = new Phaser.Geom.Rectangle(p.x - 18, p.y - 66, 36, 66);
    const depth = isoDepth(this.player.x, this.player.y) + 1;
    const ease = Math.min(1, delta / 120);
    for (const { image, box } of this.scenery) {
      const hiding =
        this.veiled.has(image) ||
        (image.depth > depth && Phaser.Geom.Rectangle.Overlaps(box, body));
      const target = hiding ? OCCLUDER_ALPHA : 1;
      if (image.alpha !== target) {
        const next = image.alpha + (target - image.alpha) * ease;
        image.setAlpha(Math.abs(next - target) < 0.02 ? target : next);
      }
    }
  }

  /**
   * The way on.
   *
   * Every room has always had an exit — a lit threshold and a chevron — and it
   * never did anything: the act ended with a button outside the world. Now the
   * exit is a gate. Shut, it is solid and barred, and walking into it says
   * why. Won, the bars go, the doorway fills with light, the beacon moves to
   * it, and stepping through it is how you get to the next act.
   */
  private setUpGate(): void {
    const exit = this.sceneData.exits[0];
    if (!exit || !this.gate) return;
    this.gateRect = exit;

    const zone = this.add.zone(exit.x + exit.w / 2, exit.y + exit.h / 2, exit.w, exit.h);
    this.physics.add.existing(zone, true);
    this.gateCollider = this.physics.add.collider(this.player, zone, () => this.bumpGate());
    this.gateCollider.active = !this.gate.open;

    this.gateLayer = this.add.graphics().setDepth(isoDepth(exit.x + exit.w, exit.y + exit.h));
    this.gateLabel = this.add
      .text(0, 0, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        backgroundColor: '#0b0806cc',
        padding: { x: 7, y: 3 },
      })
      .setOrigin(0.5, 1)
      .setDepth(9100);
    this.drawGate(0);
  }

  /** React says the act was won (or a solved act was reopened): unbar it. */
  private setGate(next: GameEvents['gate']): void {
    const opening = next.open && this.gate !== null && !this.gate.open;
    this.gate = next;
    if (this.gateCollider) this.gateCollider.active = !next.open;
    this.drawGate(this.time.now);
    if (!opening || !this.gateRect) return;

    // The unlock is its own moment, a beat after the verdict: a chime, a warm
    // flash, and a line saying where it leads.
    sfx.open();
    this.cameras.main.flash(260, 217, 164, 65);
    this.prompt
      .setText(
        next.last ? 'The way out is open' : `The gate is open — through it to ${next.leadsTo}`,
      )
      .setColor('#f6dca0')
      .setPosition(this.scale.width / 2, this.scale.height - 44)
      .setVisible(true);
    this.promptUntil = this.time.now + 2800;
    this.time.delayedCall(2800, () => {
      if (this.sys.isActive()) this.prompt.setColor('#f4ecd8');
    });
  }

  /**
   * Two posts and a lintel across the doorway. Barred and padlocked while
   * shut; filled with breathing light once open. Drawn from the exit rect
   * itself, so it stands exactly where the collider is.
   */
  private drawGate(time: number): void {
    const exit = this.gateRect;
    const gate = this.gate;
    const g = this.gateLayer;
    if (!exit || !gate || !g) return;
    g.clear();

    // The doorway runs along the wall the exit sits against.
    const along = exit.w >= exit.h;
    const cx = exit.x + exit.w / 2;
    const cy = exit.y + exit.h / 2;
    const a = along ? this.toScreen(exit.x, cy) : this.toScreen(cx, exit.y);
    const b = along ? this.toScreen(exit.x + exit.w, cy) : this.toScreen(cx, exit.y + exit.h);
    const ta = { x: a.x, y: a.y - GATE_HEIGHT };
    const tb = { x: b.x, y: b.y - GATE_HEIGHT };
    const at = (t: number, lift: number) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t - lift,
    });

    if (gate.open) {
      const pulse = 0.5 + 0.5 * Math.sin(time / 300);
      g.fillStyle(GOLD, 0.14 + pulse * 0.16);
      g.fillPoints(
        [a, b, tb, ta].map((p) => new Phaser.Geom.Point(p.x, p.y)),
        true,
      );
    } else {
      g.lineStyle(4, 0x22170f, 0.95);
      for (let i = 1; i < GATE_BARS; i++) {
        const foot = at(i / GATE_BARS, 0);
        g.lineBetween(foot.x, foot.y, foot.x, foot.y - GATE_HEIGHT);
      }
      const railA = at(0, GATE_HEIGHT * 0.45);
      const railB = at(1, GATE_HEIGHT * 0.45);
      g.lineStyle(3, 0x22170f, 0.95);
      g.lineBetween(railA.x, railA.y, railB.x, railB.y);
      const lock = at(0.5, GATE_HEIGHT * 0.45);
      g.fillStyle(RED, 0.95);
      g.fillRoundedRect(lock.x - 7, lock.y - 5, 14, 12, 3);
    }

    g.lineStyle(7, 0x3a2715, 1);
    g.lineBetween(a.x, a.y, ta.x, ta.y);
    g.lineBetween(b.x, b.y, tb.x, tb.y);
    g.lineStyle(6, gate.open ? GOLD : 0x3a2715, 1);
    g.lineBetween(ta.x, ta.y - 3, tb.x, tb.y - 3);

    this.gateLabel
      ?.setText(gate.open ? (gate.last ? '→ the way out' : `→ ${gate.leadsTo}`) : 'locked')
      .setColor(gate.open ? '#f6dca0' : '#c05746')
      .setPosition((ta.x + tb.x) / 2, Math.min(ta.y, tb.y) - 10);
  }

  /** Walking into a shut gate says why it is shut, once in a while, not every frame. */
  private bumpGate(): void {
    if (this.time.now - this.gateBumped < 900) return;
    this.gateBumped = this.time.now;
    sfx.deny();
    impact(this, 0.002, 90);
    this.prompt
      .setText('Locked — this act has to be won first')
      .setColor('#e0b35e')
      .setPosition(this.scale.width / 2, this.scale.height - 44)
      .setVisible(true);
    this.promptUntil = this.time.now + 1800;
    this.time.delayedCall(1800, () => {
      if (this.sys.isActive()) this.prompt.setColor('#f4ecd8');
    });
  }

  private nearGate(): boolean {
    const exit = this.gateRect;
    if (!exit) return false;
    return (
      Phaser.Math.Distance.Between(
        this.player.x,
        this.player.y,
        exit.x + exit.w / 2,
        exit.y + exit.h / 2,
      ) <= GATE_NEAR
    );
  }

  private inGate(): boolean {
    const exit = this.gateRect;
    if (!exit) return false;
    const { x, y } = this.player;
    return (
      x >= exit.x - 6 && x <= exit.x + exit.w + 6 && y >= exit.y - 6 && y <= exit.y + exit.h + 6
    );
  }

  /** Through the gate: the room goes dark, and React is told to bring on the next. */
  private leaveThroughGate(): void {
    this.exiting = true;
    this.player.body.setVelocity(0, 0);
    this.prompt.setVisible(false);
    sfx.commit();
    this.cameras.main.fadeOut(520, 11, 8, 6);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      gameBus.emit('exit', {});
    });
  }

  /** Close enough to the guide to ask, measured on the plane like everything else. */
  private isNearGuide(): boolean {
    const spot = this.guide ? this.sceneData.npcSpots[this.guide] : undefined;
    if (!spot) return false;
    return (
      Phaser.Math.Distance.Between(this.player.x, this.player.y, spot.x, spot.y) <=
      INTERACT_RADIUS + 40
    );
  }

  /**
   * Nudge plates off each other.
   *
   * Nothing stops a prop standing where a character does, and two labels on top
   * of one another is unreadable — it is the thing that made the first version
   * of this screen look like a debug overlay. Run once, after everything is
   * placed: whichever of an overlapping pair is higher goes higher still.
   */
  private spreadPlates(): void {
    // Start from home every time: the stage redraws its own labels as the act
    // is played, and a spread that compounded on the last one would walk the
    // plates off the top of the room.
    for (const plate of this.plates) plate.text.y = plate.home;

    // The stage's labels are anchored to things that mean something — a target
    // band, a distance — so they hold still and the plates move around them.
    const fixed = this.stageLabels.map((label) => label.getBounds());
    const plates = this.plates.map((plate) => plate.text);

    for (let pass = 0; pass < 6; pass++) {
      let moved = false;
      const lift = (text: Phaser.GameObjects.Text, by: number) => {
        text.y -= by;
        moved = true;
      };
      for (let i = 0; i < plates.length; i++) {
        const a = plates[i]!;
        for (const rect of fixed) {
          const ra = a.getBounds();
          if (Phaser.Geom.Rectangle.Overlaps(ra, rect)) lift(a, ra.bottom - rect.top + 5);
        }
        for (let j = i + 1; j < plates.length; j++) {
          const b = plates[j]!;
          const ra = a.getBounds();
          const rb = b.getBounds();
          if (!Phaser.Geom.Rectangle.Overlaps(ra, rb)) continue;
          const by = Math.min(ra.bottom - rb.top, rb.bottom - ra.top) + 5;
          if (ra.centerY <= rb.centerY) lift(a, by);
          else lift(b, by);
        }
      }
      if (!moved) break;
    }
  }

  /**
   * Light whichever prop is in reach. Only redraws when that changes, so this
   * is free to call every frame.
   */
  private lightProps(force = false): void {
    if (!this.iso || !this.footprints) return;
    if (!force && this.nearby === this.highlighted) return;
    if (!force && this.nearby && this.nearby !== this.highlighted) sfx.near();
    this.highlighted = this.nearby;

    this.footprints.clear();
    for (const target of this.sceneData.interactables) {
      drawFootprint(
        this.footprints,
        target,
        this.iso,
        target.id === this.nearby || target.id === this.focus,
      );
    }
    for (const plate of this.plates) {
      const active = plate.id === this.nearby;
      const wanted = plate.id === this.focus;
      plate.text.setColor(active ? '#f6dca0' : wanted ? '#d9a441' : '#b9ad96');
      plate.text.setBackgroundColor(active || wanted ? '#2a1c0edd' : '#0b080699');
      plate.text.setScale(active ? 1.1 : 1);
    }
  }

  private drawDebug(
    blocked: Rect[],
    interactables: Interactable[],
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

  /** What the camera is pinned to: the drawn figure, or the body when top-down. */
  private cameraTarget(): Phaser.GameObjects.Components.Transform {
    return this.walker?.root ?? this.avatar;
  }

  /**
   * Move the drawn figure onto the body, and hand it the velocity it is moving
   * at so the stride matches the ground it is covering.
   */
  private syncAvatar(delta = 0): void {
    if (!this.iso) return;
    const p = isoProject(this.player.x, this.player.y, this.iso);
    const depth = isoDepth(this.player.x, this.player.y) + 1;
    if (this.walker) {
      const body = this.player.body;
      // Tightens as the stride lengthens, which is what reads as weight.
      const moving = Math.hypot(body.velocity.x, body.velocity.y) > 8;
      this.playerShadow?.clear();
      this.playerShadow?.fillStyle(0x000000, moving ? 0.34 : 0.28);
      this.playerShadow?.fillEllipse(p.x, p.y, moving ? 26 : 30, moving ? 11 : 13);
      if (this.walker.step(delta, body.velocity.x, body.velocity.y, p, depth)) sfx.step();
      return;
    }
    this.avatar.setPosition(p.x, p.y);
    this.avatar.setDepth(depth);
  }

  /**
   * Leave a puff behind, if the thing travelling is the kind that makes any.
   * Spawned by ground covered rather than by time, so a wagon crawling the last
   * few metres stops chuffing like one at speed.
   */
  private puffSteam(delta: number, actorAt: Point): void {
    if (this.stage?.playback?.actor !== 'train') return;
    const travelled = this.actorWas
      ? Phaser.Math.Distance.BetweenPoints(this.actorWas, actorAt)
      : 0;
    this.actorWas = { ...actorAt };
    const { along } = this.routeBasis();
    const offset = chimneyOffset(along, 1.3);
    this.steam?.update(delta, { x: actorAt.x + offset.x, y: actorAt.y + offset.y }, travelled);
  }

  /**
   * The cast breathe and shift even while the player is doing something else —
   * and they look up when you come near. A room of people who never register
   * that you walked in is a room of furniture wearing hats.
   */
  private stepExtras(delta: number): void {
    for (const extra of this.extras) {
      const dx = this.player.x - extra.spot.x;
      const dy = this.player.y - extra.spot.y;
      if (extra.actor) {
        if (Math.hypot(dx, dy) < NOTICE_RADIUS) extra.actor.turn(dx, dy);
        extra.actor.step(delta, 0, 0, extra.at, extra.depth);
        continue;
      }
      if (!extra.image) continue;
      // A painted plate cannot look up when you come near, so it breathes:
      // enough movement that the room is not a photograph, not enough to
      // pretend it is animation.
      extra.phase = (extra.phase ?? 0) + delta / 1000;
      extra.image.setY(extra.at.y + Math.sin(extra.phase * 1.5) * 1.4);
    }
  }

  override update(_time: number, delta: number): void {
    // Breathing and guttering come before the mode check: the room should not
    // freeze solid the moment the player opens a dial.
    this.stepExtras(delta);
    this.revealHidden(delta);
    if (this.guideMark) {
      this.guideMark.text.setY(this.guideMark.home + Math.sin(_time / 320) * 4);
    }
    for (const { pool, motes, seed } of this.pools) {
      pool.level(flicker(_time, seed));
      motes.draw(_time + seed * 90);
    }
    // Steam that has already left the chimney keeps rising on its own.
    if (this.mode !== 'driving') this.steam?.update(delta, null, 0);
    if (this.rig) {
      // In front of the beam or behind it, measured where the player stands.
      const front = this.rig.frontY();
      const x = this.player.x;
      this.rig.setDepth(
        this.player.y > front ? isoDepth(x, front) - 1 : isoDepth(x, this.player.y) + 2,
      );
      // The load in hand breathes; nothing else here moves unless the sim does.
      if (this.mode === 'needle') this.drawRig();
    }
    this.drawBeacon(_time);
    if (this.gate?.open) this.drawGate(_time);
    if (this.exiting) {
      this.player.body.setVelocity(0, 0);
      this.syncAvatar(delta);
      return;
    }
    if (this.mode === 'driving') {
      this.tickDrive(delta);
      return;
    }
    if (this.mode === 'needle') {
      this.tickNeedle(delta);
      this.syncAvatar(delta);
      return;
    }
    if (this.mode === 'aim' || this.mode === 'playing') {
      this.player.body.setVelocity(0, 0);
      this.syncAvatar(delta);
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

    // Walking into a wall should be something you feel. Without it the player
    // presses the key harder, because nothing has told them they have arrived
    // at the edge of the room.
    const pressing = ix !== 0 || iy !== 0;
    if (pressing && !body.blocked.none && _time - this.lastBump > 260) {
      this.lastBump = _time;
      sfx.bump();
      impact(this, 0.0018, 90);
    }
    // The camera stays where a run ended until the player walks away from it.
    if (this.cameraParked && (ix !== 0 || iy !== 0)) {
      this.cameras.main.startFollow(this.cameraTarget(), true, 0.12, 0.12);
      this.cameraParked = false;
    }
    this.syncAvatar(delta);

    if (this.gate?.open && this.inGate()) {
      this.leaveThroughGate();
      return;
    }

    this.nearby = this.closestInteractable();
    this.nearGuide = this.isNearGuide();
    this.lightProps();
    this.updatePrompt();
  }

  /** The ghost marker that follows you along the route, and the bottom line. */
  private updatePrompt(): void {
    // A message with a hold on it outranks the ambient prompt until it expires.
    if (this.time.now < this.promptUntil) return;
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
    if (this.nearGuide && this.guide) {
      const name = this.cast.find((c) => c.id === this.guide)?.name ?? 'the guide';
      return `E — ask ${name} a question`;
    }

    if (this.gate && this.gateRect && this.nearGate()) {
      if (!this.gate.open) return 'The gate opens when this act is won';
      return this.gate.last ? 'Walk through — the way out' : `Walk through to ${this.gate.leadsTo}`;
    }

    const control = this.binding('control');
    const board = this.binding('needle');
    if (control && board && this.nearAnchor(board.at)) {
      return `E — set ${board.prompt ?? 'the board'} · F — ${control.prompt ?? 'start the run'}`;
    }
    if (control) {
      return this.ghosts.length > 0
        ? 'F — again · R clear the ghosts'
        : `F — ${control.prompt ?? 'let her go'}`;
    }

    // A live board: F goes again from the same start, the board is where the
    // start changes.
    if (this.liveNeedles().length > 0 && this.ghosts.length > 0) {
      return 'F — again · E at the board to change the start · R clear the ghosts';
    }

    if (this.planted) {
      const marker = this.binding('marker');
      return `F — ${marker?.prompt ? 'release the train' : 'run it'} · R replant`;
    }

    const needle = this.binding('needle');
    if (needle && this.nearAnchor(needle.at)) {
      return this.rig
        ? `E — take hold of ${needle.prompt ?? 'the machine'} · F — release it as it is`
        : `E — ${needle.prompt ?? 'the dial'}`;
    }

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

/** `claimedClerkRate` → `claimed clerk rate`. A dial needs a name, not an identifier. */
function humaniseParam(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
}

function normalise(x: number, y: number): { x: number; y: number } {
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
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

/** A stable scramble of a tile's coordinates, so a floor looks the same every visit. */
function hash2(x: number, y: number, seed: number): number {
  let h = (seed ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Spread a Point into the (x, y) pair toScreen takes. */
function pointArgs(p: Point): [number, number] {
  return [p.x, p.y];
}
