import { ConfigurationError } from '../errors/index.js';

export interface TimeWindow {
  /** Minutes from local midnight. */
  startMinute: number;
  endMinute: number;
}

const WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

export const parsePublishWindows = (raw: string): TimeWindow[] => {
  const windows = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = WINDOW_PATTERN.exec(entry);
      if (!match) {
        throw new ConfigurationError(
          `Invalid PUBLISH_WINDOWS entry "${entry}". Expected HH:MM-HH:MM in 24h local time.`,
        );
      }
      const startMinute = Number(match[1]) * 60 + Number(match[2]);
      const endMinute = Number(match[3]) * 60 + Number(match[4]);
      if (endMinute <= startMinute) {
        throw new ConfigurationError(
          `Invalid PUBLISH_WINDOWS entry "${entry}". Windows must not wrap past midnight; split them instead.`,
        );
      }
      return { startMinute, endMinute };
    });

  if (windows.length === 0) {
    throw new ConfigurationError('PUBLISH_WINDOWS must contain at least one window.');
  }
  return windows;
};

/** Local wall-clock parts of an instant in an IANA timezone, without a date library. */
export const localParts = (
  instant: Date,
  timeZone: string,
): { date: string; hour: number; minute: number } => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
  };
};

export const localDate = (instant: Date, timeZone: string): string =>
  localParts(instant, timeZone).date;

export const isWithinPublishWindow = (
  instant: Date,
  timeZone: string,
  windows: TimeWindow[],
): boolean => {
  const { hour, minute } = localParts(instant, timeZone);
  const minuteOfDay = hour * 60 + minute;
  return windows.some(
    (window) => minuteOfDay >= window.startMinute && minuteOfDay < window.endMinute,
  );
};

/**
 * Spread `count` slots evenly across the configured windows so a daily batch does
 * not post everything at once. Returns minute-of-day values, ascending.
 */
export const distributeSlots = (count: number, windows: TimeWindow[]): number[] => {
  if (count <= 0) return [];
  const totalMinutes = windows.reduce(
    (sum, window) => sum + (window.endMinute - window.startMinute),
    0,
  );
  const step = totalMinutes / count;
  const slots: number[] = [];
  for (let index = 0; index < count; index += 1) {
    let offset = Math.floor(step * index + step / 2);
    for (const window of windows) {
      const span = window.endMinute - window.startMinute;
      if (offset < span) {
        slots.push(window.startMinute + offset);
        break;
      }
      offset -= span;
    }
  }
  return slots;
};

/**
 * Next instant at or after `instant` that falls inside a publish window.
 *
 * Returns `instant` unchanged when it is already inside one. The offset is
 * applied as a fixed number of minutes from "now", which is correct except
 * across a DST transition inside the wait, where the result can be an hour off.
 * That is acceptable for a posting window measured in hours; if it ever matters,
 * swap in a real timezone library here and nowhere else.
 */
export const nextPublishInstant = (
  instant: Date,
  timeZone: string,
  windows: TimeWindow[],
): Date => {
  if (isWithinPublishWindow(instant, timeZone, windows)) return instant;

  const { hour, minute } = localParts(instant, timeZone);
  const minuteOfDay = hour * 60 + minute;

  const sorted = [...windows].sort((a, b) => a.startMinute - b.startMinute);
  const upcoming = sorted.find((window) => window.startMinute > minuteOfDay);
  const target = upcoming ?? sorted[0]!;
  const deltaMinutes =
    upcoming === undefined
      ? 24 * 60 - minuteOfDay + target.startMinute
      : target.startMinute - minuteOfDay;

  return new Date(instant.getTime() + deltaMinutes * 60_000);
};

export const nowIso = (clock: () => Date = () => new Date()): string => clock().toISOString();

export const epochSecondsFromNow = (seconds: number, clock: () => Date = () => new Date()): number =>
  Math.floor(clock().getTime() / 1000) + seconds;
