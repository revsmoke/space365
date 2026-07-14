/**
 * Microsoft Entra sign-in (MSAL PKCE popup) — see docs/AUTH_PLAN.md.
 *
 * One sign-in yields three powers:
 *  1. the Entra ID token doubles as the SpacetimeDB connection token
 *     (the module validates tid + auto-links oid server-side),
 *  2. delegated Graph access tokens per scope (client-direct calls),
 *  3. profile claims for the account chip.
 */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  type AccountInfo,
} from '@azure/msal-browser';
import { ENTRA_CLIENT_ID, ENTRA_TENANT_ID } from './config';

const pca = new PublicClientApplication({
  auth: {
    clientId: ENTRA_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}`,
    // Dedicated blank landing page: the popup must NOT load the app — the
    // app's hash router would consume the auth code before the opener's MSAL
    // poll reads it, stranding the popup (the sign-in-in-popup bug).
    redirectUri: `${window.location.origin}/auth-redirect.html`,
  },
  cache: { cacheLocation: 'localStorage' },
});

let initPromise: Promise<void> | null = null;

/** MSAL v3+ requires initialize() before any other API. Idempotent. */
export function ensureAuthReady(): Promise<void> {
  if (!initPromise) initPromise = pca.initialize();
  return initPromise;
}

/** The signed-in account, if any (null when signed out). */
export function account(): AccountInfo | null {
  // getAllAccounts is safe pre-initialize only for cache reads in v3; we still
  // guard usage sites with ensureAuthReady() before interactive calls.
  const all = pca.getAllAccounts();
  return all.length > 0 ? all[0] : null;
}

/** Interactive sign-in via popup. Returns the account on success. */
export async function signIn(): Promise<AccountInfo> {
  await ensureAuthReady();
  const result = await pca.loginPopup({ scopes: ['User.Read'] });
  pca.setActiveAccount(result.account);
  return result.account;
}

/** Sign out: clear the MSAL cache for the account (no redirect round-trip). */
export async function signOut(): Promise<void> {
  await ensureAuthReady();
  const acct = account();
  if (acct) await pca.clearCache({ account: acct });
}

function jwtExpMs(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

const EXP_SLACK_MS = 5 * 60_000;

/**
 * Fresh-enough Entra ID token for the SpacetimeDB connection.
 * MSAL happily returns a cached ID token even when it is near/at expiry, so we
 * decode `exp` ourselves and force a refresh when it is close.
 */
export async function getIdToken(forceRefresh = false): Promise<string | null> {
  await ensureAuthReady();
  const acct = account();
  if (!acct) return null;
  const request = { scopes: ['User.Read'], account: acct, forceRefresh };
  let result = await pca.acquireTokenSilent(request);
  if (!forceRefresh && jwtExpMs(result.idToken) - Date.now() < EXP_SLACK_MS) {
    result = await pca.acquireTokenSilent({ ...request, forceRefresh: true });
  }
  return result.idToken;
}

/**
 * Delegated Graph access token for the given scopes. Falls back to an
 * interactive popup when silent acquisition needs consent/interaction —
 * callers should treat a throw as "user declined / consent not granted".
 */
export async function getGraphToken(scopes: string[]): Promise<string> {
  await ensureAuthReady();
  const acct = account();
  if (!acct) throw new Error('not signed in');
  try {
    const result = await pca.acquireTokenSilent({ scopes, account: acct });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      const result = await pca.acquireTokenPopup({ scopes, account: acct });
      return result.accessToken;
    }
    throw err;
  }
}
