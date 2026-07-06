import * as THREE from 'three';
import { zonePosition, ROOM_SIZE } from '@shared/layout';
import { stdb, type RoomBurst } from '../stdb';
import { KIOSK, SYNTHETIC } from '../config';
import { ZoneLayer, type ZoneDatum } from './zones';
import { RoomLayer, type RoomDatum } from './rooms';
import { AvatarLayer } from './avatars';
import { StaffLayer } from './staff';
import { Player } from './player';
import { DayNight } from './daynight';
import { BurstLayer } from './bursts';
import { syntheticWorld } from './synthetic';

export interface PerfStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  rooms: number;
}

/**
 * The three.js world. Owns the render loop; the scene graph lives entirely
 * outside React. Consumes the stdb store via its change events.
 */
export class WorldApp {
  onRoomSelected: ((roomId: number | null, via: 'click' | 'approach') => void) | null = null;

  #renderer: THREE.WebGLRenderer;
  #scene = new THREE.Scene();
  #camera: THREE.PerspectiveCamera;
  #clock = new THREE.Clock();
  #zoneLayer: ZoneLayer;
  #roomLayer: RoomLayer;
  #avatarLayer: AvatarLayer;
  #staffLayer: StaffLayer;
  #staffLabelTimer = 0;
  #burstLayer: BurstLayer;
  #dayNight: DayNight;
  #player: Player;
  #raycaster = new THREE.Raycaster();
  #pointerDown: { x: number; y: number } | null = null;
  #approachedRoom: number | null = null;
  #approachTimer = 0;
  #fpsSamples: number[] = [];
  #perf: PerfStats = { fps: 0, drawCalls: 0, triangles: 0, rooms: 0 };
  #perfHud: HTMLDivElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.#camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    this.#camera.position.set(0, 30, 45);

