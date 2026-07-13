/**
 * Presence pipeline (SPEC §8 Tier B, P1.6).
 *
 * PRIMARY: real Graph presence via POST /communications/getPresencesByUserId
 * (Presence.Read.All granted 2026-07-06; batch up to ~650 ids). Rows land in
 * `presence` with source 'graph'.
 *
 * FALLBACK (degraded mode, auto-engaged when presence calls fail with
 * 401/403): calendar inference from /users/{id}/calendarView for now±1h
 * (Calendars.Read). 'InAMeeting' if an event covers now, else 'Available'
 * during office hours, else 'Away' — source 'calendar_fallback'.
 */
import { GraphClient, GraphError } from "./graph_client";
import { stdbSql } from "./stdb_sql";
import type { StdbWriter } from "./stdb_writer";

export const CALENDAR_FALLBACK_USER_LIMIT = 20;
export const PRESENCE_BATCH_LIMIT = 650;

export type OfficeHours = {
  startHour: number;
  endHour: number;
  utcOffsetMinutes: number;
};

export const DEFAULT_OFFICE_HOURS: OfficeHours = {
  startHour: 8,
  endHour: 18,
  utcOffsetMinutes: -300,
};

export type CalendarEventWindow = { startMs: number; endMs: number };

export function deriveAvailabilityFromCalendar(
  events: CalendarEventWindow[],
  nowMs: number,
  officeHours: OfficeHours = DEFAULT_OFFICE_HOURS,
): { availability: string; activity: string } {
  const inMeeting = events.some(
    (event) => event.startMs <= nowMs && nowMs < event.endMs,
  );
  if (inMeeting) return { availability: "InAMeeting", activity: "InAMeeting" };

  const localMs = nowMs + officeHours.utcOffsetMinutes * 60_000;
  const hour = new Date(localMs).getUTCHours();
  const day = new Date(localMs).getUTCDay();
  const isWeekday = day >= 1 && day <= 5;
  if (isWeekday && hour >= officeHours.startHour && hour < officeHours.endHour) {
    return { availability: "Available", activity: "Available" };
  }
  return { availability: "Away", activity: "OutOfOfficeHours" };
}

export type GraphPresence = {
  id?: string;
  availability?: string;
  activity?: string;
};

export function normalizeGraphPresence(
  presence: GraphPresence,
): { userId: string; availability: string; activity: string } | null {
  if (!presence.id) return null;
  return {
    userId: presence.id,
    availability: presence.availability ?? "PresenceUnknown",
    activity: presence.activity ?? "PresenceUnknown",
  };
}

export type CalendarViewEvent = {
  start?: { dateTime?: string };
  end?: { dateTime?: string };
};

/** Graph calendarView start/end are tz-suffix-less UTC datetimes. */
export function calendarEventWindows(events: CalendarViewEvent[]): CalendarEventWindow[] {
  const windows: CalendarEventWindow[] = [];
  for (const event of events) {
    const start = parseGraphUtc(event.start?.dateTime);
    const end = parseGraphUtc(event.end?.dateTime);
    if (start !== null && end !== null) windows.push({ startMs: start, endMs: end });
  }
  return windows;
}

function parseGraphUtc(value: string | undefined): number | null {
  if (!value) return null;
  const withZone = /[zZ]$|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

export type PresencePollerOptions = {
  graph: GraphClient;
  writer: StdbWriter;
  officeHours?: OfficeHours;
  log?: (line: string) => void;
};

export type PollCycleResult = {
  mode: "graph" | "calendar_fallback";
  written: number;
  skipped: number;
};

export class PresencePoller {
  #graph: GraphClient;
  #writer: StdbWriter;
  #officeHours: OfficeHours;
  #log: (line: string) => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  /** Sticky degraded flag: flips when Graph presence is denied. */
  presenceApiAvailable = true;

  constructor(options: PresencePollerOptions) {
    this.#graph = options.graph;
    this.#writer = options.writer;
    this.#officeHours = options.officeHours ?? DEFAULT_OFFICE_HOURS;
    this.#log = options.log ?? console.log;
  }

  async #syncedUserIds(): Promise<string[]> {
    const rows = await stdbSql("SELECT user_id FROM user WHERE is_active = true");
    return rows.map((row) => row[0]).filter(Boolean);
  }

  async pollOnce(): Promise<PollCycleResult> {
    const userIds = await this.#syncedUserIds();
    if (userIds.length === 0) {
      this.#log("presence.poll no synced users yet");
      return { mode: this.presenceApiAvailable ? "graph" : "calendar_fallback", written: 0, skipped: 0 };
    }

    if (this.presenceApiAvailable) {
      try {
        return await this.#pollGraphPresence(userIds);
      } catch (error) {
        const status = error instanceof GraphError ? error.status : 0;
        if (status === 401 || status === 403) {
          this.presenceApiAvailable = false;
          this.#log(
            `presence.graph unavailable status=${status} — feature marked unavailable, ` +
              "switching to calendar fallback",
          );
        } else {
          this.#log(`presence.graph error status=${status} ${(error as Error).message} — falling back this cycle`);
        }
      }
    }
    return await this.#pollCalendarFallback(userIds);
  }

  async #pollGraphPresence(userIds: string[]): Promise<PollCycleResult> {
    let written = 0;
    for (let offset = 0; offset < userIds.length; offset += PRESENCE_BATCH_LIMIT) {
      const ids = userIds.slice(offset, offset + PRESENCE_BATCH_LIMIT);
      const response = (await this.#graph.post(
        "/communications/getPresencesByUserId",
        { ids },
      )) as { value?: GraphPresence[] };
      for (const raw of response.value ?? []) {
        const presence = normalizeGraphPresence(raw);
        if (!presence) continue;
        await this.#writer.ingestPresence({ ...presence, source: "graph" });
        written++;
      }
    }
    this.#log(`presence.poll mode=graph written=${written}`);
    return { mode: "graph", written, skipped: 0 };
  }

  async #pollCalendarFallback(userIds: string[]): Promise<PollCycleResult> {
    const nowMs = Date.now();
    const start = new Date(nowMs - 60 * 60 * 1000).toISOString();
    const end = new Date(nowMs + 60 * 60 * 1000).toISOString();
    let written = 0;
    let skipped = 0;

    for (const userId of userIds.slice(0, CALENDAR_FALLBACK_USER_LIMIT)) {
      let windows: CalendarEventWindow[] = [];
      try {
        const response = (await this.#graph.get(
          `/users/${userId}/calendarView?startDateTime=${encodeURIComponent(start)}` +
            `&endDateTime=${encodeURIComponent(end)}&$select=start,end&$top=10`,
        )) as { value?: CalendarViewEvent[] };
        windows = calendarEventWindows(response.value ?? []);
      } catch (error) {
        const status = error instanceof GraphError ? error.status : 0;
        if (status === 403 || status === 404) {
          skipped++;
          this.#log(`presence.calendar skip user=${userId} status=${status}`);
          continue;
        }
        throw error;
      }
      const derived = deriveAvailabilityFromCalendar(windows, nowMs, this.#officeHours);
      await this.#writer.ingestPresence({
        userId,
        availability: derived.availability,
        activity: derived.activity,
        source: "calendar_fallback",
      });
      written++;
    }

    this.#log(`presence.poll mode=calendar_fallback written=${written} skipped=${skipped}`);
    return { mode: "calendar_fallback", written, skipped };
  }

  start(intervalMs = 60_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.pollOnce().catch((error) =>
        this.#log(`presence.loop_error ${(error as Error).message}`),
      );
    }, intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
