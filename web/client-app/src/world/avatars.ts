import * as THREE from 'three';
import { makeTextSprite, retext, disposeSprite } from './labels';
import type { PlayerState, UserRowT } from '../stdb';

const LERP_RATE = 8;

interface AvatarView {
  group: THREE.Group;
  body: THREE.Mesh;
  namePlate: THREE.Sprite;
  emoteSprite: THREE.Sprite | null;
  emote: string | null;
  target: THREE.Vector3;
  targetHeading: number;
}

function avatarColor(seed: number): THREE.Color {
  return new THREE.Color().setHSL(((seed >>> 3) % 360) / 360, 0.55, 0.55);
}

/**
 * Remote player avatars: capsule + head, lerped toward server position,
 * name plate from linked user, floating emoji sprite for emotes.
 */
export class AvatarLayer {
  readonly group = new THREE.Group();
  #views = new Map<string, AvatarView>();
  #capsuleGeo = new THREE.CapsuleGeometry(0.45, 0.9, 4, 12);
  #headGeo = new THREE.SphereGeometry(0.32, 12, 10);

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Reconcile against the full set of online remote players. */
  sync(players: Map<string, PlayerState>, users: Map<string, UserRowT>, selfIdentityHex: string | null): void {
    const seen = new Set<string>();
    for (const [hex, p] of players) {
      if (!p.online || hex === selfIdentityHex) continue;
      seen.add(hex);
      let view = this.#views.get(hex);
      if (!view) {
        view = this.#createView(p);
        this.#views.set(hex, view);
      }
      view.target.set(p.x, p.y, p.z);
      view.targetHeading = p.heading;
      const user = p.userId ? users.get(p.userId) : undefined;
      retext(view.namePlate, user?.displayName ?? 'Visitor');
      const seed = user?.avatarSeed ?? 7;
      (view.body.material as THREE.MeshStandardMaterial).color.copy(avatarColor(seed));
      this.#setEmote(view, p.emote ?? null);
    }
    for (const [hex, view] of this.#views) {
      if (!seen.has(hex)) {
        this.#disposeView(view);
        this.#views.delete(hex);
      }
    }
  }

  #createView(p: PlayerState): AvatarView {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8899ff, roughness: 0.6 });
    const body = new THREE.Mesh(this.#capsuleGeo, mat);
    body.position.y = 0.95;
    group.add(body);
    const head = new THREE.Mesh(this.#headGeo, new THREE.MeshStandardMaterial({ color: 0xf2d6b8, roughness: 0.7 }));
    head.position.y = 2.0;
    group.add(head);
    const namePlate = makeTextSprite('Visitor', { fontSize: 30, scale: 0.6 });
    namePlate.position.y = 2.7;
    group.add(namePlate);
    group.position.set(p.x, p.y, p.z);
    this.group.add(group);
    return { group, body, namePlate, emoteSprite: null, emote: null, target: new THREE.Vector3(p.x, p.y, p.z), targetHeading: p.heading };
  }

  #setEmote(view: AvatarView, emote: string | null): void {
    if (view.emote === emote) return;
    view.emote = emote;
    if (view.emoteSprite) {
      view.group.remove(view.emoteSprite);
      disposeSprite(view.emoteSprite);
      view.emoteSprite = null;
    }
    if (emote) {
      const sprite = makeTextSprite(emote, { fontSize: 64, scale: 0.8, background: 'transparent' });
      sprite.position.y = 3.5;
      view.group.add(sprite);
      view.emoteSprite = sprite;
    }
  }

  #disposeView(view: AvatarView): void {
    this.group.remove(view.group);
    disposeSprite(view.namePlate);
    if (view.emoteSprite) disposeSprite(view.emoteSprite);
    (view.body.material as THREE.Material).dispose();
  }

  update(dt: number, elapsed: number): void {
    const k = Math.min(1, dt * LERP_RATE);
    for (const view of this.#views.values()) {
      view.group.position.lerp(view.target, k);
      const yaw = view.group.rotation.y;
      let dy = view.targetHeading - yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      view.group.rotation.y = yaw + dy * k;
      if (view.emoteSprite) view.emoteSprite.position.y = 3.5 + Math.sin(elapsed * 3) * 0.15;
    }
  }
}