    // Ground plane + central plaza marker
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400),
      new THREE.MeshStandardMaterial({ color: 0x141a28, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    this.#scene.add(ground);
    const plaza = new THREE.Mesh(
      new THREE.CylinderGeometry(16, 16, 0.8, 48),
      new THREE.MeshStandardMaterial({ color: 0x2a3654, roughness: 0.7, emissive: 0x2f6bd8, emissiveIntensity: 0.25 })
    );
    plaza.position.y = 0.4;
    this.#scene.add(plaza);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(18, 0.35, 10, 64),
      new THREE.MeshStandardMaterial({ color: 0x2f6bd8, emissive: 0x2f6bd8, emissiveIntensity: 0.8 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.6;
    this.#scene.add(ring);

    this.#zoneLayer = new ZoneLayer(this.#scene);
    this.#roomLayer = new RoomLayer(this.#scene);
    this.#avatarLayer = new AvatarLayer(this.#scene);
    this.#staffLayer = new StaffLayer(this.#scene);
    this.#burstLayer = new BurstLayer(this.#scene);
    this.#dayNight = new DayNight(this.#scene);
    this.#player = new Player(this.#scene, this.#camera, canvas);

    this.#resize();
    window.addEventListener('resize', () => this.#resize());
    this.#bindPicking(canvas);
    this.#wireStore();

    if (SYNTHETIC) {
      // perf HUD for the ?synthetic=1 stress mode
      const hud = document.createElement('div');
      hud.style.cssText =
        'position:fixed;left:12px;bottom:12px;z-index:60;font:12px monospace;' +
        'color:#9db8ff;background:rgba(8,11,22,.7);padding:6px 10px;border-radius:8px;pointer-events:none;';
      hud.textContent = 'measuring…';
      document.body.appendChild(hud);
      this.#perfHud = hud;
    }
  }

  #resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.#renderer.setSize(w, h);
    this.#camera.aspect = w / h;
    this.#camera.updateProjectionMatrix();
  }

  #bindPicking(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', e => {
      this.#pointerDown = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', e => {
      const start = this.#pointerDown;
      this.#pointerDown = null;
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return; // drag, not click
      const mesh = this.#roomLayer.mesh;
      if (!mesh) return;
      const ndc = new THREE.Vector2(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
      );
      this.#raycaster.setFromCamera(ndc, this.#camera);
      const hits = this.#raycaster.intersectObject(mesh, false);
      const hit = hits.find(h => h.instanceId !== undefined);
      if (hit && hit.instanceId !== undefined) {
        const room = this.#roomLayer.roomAt(hit.instanceId);
        if (room) this.onRoomSelected?.(room.roomId, 'click');
      }
    });
  }

  #wireStore(): void {
    if (SYNTHETIC) {
      const { zones, rooms } = syntheticWorld();
      this.#zoneLayer.setZones(zones);
      this.#roomLayer.setRooms(rooms);
      this.#player.setZoneIds(zones.map(z => z.zoneId));
      this.#perf.rooms = rooms.length;
      // still take live glow/bursts if the server has matching rooms — harmless
    } else {
      const applyZones = () => {
        const zones: ZoneDatum[] = [...stdb.zones.values()].map(z => ({
          zoneId: z.zoneId,
          teamId: z.teamId,
          name: z.name,
        }));
        this.#zoneLayer.setZones(zones);
        this.#player.setZoneIds(zones.map(z => z.zoneId));
      };
      const applyRooms = () => {
        const rooms: RoomDatum[] = [...stdb.rooms.values()].map(r => ({
          roomId: r.roomId,
          channelId: r.channelId,
          teamId: r.teamId,
          name: r.name,
          glow: r.glow,
          isPrivate: r.isPrivate,
        }));
        this.#roomLayer.setRooms(rooms);
        this.#perf.rooms = rooms.length;
      };
      stdb.on('zones', applyZones);
      stdb.on('rooms', applyRooms);
      applyZones();
      applyRooms();
    }

    stdb.on('players', () => this.#avatarLayer.sync(stdb.players, stdb.users, stdb.identityHex));
    stdb.on('users', () => this.#avatarLayer.sync(stdb.players, stdb.users, stdb.identityHex));

    const applyStaff = () => this.#staffLayer.sync(stdb.staff);
    stdb.on('staff', applyStaff);
    applyStaff();

    const applyWorldState = () => {
      if (stdb.worldState) this.#dayNight.set(stdb.worldState.dayPhase, stdb.worldState.mood);
    };
    stdb.on('worldState', applyWorldState);
    applyWorldState();

    stdb.on('burst', payload => {
      const burst = payload as RoomBurst;
      const p = this.#roomLayer.positionOf(burst.roomId);
      if (p) this.#burstLayer.spawn(p.x, 8.5, p.z, burst.magnitude);
    });
  }

  /** Teleport camera + player to a room. */
  fastTravelToRoom(roomId: number): void {
    const p = this.#roomLayer.positionOf(roomId);
    if (!p) return;
    this.#player.teleport(p.x + ROOM_SIZE, p.z + ROOM_SIZE);
    this.onRoomSelected?.(roomId, 'click');
  }

  fastTravelToZone(zoneId: number): void {
    const p = zonePosition(zoneId);
    this.#player.teleport(p.x, p.z + 20);
  }

  getPerfStats(): PerfStats {
    return { ...this.#perf };
  }

  start(): void {
    this.#renderer.setAnimationLoop(() => this.#frame());
  }

  #frame(): void {
    const dt = Math.min(this.#clock.getDelta(), 0.1);
    const elapsed = this.#clock.elapsedTime;

    this.#player.update(dt, elapsed);
    this.#roomLayer.update(dt, KIOSK ? this.#camera.position : this.#player.position);
    this.#avatarLayer.update(dt, elapsed);
    this.#staffLabelTimer -= dt;
    if (this.#staffLabelTimer <= 0) {
      this.#staffLabelTimer = 0.5;
      this.#staffLayer.updateLabels(this.#camera.position);
    }
    this.#burstLayer.update(dt);
    this.#dayNight.update(dt, elapsed);
    this.#checkApproach(dt);

    this.#renderer.render(this.#scene, this.#camera);

    // perf accounting: rolling average over the last ≤60 frames
    if (dt > 0) {
      this.#fpsSamples.push(1 / dt);
      if (this.#fpsSamples.length > 60) this.#fpsSamples.shift();
      this.#perf.fps = Math.round(
        this.#fpsSamples.reduce((a, b) => a + b, 0) / this.#fpsSamples.length
      );
    }
    this.#perf.drawCalls = this.#renderer.info.render.calls;
    this.#perf.triangles = this.#renderer.info.render.triangles;
    if (this.#perfHud) {
      this.#perfHud.textContent =
        `${this.#perf.fps} fps · ${this.#perf.drawCalls} draws · ` +
        `${(this.#perf.triangles / 1000).toFixed(1)}k tris · ${this.#perf.rooms} rooms`;
    }
  }

  #checkApproach(dt: number): void {
    if (KIOSK) return;
    this.#approachTimer -= dt;
    if (this.#approachTimer > 0) return;
    this.#approachTimer = 0.4;
    const pos = this.#player.position;
    let nearest: number | null = null;
    let bestD = ROOM_SIZE * 1.1;
    for (const room of this.#roomLayer.rooms) {
      const p = this.#roomLayer.positionOf(room.roomId)!;
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d < bestD) {
        bestD = d;
        nearest = room.roomId;
      }
    }
    if (nearest !== this.#approachedRoom) {
      this.#approachedRoom = nearest;
      if (nearest !== null) this.onRoomSelected?.(nearest, 'approach');
    }
  }
}

// Expose perf stats for verification tooling.
declare global {
  interface Window {
    __space365Perf?: () => PerfStats;
  }
}
export function exposePerf(app: WorldApp): void {
  window.__space365Perf = () => app.getPerfStats();
}
