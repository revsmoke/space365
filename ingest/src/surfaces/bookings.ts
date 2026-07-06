/**
 * P4 surface: Microsoft Bookings appointments.
 *
 * Lists /solutions/bookingBusinesses and each business's appointments in a
 * today ± 7d window (calendarView with start/end; falls back to plain
 * /appointments + client-side windowing if calendarView is rejected).
 * Tenants commonly have ZERO booking businesses — that is reported, not an
 * error. Graph v1.0 bookingAppointment has no status field (cancelled
 * appointments disappear from the list), so status is derived from the
 * time window: completed | in_progress | upcoming.
 */
import { GraphError } from "../graph_client";
import {
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
  msToMicros,
  parseGraphUtcMs,
} from "./common";

export const BOOKINGS_INTERVAL_MS = 15 * 60_000;
export const BOOKINGS_WINDOW_DAYS = 7;

export type BookingAppointment = {
  id?: string;
  serviceName?: string;
  serviceId?: string;
  startDateTime?: { dateTime?: string; timeZone?: string };
  endDateTime?: { dateTime?: string; timeZone?: string };
};

export type BookingRow = {
  appointmentId: string;
  businessId: string;
  serviceName: string;
  startsAtMicros: bigint;
  status: string;
};

export function deriveAppointmentStatus(
  startMs: number,
  endMs: number | null,
  nowMs: number,
): string {
  if (endMs !== null && endMs <= nowMs) return "completed";
  if (startMs <= nowMs) return "in_progress";
  return "upcoming";
}

export function mapAppointment(
  appointment: BookingAppointment,
  businessId: string,
  nowMs: number,
): BookingRow | null {
  const startMs = parseGraphUtcMs(appointment.startDateTime?.dateTime);
  if (!appointment.id || startMs === null) return null;
  const endMs = parseGraphUtcMs(appointment.endDateTime?.dateTime);
  return {
    appointmentId: appointment.id,
    businessId,
    serviceName: appointment.serviceName || appointment.serviceId || "",
    startsAtMicros: msToMicros(startMs),
    status: deriveAppointmentStatus(startMs, endMs, nowMs),
  };
}

export type BookingsResult = {
  /** false when the tenant rejects the Bookings API entirely (401/403). */
  apiAvailable: boolean;
  businesses: number;
  appointmentsWritten: number;
};

export async function runBookingsOnce(
  graph: GraphLike,
  reducers: Pick<SurfaceReducers, "upsertBookingAppointment">,
  options: SurfaceRunOptions = {},
): Promise<BookingsResult> {
  const log = options.log ?? console.log;
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = BOOKINGS_WINDOW_DAYS * 24 * 3_600_000;
  const startIso = new Date(nowMs - windowMs).toISOString();
  const endIso = new Date(nowMs + windowMs).toISOString();

  let businesses: { id?: string }[];
  try {
    businesses = (await graph.getAll("/solutions/bookingBusinesses")) as { id?: string }[];
  } catch (error) {
    if (error instanceof GraphError && (error.status === 401 || error.status === 403)) {
      log(`bookings.unavailable status=${error.status} code=${error.code}`);
      return { apiAvailable: false, businesses: 0, appointmentsWritten: 0 };
    }
    throw error;
  }

  if (businesses.length === 0) {
    log("bookings.done businesses=0 (tenant has no booking businesses)");
    return { apiAvailable: true, businesses: 0, appointmentsWritten: 0 };
  }

  let appointmentsWritten = 0;
  for (const business of businesses) {
    if (!business.id) continue;
    let appointments: BookingAppointment[];
    try {
      appointments = (await graph.getAll(
        `/solutions/bookingBusinesses/${business.id}/calendarView` +
          `?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
      )) as BookingAppointment[];
    } catch (error) {
      if (error instanceof GraphError && (error.status === 400 || error.status === 404)) {
        // calendarView rejected: fall back to the full list + client window.
        log(`bookings.calendar_view_fallback business=${business.id} status=${error.status}`);
        appointments = (await graph.getAll(
          `/solutions/bookingBusinesses/${business.id}/appointments`,
        )) as BookingAppointment[];
      } else {
        throw error;
      }
    }
    for (const appointment of appointments) {
      const row = mapAppointment(appointment, business.id, nowMs);
      if (!row) continue;
      // Client-side windowing (covers the /appointments fallback path).
      const startMs = Number(row.startsAtMicros / 1000n);
      if (startMs < nowMs - windowMs || startMs > nowMs + windowMs) continue;
      if (!options.dryRun) await reducers.upsertBookingAppointment(row);
      appointmentsWritten++;
    }
  }

  log(
    `bookings.done businesses=${businesses.length} written=${appointmentsWritten}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return { apiAvailable: true, businesses: businesses.length, appointmentsWritten };
}
