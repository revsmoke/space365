import * as THREE from 'three';
import type { CallStatsAgg } from '../stdb';
import { makeTextSprite } from './labels';

/** Comms Tower position: plaza-adjacent, north of the origin. */
export const TOWER_POS = { x: 0, z: -42 };
const TRUNK_HEIGHT = 52;
const RING_BASE_Y = 5;
const RING_STEP_Y = 1.9;

/** Colorblind-safe modality hues (blue family = audio, orange family = video). */
export const MODALITY_COLOR: Record<string, string> = {
  audio_peer: '#2f6bd8',
  audio_group: '#58c9ff',
  video_peer: '#ff9d2e',
  video_group: '#ffd166',
};
const OTHER_COLOR = '#8a93a8';

export function modalityColor(m: string): string {
  return MODALITY_COLOR[m] ?? OTHER_COLOR;
}

export interface HourBucket {
  /** micros since epoch of the hour start */
  bucketStart: bigint;
  totalMinutes: number;
  totalCalls: number;
  /** modality -> { minutes, calls } */
  byModality: Map<string, { minutes: number; calls: number }>;
}

/** Aggregate call_stats_agg rows into the last 24 hourly buckets (oldest first). */
export function last24hBuckets(rows: CallStatsAgg[], now = Date.now()): HourBucket[] {
  const hourMs = 3_600_000;
  const currentHour = Math.floor(now / hourMs) * hourMs;
  const buckets: HourBucket[] = [];
  const byStart = new Map<number, HourBucket>();
  for (let i = 23; i >= 0; i--) {
    const startMs = currentHour - i * hourMs;
    const b: HourBucket = {
      bucketStart: BigInt(startMs) * 1000n,
      totalMinutes: 0,
      totalCalls: 0,
      byModality: new Map(),
    };
    buckets.push(b);
    byStart.set(startMs, b);
  }
  for (const r of rows) {
    const startMs = Number(r.bucketStart / 1000n);
    const b = byStart.get(startMs);
    if (!b) continue;
    b.totalMinutes += r.totalMinutes;
    b.totalCalls += r.callCount;
    const m = b.byModality.get(r.modality) ?? { minutes: 0, calls: 0 };
    m.minutes += r.totalMinutes;
    m.calls += r.callCount;
    b.byModality.set(r.modality, m);
  }
  return buckets;
}

/**
 * Comms Tower (P4.4): a tall spire near the plaza displaying the last 24h of
 * call activity as stacked glowing rings — one per hour, radius/intensity from
 * total minutes, hue from the dominant modality.
 */
export class CommsTower {
  readonly group = new THREE.Group();
  #rings: THREE.Mesh[] = [];
  #trunk: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    this.group.position.set(TOWER_POS.x, 0, TOWER_POS.z);

    this.#trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 2.2, TRUNK_HEIGHT, 10),
      new THREE.MeshStandardMaterial({ color: 0x2a3654, roughness: 0.6, metalness: 0.4 })
    );
    this.#trunk.position.y = TRUNK_HEIGHT / 2;
    this.#trunk.userData.isCommsTower = true;
    this.group.add(this.#trunk);

    // antenna tip light
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xff9d2e, emissive: 0xff9d2e, emissiveIntensity: 1.5 })
    );
    tip.position.y = TRUNK_HEIGHT + 1;
    tip.userData.isCommsTower = true;
    this.group.add(tip);

    const label = makeTextSprite('Comms Tower', { fontSize: 40, scale: 1.4 });
    label.position.y = TRUNK_HEIGHT + 5;
    this.group.add(label);

    scene.add(this.group);
  }

  get pickMeshes(): THREE.Mesh[] {
    return [this.#trunk, ...this.#rings];
  }

  setStats(rows: CallStatsAgg[]): void {
    for (const r of this.#rings) {
      this.group.remove(r);
      r.geometry.dispose();
      (r.material as THREE.Material).dispose();
    }
    this.#rings = [];

    const buckets = last24hBuckets(rows);
    const maxMinutes = Math.max(1, ...buckets.map(b => b.totalMinutes));
    buckets.forEach((b, i) => {
      if (b.totalMinutes <= 0) return;
      const t = b.totalMinutes / maxMinutes;
      const radius = 2.2 + t * 5.5;
      // dominant modality by minutes
      let dom = '';
      let domMin = -1;
      for (const [m, v] of b.byModality) {
        if (v.minutes > domMin) {
          dom = m;
          domMin = v.minutes;
        }
      }
      const color = new THREE.Color(modalityColor(dom));
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.22 + t * 0.25, 8, 40),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.4 + t * 1.4,
          transparent: true,
          opacity: 0.85,
          roughness: 0.5,
        })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = RING_BASE_Y + i * RING_STEP_Y;
      ring.userData.isCommsTower = true;
      this.group.add(ring);
      this.#rings.push(ring);
    });
  }
}
