import React, { useState } from 'react';
import { stdb, microsToDate } from '../stdb';
import { useStore } from './hooks';

export function QuestPanel({ onClose }: { onClose: () => void }) {
  useStore('quests');
  useStore('policy');
  const [busy, setBusy] = useState(false);
  const [needsLink, setNeedsLink] = useState(false);
  const [linkUserId, setLinkUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [optIn, setOptIn] = useState(false);

  const quests = [...stdb.quests.values()].filter(q => q.status !== 'dismissed');
  const devMode = stdb.policy?.devMode ?? false;

  const toggleOptIn = async () => {
    setBusy(true);
    setError(null);
    const next = !optIn;
    const result = await stdb.setPersonalOptIn(next);
    setBusy(false);
    if (result === 'ok') {
      setOptIn(next);
      setNeedsLink(false);
    } else if (result === 'needs-link') {
      setNeedsLink(true);
    } else {
      setError(result);
    }
  };

  const linkSelf = async () => {
    setBusy(true);
    setError(null);
    const err = await stdb.debugLinkSelf(linkUserId.trim());
    setBusy(false);
    if (err) {
      setError(err);
    } else {
      setNeedsLink(false);
      setError(null);
    }
  };

  return (
    <div className="panel quest-panel">
      <div className="panel-header">
        <h2>Quest board</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <label className="optin-row">
        <input type="checkbox" checked={optIn} disabled={busy} onChange={toggleOptIn} />
        <span>Personal overlays (mentions, meetings — opt-in)</span>
      </label>
      {needsLink && (
        <div className="link-box">
          <p className="dim">Your session isn't linked to an M365 identity yet.</p>
          {devMode ? (
            <div className="link-row">
              <input
                className="search"
                placeholder="dev: link as user id…"
                value={linkUserId}
                onChange={e => setLinkUserId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && linkUserId.trim() && linkSelf()}
              />
              <button className="primary-btn" disabled={busy || !linkUserId.trim()} onClick={linkSelf}>
                Link
              </button>
            </div>
          ) : (
            <p className="dim">Sign-in linking arrives with MSAL (P4).</p>
          )}
        </div>
      )}
      {error && <div className="error-box">{error}</div>}
      <div className="feed-list">
        {quests.length === 0 && (
          <div className="dim empty">
            No quests yet. Quests appear after your account is linked and you opt in.
          </div>
        )}
        {quests.map(q => (
          <div key={q.questId} className="quest-row">
            <div>
              <div className="feed-name">{q.title}</div>
              <div className="feed-meta">
                {q.kind} · {microsToDate(q.createdAt).toLocaleString()}
              </div>
            </div>
            <div className="quest-actions">
              {q.deeplink && (
                <a className="ghost-btn" href={q.deeplink} target="_blank" rel="noreferrer noopener">
                  Open
                </a>
              )}
              <button className="ghost-btn" onClick={() => stdb.dismissQuest(q.questId)}>
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
