import React, { useState } from 'react';
import { stdb } from '../stdb';

const EMOTES = ['👋', '🎉', '☕', '💡'];

/** Touch-friendly emote picker (mirrors hotkeys 1–4, 0 to clear). */
export function EmotePopup() {
  const [open, setOpen] = useState(false);
  return (
    <div className="emote-wrap">
      {open && (
        <div className="emote-popup">
          {EMOTES.map(e => (
            <button
              key={e}
              className="emote-btn"
              onClick={() => {
                stdb.setEmote(e);
                setOpen(false);
              }}
            >
              {e}
            </button>
          ))}
          <button
            className="emote-btn emote-clear"
            title="Clear emote"
            onClick={() => {
              stdb.setEmote(undefined);
              setOpen(false);
            }}
          >
            ✕
          </button>
        </div>
      )}
      <button className="emote-fab" onClick={() => setOpen(v => !v)} title="Emotes (keys 1–4, 0 clears)">
        😊
      </button>
    </div>
  );
}
