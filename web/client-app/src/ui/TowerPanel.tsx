import React, { useMemo } from 'react';
import { stdb } from '../stdb';
import { useStore } from './hooks';
import { last24hBuckets, modalityColor, MODALITY_COLOR } from '../world/tower';

/** Comms Tower detail: plain-CSS stacked bars of calls/minutes per hour by modality. */
export function TowerPanel({ onClose }: { onClose: () => void }) {
  useStore('callStats');
  const buckets = useMemo(() => last24hBuckets(stdb.callStats), [stdb.version('callStats')]);
  const maxMinutes = Math.max(1, ...buckets.map(b => b.totalMinutes));
  const modalities = Object.keys(MODALITY_COLOR);

  return (
    <div className="panel tower-panel">
      <div className="panel-header">
        <h2>📡 Comms Tower — last 24h</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="tower-legend">
        {modalities.map(m => (
          <span key={m} className="tower-legend-item">
            <span className="tower-swatch" style={{ background: modalityColor(m) }} />
            {m.replace('_', ' ')}
          </span>
        ))}
      </div>
      <div className="tower-chart">
        {buckets.map((b, i) => {
          const hour = new Date(Number(b.bucketStart / 1000n)).getHours();
          return (
            <div key={i} className="tower-col" title={`${hour}:00 — ${b.totalCalls} calls, ${Math.round(b.totalMinutes)} min`}>
              <div className="tower-col-bar">
                {[...b.byModality.entries()].map(([m, v]) => (
                  <div
                    key={m}
                    className="tower-col-seg"
                    style={{
                      height: `${(v.minutes / maxMinutes) * 100}%`,
                      background: modalityColor(m),
                    }}
                  />
                ))}
              </div>
              {i % 4 === 0 && <div className="tower-col-label">{hour}h</div>}
            </div>
          );
        })}
      </div>
      <div className="dim tower-note">
        Bar height = call minutes per hour · {stdb.callStats.length} aggregate rows · no
        participant data.
      </div>
    </div>
  );
}
