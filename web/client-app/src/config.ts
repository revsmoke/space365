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

/** Anonymous (dev_mode) SpacetimeDB token. Signed-in connections use a fresh
 *  Entra ID token instead and never persist it here — the two identities are
 *  intentionally distinct. */
export const ANON_TOKEN_STORAGE_KEY = 'space365.stdb.token.anon';
/** pre-auth key; migrated to ANON_TOKEN_STORAGE_KEY on startup */
export const LEGACY_TOKEN_STORAGE_KEY = 'space365.stdb.token';

// Microsoft Entra (see docs/AUTH_PLAN.md)
export const ENTRA_CLIENT_ID: string =
  (import.meta.env.VITE_ENTRA_CLIENT_ID as string | undefined) ??
  'c0c22d69-599d-4e47-8e42-502033f70996';
export const ENTRA_TENANT_ID: string =
  (import.meta.env.VITE_ENTRA_TENANT_ID as string | undefined) ??
  'ddd9f933-04a5-43f0-8673-5933da46cdcb';
