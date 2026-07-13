import * as THREE from 'three';
import { ZONE_PITCH, zonePosition } from '@shared/layout';
import { stdb } from '../stdb';
import { KIOSK, REDUCED_MOTION } from '../config';

const SPEED = 14;
const SEND_INTERVAL_MS = 100; // 10 Hz cap
const MOVE_EPSILON = 0.02;
const EMOTES: Record<string, string> = { Digit1: '👋', Digit2: '🎉', Digit3: '☕', Digit4: '💡' };

/**
 * Local player: capsule mesh, WASD movement relative to a mouse-orbit
 * third-person camera. Sends move_player at most 10 Hz and only when moved.
 */
export class Player {
  readonly mesh: THREE.Group;
  readonly position = new THREE.Vector3(0, 0, 8);
  heading = 0;
  camYaw = 0;
  camPitch = 0.45;
  camDist = 22;

  #keys = new Set<string>();
  #dragging = false;
  #lastSend = 0;
  #lastSent = { x: NaN, y: NaN, z: NaN, heading: NaN, animation: '' };
  #camera: THREE.PerspectiveCamera;
  #canvas: HTMLCanvasElement;
  #zoneIds: number[] = [];
  #moving = false;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    this.#camera = camera;
    this.#canvas = canvas;
    this.mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.45, 0.9, 4, 12),
      new THREE.MeshStandardMaterial({ color: 0x4da3ff, roughness: 0.5 })
    );
    body.position.y = 0.95;
    this.mesh.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xf2d6b8, roughness: 0.7 })
    );
    head.position.y = 2.0;
    this.mesh.add(head);
    this.mesh.position.copy(this.position);
    if (!KIOSK) scene.add(this.mesh);
    if (!KIOSK) this.#bind();
  }

  setZoneIds(ids: number[]): void {
    this.#zoneIds = ids;
  }

  #bind(): void {
    window.addEventListener('keydown', e => {
      if (isTypingTarget(e.target)) return;
      this.#keys.add(e.code);
      if (EMOTES[e.code]) stdb.setEmote(EMOTES[e.code]);
      if (e.code === 'Digit0') stdb.setEmote(undefined);
    });
    window.addEventListener('keyup', e => this.#keys.delete(e.code));
    window.addEventListener('blur', () => this.#keys.clear());

    this.#canvas.addEventListener('pointerdown', e => {
      if (e.button === 0) {
        this.#dragging = true;
        this.#canvas.setPointerCapture(e.pointerId);
      }
    });
    this.#canvas.addEventListener('pointermove', e => {
      if (!this.#dragging) return;
      this.camYaw -= e.movementX * 0.005;
      this.camPitch = THREE.MathUtils.clamp(this.camPitch + e.movementY * 0.004, 0.08, 1.35);
    });
    const stop = (e: PointerEvent) => {
      this.#dragging = false;
      try { this.#canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    this.#canvas.addEventListener('pointerup', stop);
    this.#canvas.addEventListener('pointercancel', stop);
    this.#canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.03, 8, 90);
    }, { passive: false });
  }

  /** Teleport (fast travel). */
  teleport(x: number, z: number): void {
    this.position.set(x, 0, z);
    this.mesh.position.copy(this.position);
    this.#sendNow('idle');
  }

  currentZoneId(): number {
    let best = 0;
    let bestDist = Infinity;
    for (const zid of this.#zoneIds) {
      const p = zonePosition(zid);
      const d = Math.hypot(p.x - this.position.x, p.z - this.position.z);
      if (d < bestDist) {
        bestDist = d;
        best = zid;
      }
    }
    return bestDist <= ZONE_PITCH / 2 ? best : 0;
  }

  update(dt: number, elapsed: number): void {
    if (KIOSK) {
      // idle camera slowly orbits the whole world
      const r = 260;
      const a = REDUCED_MOTION ? 0.8 : elapsed * 0.03;
      this.#camera.position.set(Math.cos(a) * r, 130, Math.sin(a) * r);
      this.#camera.lookAt(0, 0, 0);
      return;
    }

    const forward = (this.#keys.has('KeyW') ? 1 : 0) - (this.#keys.has('KeyS') ? 1 : 0);
    const strafe = (this.#keys.has('KeyD') ? 1 : 0) - (this.#keys.has('KeyA') ? 1 : 0);
    this.#moving = forward !== 0 || strafe !== 0;
    if (this.#moving) {
      const sin = Math.sin(this.camYaw);
      const cos = Math.cos(this.camYaw);
      // camera looks toward -Z at yaw 0
      const dx = (sin * -forward + cos * strafe) * SPEED * dt;
      const dz = (cos * -forward - sin * strafe) * SPEED * dt;
      this.position.x += dx;
      this.position.z += dz;
      this.heading = Math.atan2(dx, dz);
      this.mesh.rotation.y = this.heading;
    }
    this.mesh.position.copy(this.position);
    // subtle walk bob (sway) unless reduced motion
    this.mesh.position.y = !REDUCED_MOTION && this.#moving ? Math.abs(Math.sin(elapsed * 8)) * 0.12 : 0;

    // third-person camera
    const target = new THREE.Vector3(this.position.x, this.position.y + 2, this.position.z);
    const off = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch)
    ).multiplyScalar(this.camDist);
    this.#camera.position.copy(target).add(off);
    this.#camera.lookAt(target);

    // networked movement, throttled to 10 Hz and only on change
    const now = performance.now();
    if (now - this.#lastSend >= SEND_INTERVAL_MS) {
      const animation = this.#moving ? 'walk' : 'idle';
      const s = this.#lastSent;
      const moved =
        Math.abs(this.position.x - s.x) > MOVE_EPSILON ||
        Math.abs(this.position.z - s.z) > MOVE_EPSILON ||
        Math.abs(this.heading - s.heading) > 0.01 ||
        animation !== s.animation;
      if (moved) this.#sendNow(animation, now);
    }
  }

  #sendNow(animation: string, now = performance.now()): void {
    this.#lastSend = now;
    this.#lastSent = { x: this.position.x, y: 0, z: this.position.z, heading: this.heading, animation };
    stdb.movePlayer(this.position.x, 0, this.position.z, this.heading, this.currentZoneId(), animation);
  }
}

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
