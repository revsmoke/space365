import * as THREE from 'three';
import { zonePosition } from '@shared/layout';
import type { MeetingPortal } from '../stdb';
import { REDUCED_MOTION } from '../config';

const PLAZA_RING_RADIUS = 22;
const ZONE_RING_RADIUS = 16;

interface PortalView {
  portal: MeetingPortal;
  group: THREE.Group;
  torus: THREE.Mesh;
  beam: THREE.Mesh | null;
  baseY: number;
}

const STATE_COLOR: Record<string, number> = {
  upcoming: 0x4d6db0,
  soon: 0x58c9ff,
  live: 0xff9d2e,
};

/**
 * Meeting portals (P4.1): glowing tori ringing the zone landmark (zone 0 =
 * plaza). upcoming = faint, soon = pulsing bright, live = spinning + beam.
 * No subject is rendered by design — the view carries time/place only.
 */
export class PortalLayer {
  readonly group = new THREE.Group();
  #views: PortalView[] = [];
  #torusGeo = new THREE.TorusGeometry(2.2, 0.28, 12, 36);
  #beamGeo = new THREE.CylinderGeometry(0.5, 1.4, 40, 12, 1, true);

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Meshes eligible for click-picking; userData.eventId set on each torus. */
  get pickMeshes(): THREE.Mesh[] {
    return this.#views.map(v => v.torus);
  }

  setPortals(portals: MeetingPortal[]): void {
    for (const v of this.#views) {
      this.group.remove(v.group);
      (v.torus.material as THREE.Material).dispose();
      if (v.beam) (v.beam.material as THREE.Material).dispose();
    }
    this.#views = [];

    // ring portals around their zone landmark, stacked by per-zone index
    const perZoneIndex = new Map<number, number>();
    for (const p of portals) {
      const idx = perZoneIndex.get(p.zoneId) ?? 0;
      perZoneIndex.set(p.zoneId, idx + 1);

      const zc = zonePosition(p.zoneId);
      const radius = p.zoneId === 0 ? PLAZA_RING_RADIUS : ZONE_RING_RADIUS;
      const angle = idx * (Math.PI * 2 / 8) + (p.zoneId % 7) * 0.35;
      const x = zc.x + Math.cos(angle) * radius;
      const z = zc.z + Math.sin(angle) * radius;
      const baseY = 3 + Math.floor(idx / 8) * 5; // stack full rings vertically

      const group = new THREE.Group();
      group.position.set(x, baseY, z);
      group.rotation.y = -angle + Math.PI / 2; // face outward

      const color = STATE_COLOR[p.state] ?? STATE_COLOR.upcoming;
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: p.state === 'upcoming' ? 0.25 : 1.2,
        transparent: true,
        opacity: p.state === 'upcoming' ? 0.4 : 0.95,
        roughness: 0.4,
      });
      const torus = new THREE.Mesh(this.#torusGeo, mat);
      torus.userData.eventId = p.eventId;
      group.add(torus);

      let beam: THREE.Mesh | null = null;
      if (p.state === 'live') {
        const beamMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.22,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        beam = new THREE.Mesh(this.#beamGeo, beamMat);
        beam.position.y = 20;
        group.add(beam);
      }

      this.group.add(group);
      this.#views.push({ portal: p, group, torus, beam, baseY });
    }
  }

  portalForMesh(mesh: THREE.Object3D): MeetingPortal | null {
    const v = this.#views.find(v => v.torus === mesh);
    return v ? v.portal : null;
  }

  update(dt: number, elapsed: number): void {
    if (REDUCED_MOTION) return;
    for (const v of this.#views) {
      const state = v.portal.state;
      if (state === 'soon') {
        // pulsing bright
        const pulse = 0.75 + Math.sin(elapsed * 4) * 0.25;
        (v.torus.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.2 * pulse;
        const s = 1 + Math.sin(elapsed * 4) * 0.06;
        v.torus.scale.set(s, s, s);
      } else if (state === 'live') {
        v.torus.rotation.z += dt * 1.5; // spin
        if (v.beam) {
          (v.beam.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(elapsed * 2) * 0.06;
        }
        v.group.position.y = v.baseY + Math.sin(elapsed * 1.2) * 0.4;
      }
    }
  }
}
