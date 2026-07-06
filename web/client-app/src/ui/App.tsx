import React, { useEffect, useState } from 'react';
import type { WorldApp } from '../world';
import { KIOSK } from '../config';
import { TopBar } from './TopBar';
import { ActivityFeed } from './ActivityFeed';
import { RoomPanel } from './RoomPanel';
import { PrivacyModal } from './PrivacyModal';
import { QuestPanel } from './QuestPanel';

export function App({ world }: { world: WorldApp }) {
  const [selectedRoom, setSelectedRoom] = useState<number | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [questsOpen, setQuestsOpen] = useState(false);

  useEffect(() => {
    world.onRoomSelected = (roomId, _via) => setSelectedRoom(roomId);
    return () => {
      world.onRoomSelected = null;
    };
  }, [world]);

  return (
    <>
      <TopBar world={world} onOpenPrivacy={() => setPrivacyOpen(true)} />
      <ActivityFeed world={world} />
      {selectedRoom !== null && <RoomPanel roomId={selectedRoom} onClose={() => setSelectedRoom(null)} />}
      {!KIOSK && (
        <button className="quest-fab" onClick={() => setQuestsOpen(v => !v)} title="Quest board">
          🗒️ Quests
        </button>
      )}
      {!KIOSK && questsOpen && <QuestPanel onClose={() => setQuestsOpen(false)} />}
      {privacyOpen && <PrivacyModal onClose={() => setPrivacyOpen(false)} />}
      {!KIOSK && (
        <div className="hint dim">WASD move · drag to orbit · wheel zoom · 1–4 emote, 0 clear</div>
      )}
    </>
  );
}
