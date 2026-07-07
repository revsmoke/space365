import React, { useEffect, useState } from 'react';
import type { WorldApp } from '../world';
import { KIOSK } from '../config';
import type { MeetingPortal } from '../stdb';
import { TopBar } from './TopBar';
import { ActivityFeed } from './ActivityFeed';
import { RoomPanel } from './RoomPanel';
import { PrivacyModal } from './PrivacyModal';
import { LegendModal } from './LegendModal';
import { QuestPanel } from './QuestPanel';
import { AdminConsole } from './AdminConsole';
import { Minimap } from './Minimap';
import { PortalCard } from './PortalCard';
import { TowerPanel } from './TowerPanel';
import { DecorBar } from './DecorBar';
import { Onboarding, shouldOnboard } from './Onboarding';
import { EmotePopup } from './EmotePopup';
import { ChatPanel, type ChatTarget } from './ChatPanel';
import { ZoneBoard } from './ZoneBoard';
import { LibraryPanel } from './LibraryPanel';

/** Minimal hash routing: '#/admin' → admin console, anything else → world UI. */
function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App({ world }: { world: WorldApp }) {
  const [selectedRoom, setSelectedRoom] = useState<number | null>(null);
  const [selectedPortal, setSelectedPortal] = useState<MeetingPortal | null>(null);
  const [selectedZone, setSelectedZone] = useState<number | null>(null);
  const [selectedLibrary, setSelectedLibrary] = useState<string | null>(null);
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null);
  const [towerOpen, setTowerOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [questsOpen, setQuestsOpen] = useState(false);
  const [decorMode, setDecorMode] = useState(false);
  const [onboarding, setOnboarding] = useState(() => !KIOSK && shouldOnboard());
  const route = useHashRoute();

  useEffect(() => {
    world.onRoomSelected = (roomId, via) => {
      setSelectedRoom(roomId);
      if (via === 'click') setSelectedZone(null); // room click beats zone board
    };
    world.onPortalSelected = portal => {
      setSelectedPortal(portal);
      setSelectedRoom(null);
      setSelectedZone(null);
    };
    world.onTowerSelected = () => setTowerOpen(true);
    world.onZoneSelected = zoneId => {
      setSelectedZone(zoneId);
      setSelectedRoom(null);
      setSelectedPortal(null);
    };
    // kiosk: library clicks are inert, like person clicks
    world.onLibrarySelected = KIOSK
      ? null
      : teamId => {
          setSelectedLibrary(teamId);
          setSelectedRoom(null);
          setSelectedPortal(null);
        };
    // kiosk: no chat anywhere — person clicks are simply inert
    world.onPersonSelected = KIOSK ? null : person => setChatTarget(person);
    return () => {
      world.onRoomSelected = null;
      world.onPortalSelected = null;
      world.onTowerSelected = null;
      world.onZoneSelected = null;
      world.onLibrarySelected = null;
      world.onPersonSelected = null;
    };
  }, [world]);

  useEffect(() => {
    world.setDecorMode(decorMode);
  }, [world, decorMode]);

  if (route.startsWith('#/admin') && !KIOSK) {
    return <AdminConsole />;
  }

  return (
    <>
      <TopBar
        world={world}
        onOpenPrivacy={() => setPrivacyOpen(true)}
        onOpenLegend={() => setLegendOpen(true)}
        onChatUser={KIOSK ? undefined : person => setChatTarget(person)}
      />
      <ActivityFeed world={world} />
      {selectedRoom !== null && <RoomPanel roomId={selectedRoom} onClose={() => setSelectedRoom(null)} />}
      {selectedPortal !== null && (
        <PortalCard portal={selectedPortal} onClose={() => setSelectedPortal(null)} />
      )}
      {selectedZone !== null && selectedRoom === null && selectedPortal === null && (
        <ZoneBoard
          zoneId={selectedZone}
          onClose={() => setSelectedZone(null)}
          onOpenLibrary={
            KIOSK
              ? undefined
              : teamId => {
                  setSelectedLibrary(teamId);
                  setSelectedZone(null);
                }
          }
        />
      )}
      {!KIOSK && selectedLibrary !== null && (
        <LibraryPanel teamId={selectedLibrary} onClose={() => setSelectedLibrary(null)} />
      )}
      {!KIOSK && chatTarget !== null && (
        <ChatPanel target={chatTarget} onClose={() => setChatTarget(null)} />
      )}
      {towerOpen && <TowerPanel onClose={() => setTowerOpen(false)} />}
      {!KIOSK && (
        <button className="quest-fab" onClick={() => setQuestsOpen(v => !v)} title="Quest board">
          🗒️ Quests
        </button>
      )}
      {!KIOSK && questsOpen && <QuestPanel onClose={() => setQuestsOpen(false)} />}
      {!KIOSK && <DecorBar world={world} active={decorMode} onToggle={setDecorMode} />}
      {!KIOSK && <EmotePopup />}
      {!KIOSK && <Minimap world={world} />}
      {privacyOpen && <PrivacyModal onClose={() => setPrivacyOpen(false)} />}
      {legendOpen && <LegendModal onClose={() => setLegendOpen(false)} />}
      {!KIOSK && !onboarding && (
        <div className="hint dim">WASD move · drag to orbit · wheel zoom · 1–4 emote, 0 clear</div>
      )}
      {onboarding && <Onboarding onDone={() => setOnboarding(false)} />}
    </>
  );
}
