/**
 * P4 surface: ambient meeting portals from user calendars.
 *
 * For synced users (first 30 active), reads /users/{id}/calendarView for
 * now → now+24h and upserts `meeting` rows. Privacy (PRD): the subject is
 * NEVER stored — portals show time/place only, so subject_redacted is ''.
 * joinUrl comes from event.onlineMeeting.joinUrl (OnlineMeetings.Read.All).
 * Copies of the same event across attendee calendars are deduped by
 * iCalUId (fallback: event id), preferring the organizer's copy so the
 * meeting lands in the organizer's team zone; otherwise zone 0 (plaza).
 */
import { GraphError } from "../graph_client";
import { stdbSql } from "../stdb_sql";
import {
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
  msToMicros,
  parseGraphUtcMs,
} from "./common";

export const MEETINGS_INTERVAL_MS = 5 * 60_000;
export const MEETINGS_USER_LIMIT = 30;
export const MEETINGS_WINDOW_HOURS = 24;

export type CalendarEvent = {
  id?: string;
  iCalUId?: string;
  isOrganizer?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string } | null;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
};

export type TeamLookup = {
  /** user id -> synced team ids the user belongs to */
  teamsByUser: Map<string, string[]>;
  /** team id -> zone id */
  zoneByTeam: Map<string, number>;
};

export type MeetingRow = {
  eventId: string;
  teamId: string | undefined;
  zoneId: number;
  subjectRedacted: string;
  startsAtMicros: bigint;
  endsAtMicros: bigint;
  joinUrl: string | undefined;
};

/**
 * Zone for an organizer: their first synced team (sorted by team id for
 * determinism when a user is in several teams), else plaza (zone 0).
 */
export function zoneForOrganizer(
  organizerUserId: string | undefined,
  lookup: TeamLookup,
): { teamId: string | undefined; zoneId: number } {
  if (organizerUserId) {
    const teams = [...(lookup.teamsByUser.get(organizerUserId) ?? [])].sort();
    for (const teamId of teams) {
      const zoneId = lookup.zoneByTeam.get(teamId);
      if (zoneId !== undefined) return { teamId, zoneId };
    }
  }
  return { teamId: undefined, zoneId: 0 };
}

export function mapEventToMeeting(
  event: CalendarEvent,
  organizerUserId: string | undefined,
  lookup: TeamLookup,
): MeetingRow | null {
  const startMs = parseGraphUtcMs(event.start?.dateTime);
  const endMs = parseGraphUtcMs(event.end?.dateTime);
  if (!event.id || startMs === null || endMs === null) return null;
  const { teamId, zoneId } = zoneForOrganizer(organizerUserId, lookup);
  return {
    eventId: event.id,
    teamId,
    zoneId,
    // PRD privacy: ambient portals show time/place only — never the subject.
    subjectRedacted: "",
    startsAtMicros: msToMicros(startMs),
    endsAtMicros: msToMicros(endMs),
    joinUrl:
      event.isOnlineMeeting && event.onlineMeeting?.joinUrl
        ? event.onlineMeeting.joinUrl
        : undefined,
  };
}

export type UserEvents = { userId: string; events: CalendarEvent[] };

export type DedupedEvent = {
  event: CalendarEvent;
  organizerUserId: string | undefined;
};

/**
 * Dedupe copies of the same event across attendee calendars by iCalUId
 * (fallback: event id). The organizer's copy wins so zone attribution and
 * the stored event id are the organizer's.
 */
export function dedupeEvents(perUser: UserEvents[]): DedupedEvent[] {
  const byKey = new Map<string, DedupedEvent>();
  for (const { userId, events } of perUser) {
    for (const event of events) {
      const key = event.iCalUId || event.id;
      if (!key) continue;
      const organizerUserId = event.isOrganizer ? userId : undefined;
      const existing = byKey.get(key);
      if (!existing || (organizerUserId && !existing.organizerUserId)) {
        byKey.set(key, { event, organizerUserId });
      }
    }
  }
  return [...byKey.values()];
}

export async function loadTeamLookup(sql: typeof stdbSql): Promise<TeamLookup> {
  const lookup: TeamLookup = { teamsByUser: new Map(), zoneByTeam: new Map() };
  for (const [teamId, zoneId] of await sql("SELECT team_id, zone_id FROM team")) {
    const zone = Number(zoneId);
    if (teamId && Number.isFinite(zone)) lookup.zoneByTeam.set(teamId, zone);
  }
  for (const [teamId, userId] of await sql("SELECT team_id, user_id FROM team_member")) {
    if (!teamId || !userId) continue;
    const teams = lookup.teamsByUser.get(userId);
    if (teams) teams.push(teamId);
    else lookup.teamsByUser.set(userId, [teamId]);
  }
  return lookup;
}

export type MeetingsResult = {
  usersPolled: number;
  usersSkipped: number;
  eventsDeduped: number;
  meetingsWritten: number;
};

export async function runMeetingsOnce(
  graph: GraphLike,
  reducers: Pick<SurfaceReducers, "upsertMeeting">,
  options: SurfaceRunOptions = {},
): Promise<MeetingsResult> {
  const log = options.log ?? console.log;
  const sql = options.sql ?? stdbSql;
  const nowMs = options.nowMs ?? Date.now();

  const userIds = (await sql("SELECT user_id FROM user WHERE is_active = true"))
    .map((row) => row[0])
    .filter(Boolean)
    .slice(0, MEETINGS_USER_LIMIT);
  const lookup = await loadTeamLookup(sql);

  const start = new Date(nowMs).toISOString();
  const end = new Date(nowMs + MEETINGS_WINDOW_HOURS * 3_600_000).toISOString();
  const perUser: UserEvents[] = [];
  let usersSkipped = 0;

  for (const userId of userIds) {
    try {
      const events = (await graph.getAll(
        `/users/${userId}/calendarView` +
          `?startDateTime=${encodeURIComponent(start)}` +
          `&endDateTime=${encodeURIComponent(end)}` +
          `&$select=id,iCalUId,isOrganizer,isOnlineMeeting,onlineMeeting,start,end` +
          `&$top=50`,
      )) as CalendarEvent[];
      perUser.push({ userId, events });
    } catch (error) {
      // No mailbox / no license / access policy: skip this user, keep going.
      if (error instanceof GraphError && (error.status === 403 || error.status === 404)) {
        usersSkipped++;
        log(`meetings.skip user=${userId} status=${error.status} code=${error.code}`);
        continue;
      }
      throw error;
    }
  }

  const deduped = dedupeEvents(perUser);
  let meetingsWritten = 0;
  for (const { event, organizerUserId } of deduped) {
    const row = mapEventToMeeting(event, organizerUserId, lookup);
    if (!row) continue;
    if (!options.dryRun) await reducers.upsertMeeting(row);
    meetingsWritten++;
  }

  log(
    `meetings.done users=${perUser.length} skipped=${usersSkipped} ` +
      `events=${deduped.length} written=${meetingsWritten}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return {
    usersPolled: perUser.length,
    usersSkipped,
    eventsDeduped: deduped.length,
    meetingsWritten,
  };
}
