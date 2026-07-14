import React from 'react';
import { createRoot } from 'react-dom/client';
import { stdb } from './stdb';
import { WorldApp, exposePerf } from './world';
import { App } from './ui/App';
import './styles.css';

// MSAL popup landing guard: if this window is an auth popup carrying an
// authorization response in the hash, do NOT boot the app — the opener's
// MSAL instance reads this window's hash and closes it. Booting here would
// let the hash router destroy the auth code (redirects normally land on
// /auth-redirect.html; this guard covers stale root redirect URIs).
const hasAuthResponse = (part: string) => /[#?&](code|error|state)=/.test(part);
const isAuthPopup =
  !!window.opener &&
  window.opener !== window &&
  // check hash AND search independently — a popup can carry a non-auth hash
  // alongside a ?code= query (review: PR4)
  (hasAuthResponse(window.location.hash) || hasAuthResponse(window.location.search));

if (isAuthPopup) {
  document.body.innerHTML =
    '<p style="margin:40vh auto;text-align:center;color:#93a4c8;' +
    "font:14px system-ui,sans-serif\">Completing sign-in… this window will close itself.</p>";
} else {
  const canvas = document.getElementById('world-canvas') as HTMLCanvasElement;
  const world = new WorldApp(canvas);
  exposePerf(world);
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__space365Stdb = stdb;
    (window as unknown as Record<string, unknown>).__space365World = world;
  }

  stdb.start();
  world.start();

  createRoot(document.getElementById('ui-root')!).render(
    <React.StrictMode>
      <App world={world} />
    </React.StrictMode>
  );
}
