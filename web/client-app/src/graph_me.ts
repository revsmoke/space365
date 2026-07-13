/**
 * Delegated Graph writes for the signed-in user (parity batch):
 *  - Presence.ReadWrite: set/clear my preferred Teams presence,
 *  - Calendars.ReadWrite: create a calendar event ("open a portal").
 *
 * Both scopes are in the app manifest (no admin consent); users consent on
 * first use via the MSAL popup fallback in getGraphToken. Callers handle
 * consent-shaped failures with the usual Grant-access retry path (consentish).
 */
import { getGraphToken } from './auth';
import { myOid } from './graph_chat';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export const PRESENCE_SCOPES = ['Presence.ReadWrite'];
export const CALENDAR_SCOPES = ['Calendars.ReadWrite'];

/** The five settable states; activity mirrors availability per Graph rules. */
export type PreferredAvailability = 'Available' | 'Busy' | 'DoNotDisturb' | 'BeRightBack' | 'Away';

async function graphPost(scopes: string[], path: string, body: unknown): Promise<unknown> {
  const token = await getGraphToken(scopes);
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Graph error ${res.status}: ${text.slice(0, 160)}`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

/** Set my preferred presence for the next 4 hours. */
export async function setMyPresence(availability: PreferredAvailability): Promise<void> {
  const oid = myOid();
  if (!oid) throw new Error('not signed in');
  await graphPost(
    PRESENCE_SCOPES,
    `/users/${encodeURIComponent(oid)}/presence/setUserPreferredPresence`,
    { availability, activity: availability, expirationDuration: 'PT4H' }
  );
}

/** Clear my preferred presence (back to app-derived state). */
export async function clearMyPresence(): Promise<void> {
  const oid = myOid();
  if (!oid) throw new Error('not signed in');
  await graphPost(
    PRESENCE_SCOPES,
    `/users/${encodeURIComponent(oid)}/presence/clearUserPreferredPresence`,
    {}
  );
}

export interface PortalMeetingInput {
  subject: string;
  /** local wall-clock start, Graph dateTime format (no offset) */
  startDateTime: string;
  /** local wall-clock end, Graph dateTime format (no offset) */
  endDateTime: string;
  teamsMeeting: boolean;
}

/** Create a calendar event as the signed-in user (organizer = me). */
export async function createPortalMeeting(input: PortalMeetingInput): Promise<void> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await graphPost(CALENDAR_SCOPES, '/me/events', {
    subject: input.subject,
    start: { dateTime: input.startDateTime, timeZone },
    end: { dateTime: input.endDateTime, timeZone },
    ...(input.teamsMeeting
      ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }
      : {}),
  });
}
