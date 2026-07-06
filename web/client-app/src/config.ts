/** Runtime configuration derived from URL params + environment. */

const params = new URLSearchParams(window.location.search);

export const KIOSK = params.get('kiosk') === '1';
export const SYNTHETIC = params.get('synthetic') === '1';

export const STDB_URI: string =
  (import.meta.env.VITE_STDB_URI as string | undefined) ?? 'ws://127.0.0.1:3000';
export const STDB_DB: string =
  (import.meta.env.VITE_STDB_DB as string | undefined) ?? 'space365';

export const REDUCED_MOTION: boolean =
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export const TOKEN_STORAGE_KEY = 'space365.stdb.token';
