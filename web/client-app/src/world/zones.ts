import * as THREE from 'three';
import { ZONE_SIZE, zonePosition } from '@shared/layout';
import { makeTextSprite, disposeSprite } from './labels';
import { teamColor } from './palette';

export interface ZoneDatum {
  zoneId: number;
  teamId: string;
  name: string;
}

/**
 * Zone platforms: one InstancedMesh for all platforms (per-instance team
 * color) + a floating name label sprite per zone (max 64, cheap).
 */
export class ZoneLayer {
  readonly group = new THREE.Group();
  #mesh: THREE.InstancedMesh | null = null;
  #labels: THREE.Sprite[] = [];
  #zones: ZoneDatum[] = [];
  #geo = new THREE.BoxGeometry(ZONE_SIZE, 0.6, ZONE_SIZE);
  #mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02 });

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Pickable objects: the instanced platform mesh + the name label sprites. */
  get pickObjects(): THREE.Object3D[] {
    return this.#mesh ? [this.#mesh, ...this.#labels] : [...this.#labels];
  }

  /**
   * Resolve a raycast hit (platform instance or label sprite) to its zone.
   * Instance indices and label order both match #zones by construction.
   */
  zoneForHit(object: THREE.Object3D, instanceId: number | undefined): ZoneDatum | undefined {
    if (object === this.#mesh && instanceId !== undefined) return this.#zones[instanceId];
    const li = this.#labels.indexOf(object as THREE.Sprite);
    return li >= 0 ? this.#zones[li] : undefined;
  }

  setZones(zones: ZoneDatum[]): void {
    this.#clear();
    this.#zones = zones;
    if (zones.length === 0) return;
    const mesh = new THREE.InstancedMesh(this.#geo, this.#mat, zones.length);
    mesh.receiveShadow = false;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    zones.forEach((zone, i) => {
      const { x, z } = zonePosition(zone.zoneId);
      m.makeTranslation(x, 0.3, z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, teamColor(zone.teamId, c));

      const label = makeTextSprite(zone.name, { fontSize: 52, scale: 2.2 });
      label.position.set(x, 14, z);
      this.group.add(label);
      this.#labels.push(label);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.#mesh = mesh;
    this.group.add(mesh);
  }

  #clear(): void {
    if (this.#mesh) {
      this.group.remove(this.#mesh);
      this.#mesh.dispose();
      this.#mesh = null;
    }
    for (const l of this.#labels) {
      this.group.remove(l);
      disposeSprite(l);
    }
    this.#labels = [];
  }
}
