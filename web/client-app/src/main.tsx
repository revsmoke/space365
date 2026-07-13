import React from 'react';
import { createRoot } from 'react-dom/client';
import { stdb } from './stdb';
import { WorldApp, exposePerf } from './world';
import { App } from './ui/App';
import './styles.css';

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
