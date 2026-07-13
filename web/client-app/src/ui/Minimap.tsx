import React, { useEffect, useRef } from 'react';
import { zonePosition } from '@shared/layout';
import { stdb } from '../stdb';
import { teamColor, GLOW_HOT } from '../world/palette';
import type { WorldApp } from '../world';
import * as THREE from 'three';

const SIZE = 176;
/** world units mapped to the map's half-width */
const WORLD_HALF = 380;

function toMap(wx: number, wz: number): { x: number; y: number } {
  return {
    x: SIZE / 2 + (wx / WORLD_HALF) * (SIZE / 2),
    y: SIZE / 2 + (wz / WORLD_HALF) * (SIZE / 2),
  };
}

function toWorld(mx: number, my: number): { x: number; z: number } {
  return {
    x: ((mx - SIZE / 2) / (SIZE / 2)) * WORLD_HALF,
    z: ((my - SIZE / 2) / (SIZE / 2)) * WORLD_HALF,
  };
}

/**
 * Minimap (P2.4): zone dots colored by team hash, heat-tinted by aggregate
 * room glow, player marker, click-to-fast-travel. Hidden in kiosk mode.
 */
export function Minimap({ world }: { world: WorldApp }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const tmp = new THREE.Color();

    const draw = () => {
      ctx.clearRect(0, 0, SIZE, SIZE);
      // backdrop
      ctx.fillStyle = 'rgba(10, 14, 26, 0.85)';
      ctx.beginPath();
      ctx.roundRect(0, 0, SIZE, SIZE, 12);
      ctx.fill();

      // plaza
      const plaza = toMap(0, 0);
      ctx.strokeStyle = 'rgba(77, 163, 255, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(plaza.x, plaza.y, 4, 0, Math.PI * 2);
      ctx.stroke();

      // per-zone aggregate glow
      const zoneGlow = new Map<number, number>();
      for (const room of stdb.rooms.values()) {
        const zid = Math.floor(room.roomId / 100);
        zoneGlow.set(zid, Math.min(1, (zoneGlow.get(zid) ?? 0) + room.glow));
      }

      for (const zone of stdb.zones.values()) {
        const p = zonePosition(zone.zoneId);
        const m = toMap(p.x, p.z);
        const heat = zoneGlow.get(zone.zoneId) ?? 0;
        teamColor(zone.teamId, tmp);
        if (heat > 0.02) tmp.lerp(GLOW_HOT, Math.min(0.75, heat)); // heat tint
        ctx.fillStyle = `#${tmp.getHexString()}`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, 4.5 + heat * 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (heat > 0.02) {
          ctx.strokeStyle = 'rgba(255, 157, 46, 0.8)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // player marker
      const pos = world.getPlayerPosition();
      const pm = toMap(pos.x, pos.z);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pm.x, pm.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    draw();
    const t = setInterval(draw, 400);
    return () => clearInterval(t);
  }, [world]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const w = toWorld(e.clientX - rect.left, e.clientY - rect.top);
    // fast travel to the nearest zone within a generous radius
    let best: number | null = null;
    let bestD = 60;
    for (const zid of stdb.zones.keys()) {
      const p = zonePosition(zid);
      const d = Math.hypot(p.x - w.x, p.z - w.z);
      if (d < bestD) {
        bestD = d;
        best = zid;
      }
    }
    if (best !== null) world.fastTravelToZone(best);
    else if (Math.hypot(w.x, w.z) < 60) world.fastTravelToZone(0); // plaza
  };

  return (
    <canvas
      ref={canvasRef}
      className="minimap"
      width={SIZE}
      height={SIZE}
      title="Click a zone to fast travel"
      onClick={onClick}
    />
  );
}
