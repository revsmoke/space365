import { describe, expect, test } from "bun:test";
import {
  calendarEventWindows,
  deriveAvailabilityFromCalendar,
  normalizeGraphPresence,
  type OfficeHours,
} from "../ingest/src/presence_poller";

const OFFICE: OfficeHours = { startHour: 8, endHour: 18, utcOffsetMinutes: -300 };

// Monday 2026-07-06 15:00 UTC = 10:00 local (UTC-5): office hours.
const OFFICE_HOURS_NOW = Date.parse("2026-07-06T15:00:00Z");
// Monday 2026-07-06 03:00 UTC = Sunday 22:00 local: outside office hours.
const NIGHT_NOW = Date.parse("2026-07-06T03:00:00Z");
// Saturday 2026-07-04 15:00 UTC: weekend.
const WEEKEND_NOW = Date.parse("2026-07-04T15:00:00Z");

describe("calendar fallback availability mapping", () => {
  test("event covering now => InAMeeting", () => {
    const derived = deriveAvailabilityFromCalendar(
      [{ startMs: OFFICE_HOURS_NOW - 60_000, endMs: OFFICE_HOURS_NOW + 60_000 }],
      OFFICE_HOURS_NOW,
      OFFICE,
    );
    expect(derived.availability).toBe("InAMeeting");
  });

  test("no current event during office hours => Available", () => {
    const derived = deriveAvailabilityFromCalendar(
      [{ startMs: OFFICE_HOURS_NOW + 30 * 60_000, endMs: OFFICE_HOURS_NOW + 60 * 60_000 }],
      OFFICE_HOURS_NOW,
      OFFICE,
    );
    expect(derived.availability).toBe("Available");
  });

  test("outside office hours => Away", () => {
    expect(deriveAvailabilityFromCalendar([], NIGHT_NOW, OFFICE).availability).toBe("Away");
  });

  test("weekend => Away even at midday", () => {
    expect(deriveAvailabilityFromCalendar([], WEEKEND_NOW, OFFICE).availability).toBe("Away");
  });

  test("event boundary: meeting end is exclusive", () => {
    const derived = deriveAvailabilityFromCalendar(
      [{ startMs: OFFICE_HOURS_NOW - 60_000, endMs: OFFICE_HOURS_NOW }],
      OFFICE_HOURS_NOW,
      OFFICE,
    );
    expect(derived.availability).toBe("Available");
  });
});

describe("calendarView parsing", () => {
  test("treats tz-less Graph datetimes as UTC and drops malformed events", () => {
    const windows = calendarEventWindows([
      { start: { dateTime: "2026-07-06T15:00:00.0000000" }, end: { dateTime: "2026-07-06T16:00:00.0000000" } },
      { start: { dateTime: "garbage" }, end: { dateTime: "2026-07-06T16:00:00" } },
      {},
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].startMs).toBe(Date.parse("2026-07-06T15:00:00Z"));
    expect(windows[0].endMs).toBe(Date.parse("2026-07-06T16:00:00Z"));
  });
});

describe("graph presence normalization", () => {
  test("maps id/availability/activity", () => {
    expect(
      normalizeGraphPresence({ id: "u1", availability: "Busy", activity: "InACall" }),
    ).toEqual({ userId: "u1", availability: "Busy", activity: "InACall" });
  });

  test("defaults missing fields to PresenceUnknown, rejects missing id", () => {
    expect(normalizeGraphPresence({ id: "u2" })).toEqual({
      userId: "u2",
      availability: "PresenceUnknown",
      activity: "PresenceUnknown",
    });
    expect(normalizeGraphPresence({})).toBeNull();
  });
});
