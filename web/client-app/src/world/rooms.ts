import * as THREE from 'three';
import { ROOM_SIZE, roomPosition } from '@shared/layout';
import { makeTextSprite, retext } from './labels';
import { glowColor, teamColor, GLOW_COLD, GLOW_HOT } from './palette';
import { REDUCED_MOTION } from '../config';

export interface RoomDatum {
  roomId: number;
  channelId: string;
  teamId: string;
  name: string;
  glow: number;
  isPrivate: boolean;
}

const ROOM_HEIGHT = 7;
const MAX_POINT_LIGHTS = 16;
const LABEL_POOL = 48;
const GLOW_LERP_RATE = 3.0; // per second

/**
 * Room buildings as ONE InstancedMesh (voxel-ish boxes). Per-instance:
 *  - diffuse color (team hue; private rooms darkened)
 *  - emissive glow via a custom `instanceGlow` attribute patched into the
 *    standard material (colorblind-safe blue->orange ramp), lerped per frame.
 * Point lights are a small pool assigned to the hottest rooms (> 0.3 glow).
 * Signage labels are a pooled set of sprites for the rooms nearest the camera.
 */
export class RoomLayer {
  readonly group = new THREE.Group();
  rooms: RoomDatum[] = [];
  /** roomId -> instance index */
  #indexByRoomId = new Map<number, number>();
  #mesh: THREE.InstancedMesh | null = null;
  #glowAttr: THREE.InstancedBufferAttribute | null = null;
  #currentGlow: Float32Array = new Float32Array(0);
  #targetGlow: Float32Array = new Float32Array(0);
  #positions: { x: number; z: number }[] = [];
  #lights: THREE.PointLight[] = [];
  #labels: { sprite: THREE.Sprite; inUse: boolean }[] = [];
  #labelTimer = 0;
  #lightTimer = 0;
  #mat: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.#mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.08 });
    this.#mat.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute float instanceGlow;\nvarying float vGlow;'
        )
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = instanceGlow;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vGlow;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          {
            float g = clamp(vGlow, 0.0, 1.0);
            vec3 glowCold = vec3(${GLOW_COLD.r.toFixed(4)}, ${GLOW_COLD.g.toFixed(4)}, ${GLOW_COLD.b.toFixed(4)});
            vec3 glowHot = vec3(${GLOW_HOT.r.toFixed(4)}, ${GLOW_HOT.g.toFixed(4)}, ${GLOW_HOT.b.toFixed(4)});
            totalEmissiveRadiance += mix(glowCold, glowHot, g) * g * 1.7;
          }`
        );
    };

    for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, ROOM_SIZE * 4, 1.8);
      light.visible = false;
      this.group.add(light);
      this.#lights.push(light);
    }
    for (let i = 0; i < LABEL_POOL; i++) {
      const sprite = makeTextSprite(' ', { fontSize: 34, scale: 0.85 });
      sprite.visible = false;
      this.group.add(sprite);
      this.#labels.push({ sprite, inUse: false });
    }
  }

  setRooms(rooms: RoomDatum[]): void {
    // Preserve current glow for rooms that already exist so updates lerp.
    const prevGlow = new Map<number, number>();
    for (const [roomId, idx] of this.#indexByRoomId) prevGlow.set(roomId, this.#currentGlow[idx] ?? 0);

    if (this.#mesh) {
      this.group.remove(this.#mesh);
      this.#mesh.geometry.dispose();
      this.#mesh.dispose();
      this.#mesh = null;
    }
    this.rooms = rooms;
    this.#indexByRoomId.clear();
    this.#positions = [];
    const n = rooms.length;
    this.#currentGlow = new Float32Array(n);
    this.#targetGlow = new Float32Array(n);
    if (n === 0) return;

    const geo = new THREE.BoxGeometry(ROOM_SIZE * 0.86, ROOM_HEIGHT, ROOM_SIZE * 0.86);
    this.#glowAttr = new THREE.InstancedBufferAttribute(this.#currentGlow, 1);
    this.#glowAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('instanceGlow', this.#glowAttr);

    const mesh = new THREE.InstancedMesh(geo, this.#mat, n);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    rooms.forEach((room, i) => {
      const { x, z } = roomPosition(room.roomId);
      this.#positions.push({ x, z });
      this.#indexByRoomId.set(room.roomId, i);
      m.makeTranslation(x, ROOM_HEIGHT / 2 + 0.6, z);
      mesh.setMatrixAt(i, m);
      teamColor(room.teamId, c);
      if (room.isPrivate) c.multiplyScalar(0.45);
      mesh.setColorAt(i, c);
      this.#targetGlow[i] = room.glow;
      this.#currentGlow[i] = prevGlow.get(room.roomId) ?? room.glow;
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.#mesh = mesh;
    this.group.add(mesh);
  }

  /** Update glow target without rebuilding geometry (activity ticks). */
  setGlow(roomId: number, glow: number): void {
    const idx = this.#indexByRoomId.get(roomId);
    if (idx === undefined) return;
    this.#targetGlow[idx] = glow;
    const room = this.rooms[idx];
    if (room) room.glow = glow;
  }

  roomAt(index: number): RoomDatum | undefined {
    return this.rooms[index];
  }

  positionOf(roomId: number): { x: number; z: number } | undefined {
    const idx = this.#indexByRoomId.get(roomId);
    return idx === undefined ? undefined : this.#positions[idx];
  }

  get mesh(): THREE.InstancedMesh | null {
    return this.#mesh;
  }

  update(dt: number, camFocus: THREE.Vector3): void {
    if (!this.#mesh || !this.#glowAttr) return;
    // Smooth glow lerp
    const k = REDUCED_MOTION ? 1 : Math.min(1, dt * GLOW_LERP_RATE);
    let dirty = false;
    for (let i = 0; i < this.#currentGlow.length; i++) {
      const cur = this.#currentGlow[i];
      const tgt = this.#targetGlow[i];
      if (Math.abs(cur - tgt) > 0.001) {
        this.#currentGlow[i] = cur + (tgt - cur) * k;
        dirty = true;
      }
    }
    if (dirty) this.#glowAttr.needsUpdate = true;

    this.#lightTimer -= dt;
    if (this.#lightTimer <= 0) {
      this.#lightTimer = 0.25;
      this.#assignLights();
    }
    this.#labelTimer -= dt;
    if (this.#labelTimer <= 0) {
      this.#labelTimer = 0.5;
      this.#assignLabels(camFocus);
    }
  }

  #assignLights(): void {
    const hot: { i: number; glow: number }[] = [];
    for (let i = 0; i < this.#currentGlow.length; i++) {
      if (this.#targetGlow[i] > 0.3) hot.push({ i, glow: this.#targetGlow[i] });
    }
    hot.sort((a, b) => b.glow - a.glow);
    const c = new THREE.Color();
    for (let l = 0; l < this.#lights.length; l++) {
      const light = this.#lights[l];
      const entry = hot[l];
      if (!entry) {
        light.visible = false;
        light.intensity = 0;
        continue;
      }
      const p = this.#positions[entry.i];
      light.position.set(p.x, ROOM_HEIGHT + 3, p.z);
      light.color.copy(glowColor(entry.glow, c));
      light.intensity = 20 + entry.glow * 60;
      light.visible = true;
    }
  }

  #assignLabels(camFocus: THREE.Vector3): void {
    // nearest rooms to the camera focus get signage
    const scored: { i: number; d: number }[] = [];
    for (let i = 0; i < this.#positions.length; i++) {
      const p = this.#positions[i];
      const dx = p.x - camFocus.x;
      const dz = p.z - camFocus.z;
      const d = dx * dx + dz * dz;
      if (d < 150 * 150) scored.push({ i, d });
    }
    scored.sort((a, b) => a.d - b.d);
    const take = Math.min(scored.length, this.#labels.length);
    for (let l = 0; l < this.#labels.length; l++) {
      const entry = this.#labels[l];
      if (l >= take) {
        entry.sprite.visible = false;
        continue;
      }
      const { i } = scored[l];
      const room = this.rooms[i];
      const p = this.#positions[i];
      retext(entry.sprite, room.isPrivate ? `🔒 ${room.name}` : room.name);
      entry.sprite.position.set(p.x, ROOM_HEIGHT + 1.8, p.z);
      entry.sprite.visible = true;
    }
  }
}
