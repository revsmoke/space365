import * as THREE from 'three';
import { ZONE_SIZE, zonePosition } from '@shared/layout';
import { makeTextSprite, disposeSprite } from './labels';

export interface LibraryDatum {
  zoneId: number;
  teamId: string;
  fileCount: number;
  recentCount7D: number;
}

/** Offset from the zone center: north-east corner, clear of the 6×4 room grid. */
export const LIBRARY_OFFSET = { x: ZONE_SIZE * 0.38, z: -ZONE_SIZE * 0.38 };

/** Map recent_count_7_d to the book-slot emissive intensity: 0 → dim, 5+ → bright. */
export function bookSlotIntensity(recentCount7D: number): number {
  return 0.15 + Math.min(recentCount7D / 5, 1) * 1.65;
}

/**
 * Library buildings (Groups batch): one small composite per zone whose team
 * has a zone_library row with file_count > 0 — box base + slanted roof + a
 * glowing "book" slot whose emissive intensity tracks this week's activity.
 * Zone count is small, so plain per-zone meshes (no instancing).
 */
export class LibraryLayer {
  readonly group = new THREE.Group();
  #buildings: THREE.Group[] = [];
  #pickMeshes: THREE.Mesh[] = [];
  #labels: THREE.Sprite[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  get pickMeshes(): THREE.Mesh[] {
    return this.#pickMeshes;
  }

  /** Resolve a raycast hit to the library's team id. */
  teamIdForHit(object: THREE.Object3D): string | undefined {
    const teamId = object.userData.libraryTeamId;
    return typeof teamId === 'string' ? teamId : undefined;
  }

  setLibraries(libs: LibraryDatum[]): void {
    this.#clear();
    for (const lib of libs) {
      const zc = zonePosition(lib.zoneId);
      const g = new THREE.Group();
      g.position.set(zc.x + LIBRARY_OFFSET.x, 0, zc.z + LIBRARY_OFFSET.z);

      const base = new THREE.Mesh(
        new THREE.BoxGeometry(5, 3.6, 4),
        new THREE.MeshStandardMaterial({ color: 0x3a3150, roughness: 0.8 })
      );
      base.position.y = 1.8;
      g.add(base);

      // slanted (single-pitch) roof, high edge facing the zone center
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(5.8, 0.35, 4.8),
        new THREE.MeshStandardMaterial({ color: 0x241f36, roughness: 0.6, metalness: 0.2 })
      );
      roof.position.y = 4.15;
      roof.rotation.z = -0.22;
      g.add(roof);

      // glowing "book" slot on the plaza-facing front
      const slot = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 2, 0.3),
        new THREE.MeshStandardMaterial({
          color: 0xffd166,
          emissive: 0xffd166,
          emissiveIntensity: bookSlotIntensity(lib.recentCount7D),
          roughness: 0.4,
        })
      );
      slot.position.set(0, 1.7, 2.05);
      g.add(slot);

      const label = makeTextSprite('Library', { fontSize: 30, scale: 0.85 });
      label.position.y = 6.4;
      g.add(label);
      this.#labels.push(label);

      for (const mesh of [base, roof, slot]) {
        mesh.userData.libraryTeamId = lib.teamId;
        this.#pickMeshes.push(mesh);
      }
      this.group.add(g);
      this.#buildings.push(g);
    }
  }

  #clear(): void {
    for (const g of this.#buildings) {
      this.group.remove(g);
      g.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    }
    for (const l of this.#labels) disposeSprite(l);
    this.#buildings = [];
    this.#pickMeshes = [];
    this.#labels = [];
  }
}
