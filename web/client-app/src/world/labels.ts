import * as THREE from 'three';

/**
 * Canvas-backed text sprites for zone names, room signage, name plates and
 * emote emoji. Each sprite owns its canvas/texture; call disposeSprite() when
 * removing one, or retext() to reuse a pooled sprite.
 */

export interface TextSpriteOptions {
  fontSize?: number;
  color?: string;
  background?: string;
  scale?: number;
}

interface SpriteUserData {
  text: string;
  opts: Required<TextSpriteOptions>;
}

const DEFAULTS: Required<TextSpriteOptions> = {
  fontSize: 44,
  color: '#e8ecf4',
  background: 'rgba(10, 14, 26, 0.72)',
  scale: 1,
};

function drawText(canvas: HTMLCanvasElement, text: string, opts: Required<TextSpriteOptions>): { w: number; h: number } {
  const ctx = canvas.getContext('2d')!;
  const font = `600 ${opts.fontSize}px 'Segoe UI', system-ui, sans-serif`;
  ctx.font = font;
  const padX = opts.fontSize * 0.5;
  const padY = opts.fontSize * 0.3;
  const textW = Math.max(4, ctx.measureText(text).width);
  const w = Math.ceil(textW + padX * 2);
  const h = Math.ceil(opts.fontSize + padY * 2);
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d')!;
  if (opts.background !== 'transparent') {
    c.fillStyle = opts.background;
    const r = h * 0.3;
    c.beginPath();
    c.roundRect(0, 0, w, h, r);
    c.fill();
  }
  c.font = font;
  c.fillStyle = opts.color;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, w / 2, h / 2);
  return { w, h };
}

export function makeTextSprite(text: string, options: TextSpriteOptions = {}): THREE.Sprite {
  const opts = { ...DEFAULTS, ...options };
  const canvas = document.createElement('canvas');
  const { w, h } = drawText(canvas, text, opts);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  const worldH = 2.2 * opts.scale;
  sprite.scale.set((w / h) * worldH, worldH, 1);
  (sprite.userData as SpriteUserData).text = text;
  (sprite.userData as SpriteUserData).opts = opts;
  return sprite;
}

/** Redraw an existing text sprite with new text (pooling helper). */
export function retext(sprite: THREE.Sprite, text: string): void {
  const ud = sprite.userData as SpriteUserData;
  if (ud.text === text) return;
  const opts = ud.opts ?? DEFAULTS;
  const canvas = (sprite.material.map as THREE.CanvasTexture).image as HTMLCanvasElement;
  const { w, h } = drawText(canvas, text, opts);
  (sprite.material.map as THREE.CanvasTexture).needsUpdate = true;
  const worldH = 2.2 * opts.scale;
  sprite.scale.set((w / h) * worldH, worldH, 1);
  ud.text = text;
}

export function disposeSprite(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}
