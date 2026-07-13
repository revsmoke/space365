import * as THREE from 'three';
import type { BookingsAppointment } from '../stdb';
import { microsToDate } from '../stdb';
import { makeTextSprite } from './labels';
import { REDUCED_MOTION } from '../config';

/** Front Desk position: plaza south edge. */
export const DESK_POS = { x: 0, z: 30 };
const TICKER_W = 512;
const TICKER_H = 48;

/**
 * Front Desk (P4.3): a small reception desk reading bookings_appointment.
 * A canvas-texture ticker scrolls upcoming appointments (serviceName + time),
 * or an idle 'No appointments today' message when the table is empty.
 */
export class FrontDesk {
  readonly group = new THREE.Group();
  #canvas = document.createElement('canvas');
  #texture: THREE.CanvasTexture;
  #text = 'No appointments today';
  #offset = 0;
  #textWidth = 0;

  constructor(scene: THREE.Scene) {
    this.group.position.set(DESK_POS.x, 0, DESK_POS.z);

    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3b52, roughness: 0.8 });
    const topMat = new THREE.MeshStandardMaterial({ color: 0x6b5a78, roughness: 0.5 });
    // counter: three segments in a shallow U facing the plaza (north)
    const front = new THREE.Mesh(new THREE.BoxGeometry(8, 2.4, 1.4), woodMat);
    front.position.set(0, 1.2, 0);
    this.group.add(front);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.4, 4), woodMat);
      wing.position.set(side * 4.7, 1.2, 1.7);
      this.group.add(wing);
    }
    const counterTop = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.3, 1.8), topMat);
    counterTop.position.set(0, 2.55, 0);
    this.group.add(counterTop);

    const label = makeTextSprite('Front Desk', { fontSize: 38, scale: 1.1 });
    label.position.set(0, 6.8, 0);
    this.group.add(label);

    // ticker board above the desk
    this.#canvas.width = TICKER_W;
    this.#canvas.height = TICKER_H;
    this.#texture = new THREE.CanvasTexture(this.#canvas);
    this.#texture.colorSpace = THREE.SRGBColorSpace;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 0.9),
      new THREE.MeshBasicMaterial({ map: this.#texture, transparent: true })
    );
    board.position.set(0, 4.6, -0.2);
    this.group.add(board);
    const boardBack = new THREE.Mesh(
      new THREE.BoxGeometry(9.4, 1.2, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x10162a, roughness: 0.7 })
    );
    boardBack.position.set(0, 4.6, -0.35);
    this.group.add(boardBack);

    this.#drawTicker();
    scene.add(this.group);
  }

  setAppointments(rows: BookingsAppointment[]): void {
    const upcoming = rows
      .filter(r => r.status !== 'cancelled')
      .sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1))
      .slice(0, 12);
    this.#text =
      upcoming.length === 0
        ? 'No appointments today'
        : upcoming
            .map(r => {
              const d = microsToDate(r.startsAt);
              return `${r.serviceName} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
            })
            .join('   ✦   ');
    this.#offset = 0;
    this.#drawTicker();
  }

  #drawTicker(): void {
    const ctx = this.#canvas.getContext('2d')!;
    ctx.clearRect(0, 0, TICKER_W, TICKER_H);
    ctx.fillStyle = 'rgba(10, 14, 26, 0.9)';
    ctx.fillRect(0, 0, TICKER_W, TICKER_H);
    ctx.font = "600 26px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = '#58c9ff';
    ctx.textBaseline = 'middle';
    this.#textWidth = ctx.measureText(this.#text).width;
    if (this.#textWidth <= TICKER_W - 20 || REDUCED_MOTION) {
      ctx.textAlign = 'center';
      ctx.fillText(this.#text, TICKER_W / 2, TICKER_H / 2);
    } else {
      ctx.textAlign = 'left';
      const x = TICKER_W - (this.#offset % (this.#textWidth + TICKER_W));
      ctx.fillText(this.#text, x, TICKER_H / 2);
    }
    this.#texture.needsUpdate = true;
  }

  update(dt: number): void {
    if (REDUCED_MOTION) return;
    if (this.#textWidth > TICKER_W - 20) {
      this.#offset += dt * 60;
      this.#drawTicker();
    }
  }
}
