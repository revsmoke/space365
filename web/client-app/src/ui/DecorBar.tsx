import React, { useState } from 'react';
import { stdb, type Decoration } from '../stdb';
import { useStore } from './hooks';
import { PROP_KINDS, PROP_META, type PropKind } from '../world/decor';
import type { WorldApp } from '../world';

/**
 * Decorate mode (P5.2): pick a prop, click the ground to place it in your
 * current zone; click one of your own props to remove it. Budget and identity
 * linking are enforced server-side — errors surface inline.
 */
export function DecorBar({
  world,
  active,
  onToggle,
}: {
  world: WorldApp;
  active: boolean;
  onToggle: (on: boolean) => void;
}) {
  useStore('decorations');
  useStore('players');
  const [kind, setKind] = useState<PropKind>('plant');
  const [error, setError] = useState<string | null>(null);

  // wire world callbacks each render (cheap; stable closures over latest state)
  world.onGroundClick = async (x, z, zoneId) => {
    if (!active) return;
    setError(null);
    const err = await stdb.placeDecoration(zoneId, kind, x, 0, z, Math.random() * Math.PI * 2);
    if (err) setError(err);
  };
  world.onDecorationClick = async (d: Decoration) => {
    if (!active) return;
    setError(null);
    // Ownership is enforced server-side (identity link), and the local player
    // row may predate the link — so just attempt it and surface any rejection.
    const err = await stdb.removeDecoration(d.id);
    if (err) setError(/owner|not your/i.test(err) ? 'Not your prop — only your own decorations can be removed.' : err);
  };

  const mine = stdb.myUserId
    ? [...stdb.decorations.values()].filter(d => d.ownerUserId === stdb.myUserId).length
    : 0;

  return (
    <>
      <button
        className={`decor-fab ${active ? 'decor-fab-on' : ''}`}
        onClick={() => {
          onToggle(!active);
          setError(null);
        }}
        title="Decorate mode"
      >
        🎨 Decorate
      </button>
      {active && (
        <div className="panel decor-bar">
          <div className="decor-kinds">
            {PROP_KINDS.map(k => (
              <button
                key={k}
                className={`decor-kind ${kind === k ? 'decor-kind-on' : ''}`}
                title={PROP_META[k].label}
                onClick={() => setKind(k)}
              >
                <span className="decor-icon">{PROP_META[k].icon}</span>
                <span className="decor-label">{PROP_META[k].label}</span>
              </button>
            ))}
          </div>
          <div className="dim decor-hint">
            Click the ground to place · click your own prop to remove · {mine}/20 placed
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
      )}
    </>
  );
}
