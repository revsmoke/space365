import * as THREE from 'three';
import { glowColor } from './palette';
import { REDUCED_MOTION } from '../config';

interface Burst {
  points: THREE.Points;
  velocities: Float32Array;
  age: number;
  life: number;
}

/**
 * Short-lived particle bursts spawned above a room when evt_room_burst fires.
 */
export class BurstLayer {
  readonly group = new THREE.Group();
  #bursts: Burst[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  spawn(x: number, y: number, z: number, magnitude: number): void {
    if (REDUCED_MOTION) return;
    const count = Math.min(160, Math.floor(40 + magnitude * 100));
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = x + (Math.random() - 0.5) * 2;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z + (Math.random() - 0.5) * 2;
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 6 * Math.max(0.4, magnitude);
      velocities[i * 3] = Math.cos(angle) * speed * 0.5;
      velocities[i * 3 + 1] = 4 + Math.random() * 7;
      velocities[i * 3 + 2] = Math.sin(angle) * speed * 0.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: glowColor(Math.min(1, 0.4 + magnitude)),
      size: 0.7,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    this.group.add(points);
    this.#bursts.push({ points, velocities, age: 0, life: 1.3 });
  }

  update(dt: number): void {
    for (let b = this.#bursts.length - 1; b >= 0; b--) {
      const burst = this.#bursts[b];
      burst.age += dt;
      const t = burst.age / burst.life;
      if (t >= 1) {
        this.group.remove(burst.points);
        burst.points.geometry.dispose();
        (burst.points.material as THREE.Material).dispose();
        this.#bursts.splice(b, 1);
        continue;
      }
      const attr = burst.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      const pos = attr.array as Float32Array;
      const vel = burst.velocities;
      for (let i = 0; i < vel.length; i += 3) {
        vel[i + 1] -= 9.8 * dt * 0.6; // gravity-ish
        pos[i] += vel[i] * dt;
        pos[i + 1] += vel[i + 1] * dt;
        pos[i + 2] += vel[i + 2] * dt;
      }
      attr.needsUpdate = true;
      (burst.points.material as THREE.PointsMaterial).opacity = 0.95 * (1 - t);
    }
  }
}
