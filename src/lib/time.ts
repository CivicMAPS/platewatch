/** Time helpers. All calculations use the device's local time zone. */

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');

/** UTC offset of a Date in "+HH:MM" form. */
export function utcOffset(d: Date): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '-';
  return `${sign}${pad(Math.floor(Math.abs(mins) / 60))}:${pad(Math.abs(mins) % 60)}`;
}

/** ISO 8601 local timestamp with milliseconds and UTC offset. */
export function toLocalIso(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    utcOffset(d)
  );
}

/** EXIF "YYYY:MM:DD HH:MM:SS" in local time. */
export function toExifDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "1h 05m 09s" / "12m 03s" / "45s". Negative durations are shown with a minus sign. */
export function formatDuration(ms: number): string {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let out: string;
  if (d > 0) out = `${d}d ${h}h ${pad(m)}m`;
  else if (h > 0) out = `${h}h ${pad(m)}m ${pad(s)}s`;
  else if (m > 0) out = `${m}m ${pad(s)}s`;
  else out = `${s}s`;
  return neg ? `-${out}` : out;
}

/** "2h", "30m", "1h 30m" for allowance labels. */
export function formatMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

const timeFmt = new Intl.DateTimeFormat('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('en-AU', { weekday: 'short' });
const zoneNameFmt = new Intl.DateTimeFormat('en-AU', { timeZoneName: 'short' });

/** "10:41:07" (24-hour). */
export const formatClock = (ms: number) => timeFmt.format(ms);

/** "21/11/2026": the CivicMAPS on-screen date format (ISO 8601 stays on the wire). */
export const formatDate = (ms: number) => dateFmt.format(ms);

/** "Sat 21/11/2026 10:41:07". */
export const formatDateTime = (ms: number) => `${weekdayFmt.format(ms)} ${formatDate(ms)} ${formatClock(ms)}`;

/** Short zone name for an instant, e.g. "AEDT"; falls back to the UTC offset. */
export function zoneAbbreviation(ms: number): string {
  const name = zoneNameFmt.formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value;
  return name || `UTC${utcOffset(new Date(ms))}`;
}

/** "21/11/2026 10:41:07 AEDT": capture times shown to the officer (assessment D10). */
export const formatStamp = (ms: number) => `${formatDate(ms)} ${formatClock(ms)} ${zoneAbbreviation(ms)}`;

/** Stored "YYYY-MM-DD" (permit validity) → "DD/MM/YYYY"; any other text is returned unchanged. */
export function formatIsoDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v;
}

/** Parse "HH:MM" (00:00–24:00) into minutes after midnight, or null if invalid. */
export function parseHhmm(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

/** Local midnight of the given instant shifted by `dayOffset` days. */
export function localMidnight(ms: number, dayOffset = 0): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

/** Local instant for a day (midnight Date) plus minutes after midnight (DST-safe). */
export function atMinutes(midnight: Date, minutes: number): number {
  const d = new Date(midnight.getTime());
  d.setHours(0, minutes, 0, 0);
  return d.getTime();
}

export function localDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const weekdayTimeFmt = new Intl.DateTimeFormat('en-AU', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** "18:00" when `end` is later today, otherwise "Sat 00:00". */
export function formatUntil(end: number, now: number): string {
  return localDateString(end) === localDateString(now) ? formatClock(end).slice(0, 5) : weekdayTimeFmt.format(end);
}
