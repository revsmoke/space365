import * as THREE from 'three';
import { REDUCED_MOTION } from '../config';

const NIGHT_SKY = new THREE.Color('#0a0e1c');
const DAY_SKY = new THREE.Color('#7fa8d0');
const NIGHT_SUN = new THREE.Color('#5a74c4');
const DAY_SUN = new THREE.Color('#fff1dd');
const MOTE_COUNT = 600;
const MOTE_AREA = 700;

/**
 * Day/night cycle driven by world_state.day_phase (0 = midnight, 0.5 = noon)
 * plus subtle fog and mood-driven ambient particle motes.
 */
export class DayNight {
  #ambient: THREE.AmbientLight;
  #sun: THREE.DirectionalLight;
  #fog: THREE.Fog;
  #scene: THREE.Scene;
  #motes: THREE.Points | null = null;
  #motePositions: Float32Array | null = null;
  dayPhase = 0.5;
  mood = 0.5;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
    this.#ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(this.#ambient);
    this.#sun = new THREE.DirectionalLight(0xffffff, 1.2);
    this.#sun.position.set(80, 120, 40);
    scene.add(this.#sun);
    this.#fog = new THREE.Fog(NIGHT_SKY.clone(), 180, 900);
    scene.fog = this.#fog;
    scene.background = NIGHT_SKY.clone();

    if (!REDUCED_MOTION) {
      const positions = new Float32Array(MOTE_COUNT * 3);
      for (let i = 0; i < MOTE_COUNT; i++) {
        positions[i * 3] = (Math.random() - 0.5) * MOTE_AREA;
        positions[i * 3 + 1] = 2 + Math.random() * 40;
        positions[i * 3 + 2] = (Math.random() - 0.5) * MOTE_AREA;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const mat = new THREE.PointsMaterial({
        color: 0x9db8ff,
        size: 0.5,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      });
      this.#motes = new THREE.Points(geo, mat);
      this.#motePositions = positions;
      scene.add(this.#motes);
    }
  }

  set(dayPhase: number, mood: number): void {
    this.dayPhase = dayPhase;
    this.mood = mood;
  }

  update(dt: number, elapsed: number): void {
    // elevation: -1 (midnight) .. +1 (noon)
    const elevation = Math.sin((this.dayPhase - 0.25) * Math.PI * 2);
    const dayFactor = THREE.MathUtils.clamp(elevation * 0.5 + 0.5, 0, 1);

    this.#ambient.intensity = 0.22 + dayFactor * 0.5;
    this.#ambient.color.lerpColors(NIGHT_SUN, DAY_SUN, dayFactor);
    this.#sun.intensity = 0.25 + dayFactor * 1.4;
    this.#sun.color.lerpColors(NIGHT_SUN, DAY_SUN, dayFactor);
    const sunAngle = (this.dayPhase - 0.25) * Math.PI * 2;
    this.#sun.position.set(Math.cos(sunAngle) * 150, Math.max(20, Math.sin(sunAngle) * 160 + 30), 60);

    const sky = new THREE.Color().lerpColors(NIGHT_SKY, DAY_SKY, dayFactor);
    (this.#scene.background as THREE.Color).copy(sky);
    this.#fog.color.copy(sky);
    this.#fog.near = 150 + dayFactor * 100;

    if (this.#motes && this.#motePositions) {
      const visible = Math.floor(MOTE_COUNT * THREE.MathUtils.clamp(this.mood, 0, 1));
      this.#motes.geometry.setDrawRange(0, visible);
      this.#motes.visible = visible > 0;
      // slow drift
      const pos = this.#motePositions;
      for (let i = 0; i < visible; i++) {
        pos[i * 3 + 1] += Math.sin(elapsed * 0.4 + i) * dt * 0.35;
      }
      (this.#motes.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
