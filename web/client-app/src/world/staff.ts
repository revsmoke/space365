import * as THREE from 'three';
import { hashId, zonePosition, ZONE_SIZE } from '@shared/layout';
import { makeTextSprite, disposeSprite } from './labels';
import type { StaffPresence } from '../stdb';

/**
 * Ambient staff layer: NPC avatars for every org member with live presence,
 * standing at a deterministic spot around their team zone's perimeter with an
 * availability ring. One InstancedMesh for bodies, one for rings — the whole
 * org costs 2 draw calls (plus a handful of nearby name plates).
 */

const MAX_STAFF = 1024;
const LABELS_NEAR = 12; // name plates for the N nearest staff only

const AVAILABILITY_COLOR: Record<string, number> = {
  Available: 0x2dd4bf, // teal
  AvailableIdle: 0x2dd4bf,
  Busy: 0xf97316, // orange
  BusyIdle: 0xf97316,
  DoNotDisturb: 0xef4444,
  InAMeeting: 0xa78bfa, // violet
  InACall: 0xa78bfa,
  InAConferenceCall: 0xa78bfa,
  Presenting: 0xef4444,
  Away: 0x9ca3af, // neutral gray
  BeRightBack: 0x9ca3af,
  OffWork: 0x6b7280,
};

interface StaffEntry {
  userId: string;
  name: string;
  pos: THREE.Vector3;
}

/** Deterministic spot on the zone perimeter from the user id hash. */
function staffPosition(userId: string, zoneId: number): THREE.Vector3 {
  const h = hashId(userId);
  const zc = zonePosition(zoneId);
  const angle = ((h % 3600) / 3600) * Math.PI * 2;
  const radius = ZONE_SIZE * 0.42 + ((h >>> 12) % 100) / 100 * ZONE_SIZE * 0.14;
  return new THREE.Vector3(zc.x + Math.cos(angle) * radius, 0, zc.z + Math.sin(angle) * radius);
}

export class StaffLayer {
  readonly group = new THREE.Group();
  #bodies: THREE.InstancedMesh;
  #rings: THREE.InstancedMesh;
  #entries: StaffEntry[] = [];
  #labels = new Map<string, THREE.Sprite>();
  #tmpMat = new THREE.Matrix4();
  #tmpColor = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const bodyGeo = new THREE.CapsuleGeometry(0.4, 0.8, 3, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.75 });
    this.#bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, MAX_STAFF);
    this.#bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#bodies.count = 0;

    const ringGeo = new THREE.TorusGeometry(0.65, 0.08, 6, 20);
    const ringMat = new THREE.MeshBasicMaterial();
    this.#rings = new THREE.InstancedMesh(ringGeo, ringMat, MAX_STAFF);
    this.#rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#rings.count = 0;

    this.group.add(this.#bodies, this.#rings);
    scene.add(this.group);
  }

  /** Pickable instanced body mesh (instanceId → entryAt). */
  get pickMesh(): THREE.InstancedMesh {
    return this.#bodies;
  }

  /** Staff entry for a picked body instance (person picking → chat). */
  entryAt(index: number): StaffEntry | undefined {
    return this.#entries[index];
  }

  /** Rebuild instances from the staff_presence view (cheap at org scale). */
  sync(staff: Map<string, StaffPresence>): void {
    this.#entries = [];
    let i = 0;
    for (const s of staff.values()) {
      if (i >= MAX_STAFF) break;
      if (s.isActivePlayer) continue; // their real avatar is in the world
      const pos = staffPosition(s.userId, s.zoneId);
      this.#tmpMat.makeRotationY((hashId(s.userId) % 628) / 100);
      this.#tmpMat.setPosition(pos.x, 0.85, pos.z);
      this.#bodies.setMatrixAt(i, this.#tmpMat);
      // Muted body tint from the user hash, ring from availability.
      this.#tmpColor.setHSL(((hashId(s.userId) >>> 4) % 360) / 360, 0.25, 0.45);
      this.#bodies.setColorAt(i, this.#tmpColor);
      this.#tmpMat.makeRotationX(Math.PI / 2);
      this.#tmpMat.setPosition(pos.x, 0.06, pos.z);
      this.#rings.setMatrixAt(i, this.#tmpMat);
      this.#tmpColor.setHex(AVAILABILITY_COLOR[s.availability] ?? 0x9ca3af);
      this.#rings.setColorAt(i, this.#tmpColor);
      this.#entries.push({ userId: s.userId, name: s.displayName, pos });
      i++;
    }
    this.#bodies.count = i;
    this.#rings.count = i;
    this.#bodies.instanceMatrix.needsUpdate = true;
    this.#rings.instanceMatrix.needsUpdate = true;
    if (this.#bodies.instanceColor) this.#bodies.instanceColor.needsUpdate = true;
    if (this.#rings.instanceColor) this.#rings.instanceColor.needsUpdate = true;
  }

  /** Show name plates for the nearest few staff only. */
  updateLabels(cameraPos: THREE.Vector3): void {
    const nearest = [...this.#entries]
      .map((e) => ({ e, d: e.pos.distanceToSquared(cameraPos) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, LABELS_NEAR)
      .filter(({ d }) => d < 60 * 60);
    const keep = new Set(nearest.map(({ e }) => e.userId));
    for (const [id, sprite] of this.#labels) {
      if (!keep.has(id)) {
        this.group.remove(sprite);
        disposeSprite(sprite);
        this.#labels.delete(id);
      }
    }
    for (const { e } of nearest) {
      if (!this.#labels.has(e.userId)) {
        const sprite = makeTextSprite(e.name, { fontSize: 26, scale: 0.5 });
        sprite.position.set(e.pos.x, 2.4, e.pos.z);
        this.group.add(sprite);
        this.#labels.set(e.userId, sprite);
      }
    }
  }
}
