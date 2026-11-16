// Number, plural and date/time formatting for display (en-US, the user's local time zone).

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const CURRENT_YEAR = new Date().getFullYear();
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const LONG_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });
const SHORT_TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;
const JUST_NOW_SECONDS = 45;

/** 1234 → "1,234". */
export function formatNumber(value) {
  return NUMBER_FORMAT.format(value || 0);
}

/** "3 replies" / "1 reply". */
export function pluralize(count, singular, pluralForm = singular + "s") {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Short date: "Oct 23" this year, "Oct 23, 2025" otherwise; "" for missing or invalid input. */
export function formatDate(value) {
  if (!value) return "";
  const parsed = toDate(value);
  if (isNaN(parsed)) return "";
  return (parsed.getFullYear() === CURRENT_YEAR ? SHORT_DATE : LONG_DATE).format(parsed);
}

/** "Thursday, Oct 23". */
export function formatDayLabel(value) {
  return DAY_LABEL.format(toDate(value));
}

/** "3:04 PM". */
export function formatTime(value) {
  return SHORT_TIME.format(toDate(value));
}

/** Local calendar-day key for grouping messages by day. */
export function calendarDayKey(value) {
  const parsed = toDate(value);
  return `${parsed.getFullYear()}-${parsed.getMonth()}-${parsed.getDate()}`;
}

/** ISO calendar date "2026-11-20" (local) → "Nov 20". */
export function formatIsoDate(iso) {
  // Noon avoids the date shifting a day when the ISO string is read as UTC midnight.
  return iso ? formatDate(new Date(iso + "T12:00:00")) : "";
}

/** Relative time for recent moments ("just now", "5m ago", "3h ago"), a date otherwise. */
export function formatTimeAgo(value) {
  const seconds = Math.round((Date.now() - toDate(value)) / 1000);
  if (seconds < JUST_NOW_SECONDS) return "just now";
  if (seconds < SECONDS_PER_HOUR) return `${Math.round(seconds / SECONDS_PER_MINUTE)}m ago`;
  if (seconds < SECONDS_PER_DAY) return `${Math.round(seconds / SECONDS_PER_HOUR)}h ago`;
  return formatDate(value);
}

// ---------- private helpers ----------

// Slack timestamps ("1729700000.123456") are seconds; everything else is a Date or ISO string.
function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return new Date(+value * 1000);
  return new Date(value);
}
