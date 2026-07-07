import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Decoration } from '../stdb';

export const PROP_KINDS = ['plant', 'desk_lamp', 'coffee', 'rubber_duck', 'trophy', 'whiteboard'] as const;
export type PropKind = (typeof PROP_KINDS)[number];

export const PROP_META: Record<PropKind, { label: string; icon: string }> = {
  plant: { label: 'Plant', icon: '🪴' },
  desk_lamp: { label: 'Desk lamp', icon: '💡' },
  coffee: { label: 'Coffee', icon: '☕' },
  rubber_duck: { label: 'Rubber duck', icon: '🦆' },
  trophy: { label: 'Trophy', icon: '🏆' },
  whiteboard: { label: 'Whiteboard', icon: '📋' },
};

/** Paint a whole geometry's vertices one color (for merged multi-part props). */
function tint(geo: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const count = geo.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function moved(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  if (rx) geo.rotateX(rx);
  geo.translate(x, y, z);
  return geo;
}

/** Build one merged, vertex-colored geometry per prop kind (no assets). */
function buildPropGeometry(kind: PropKind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  switch (kind) {
    case 'plant':
      parts.push(tint(moved(new THREE.CylinderGeometry(0.35, 0.28, 0.5, 10), 0, 0.25, 0), '#b0623a'));
      parts.push(tint(moved(new THREE.IcosahedronGeometry(0.55, 1), 0, 1.0, 0), '#3e8e57'));
      break;
    case 'desk_lamp':
      parts.push(tint(moved(new THREE.CylinderGeometry(0.35, 0.4, 0.15, 10), 0, 0.08, 0), '#4a5570'));
      parts.push(tint(moved(new THREE.BoxGeometry(0.1, 1.1, 0.1), 0.15, 0.65, 0), '#4a5570'));
      parts.push(tint(moved(new THREE.ConeGeometry(0.3, 0.45, 10), -0.05, 1.2, 0, Math.PI / 5), '#ffd166'));
      break;
    case 'coffee':
      parts.push(tint(moved(new THREE.CylinderGeometry(0.32, 0.26, 0.55, 12), 0, 0.28, 0), '#e8ecf4'));
      parts.push(tint(moved(new THREE.TorusGeometry(0.16, 0.05, 8, 14), 0.38, 0.3, 0), '#e8ecf4'));
      parts.push(tint(moved(new THREE.CylinderGeometry(0.27, 0.27, 0.06, 12), 0, 0.56, 0), '#6b4a3a'));
      break;
    case 'rubber_duck':
      parts.push(tint(moved(new THREE.SphereGeometry(0.42, 12, 10), 0, 0.4, 0), '#ffd166'));
      parts.push(tint(moved(new THREE.SphereGeometry(0.26, 12, 10), 0.3, 0.85, 0), '#ffd166'));
      parts.push(tint(moved(new THREE.ConeGeometry(0.12, 0.25, 8), 0.55, 0.82, 0, Math.PI / 2.2), '#ff9d2e'));
      break;
    case 'trophy':
      parts.push(tint(moved(new THREE.BoxGeometry(0.6, 0.16, 0.6), 0, 0.08, 0), '#3a4460'));
      parts.push(tint(moved(new THREE.CylinderGeometry(0.08, 0.12, 0.4, 8), 0, 0.36, 0), '#e0b34c'));
      parts.push(tint(moved(new THREE.CylinderGeometry(0.4, 0.15, 0.5, 12), 0, 0.8, 0), '#e0b34c'));
      break;
    case 'whiteboard':
      for (const side of [-1, 1]) {
        parts.push(tint(moved(new THREE.BoxGeometry(0.08, 1.4, 0.08), side * 0.7, 0.7, 0), '#4a5570'));
      }
      parts.push(tint(moved(new THREE.BoxGeometry(1.7, 1.05, 0.06), 0, 1.05, 0), '#e8ecf4'));
      parts.push(tint(moved(new THREE.BoxGeometry(1.8, 1.15, 0.04), 0, 1.05, -0.02), '#3a4460'));
      break;
  }
  const merged = mergeGeometries(
    parts.map(p => (p.index ? p.toNonIndexed() : p)),
    false
  )!;
  return merged;
}

/**
 * Decorations (P5.2): every placed prop, one InstancedMesh per kind with
 * merged vertex-colored primitive geometry.
 */
export class DecorLayer {
  readonly group = new THREE.Group();
  #meshes = new Map<PropKind, THREE.InstancedMesh>();
  #geos = new Map<PropKind, THREE.BufferGeometry>();
  #mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  /** per kind: instance index -> decoration */
  #index = new Map<PropKind, Decoration[]>();

  constructor(scene: THREE.Scene) {
    for (const kind of PROP_KINDS) this.#geos.set(kind, buildPropGeometry(kind));
    scene.add(this.group);
  }

  get pickMeshes(): THREE.InstancedMesh[] {
    return [...this.#meshes.values()];
  }

  /** Resolve a raycast hit back to the decoration row. */
  decorationForHit(mesh: THREE.Object3D, instanceId: number): Decoration | null {
    for (const [kind, m] of this.#meshes) {
      if (m === mesh) return this.#index.get(kind)?.[instanceId] ?? null;
    }
    return null;
  }

  setDecorations(rows: Decoration[]): void {
    for (const [, mesh] of this.#meshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.#meshes.clear();
    this.#index.clear();

    const byKind = new Map<PropKind, Decoration[]>();
    for (const d of rows) {
      const kind = (PROP_KINDS as readonly string[]).includes(d.propKind)
        ? (d.propKind as PropKind)
        : 'plant';
      const list = byKind.get(kind) ?? [];
      list.push(d);
      byKind.set(kind, list);
    }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(2, 2, 2); // props are authored ~1u tall; scale up
    for (const [kind, list] of byKind) {
      const mesh = new THREE.InstancedMesh(this.#geos.get(kind)!, this.#mat, list.length);
      list.forEach((d, i) => {
        q.setFromAxisAngle(up, d.rotation);
        m.compose(new THREE.Vector3(d.x, d.y + 0.6, d.z), q, one);
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      this.#meshes.set(kind, mesh);
      this.#index.set(kind, list);
    }
  }
}
