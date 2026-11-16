// The "@status" first-line convention inside a person's private note. Pure functions only (no DOM,
// no network) so they can be tested from Node; saving lives in contexts/appState.js.
//
//   @status contacted 2026-11-05 · follow-up 2026-11-20 · replied 2026-11-08
//   free text…

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_LINE_RE = /^@status\b/i;
const TOKEN_SEPARATOR_RE = /\s*[·|,]\s*/;
const REACHED_OUT_PREFIX = "Reached out";
const MS_PER_DAY = 86400000;

/**
 * Parse a note body into its status fields and free text. Unknown tokens are kept in `extra`
 * so hand-written status lines survive a round trip.
 * @returns {{contacted: boolean, contactedOn: string|null, followUp: string|null, replied: boolean,
 *   repliedOn: string|null, extra: string[], text: string}}
 */
export function parseNote(body) {
  const status = { contacted: false, contactedOn: null, followUp: null, replied: false, repliedOn: null, extra: [], text: "" };
  if (!body) return status;
  const lines = String(body).replace(/^\s+/, "").split("\n");
  if (!STATUS_LINE_RE.test(lines[0])) {
    status.text = String(body);
    return status;
  }
  const tokens = lines[0].replace(STATUS_LINE_RE, "").split(TOKEN_SEPARATOR_RE).map((token) => token.trim()).filter(Boolean);
  for (const token of tokens) applyToken(status, token);
  status.text = lines.slice(1).join("\n");
  return status;
}

/** Inverse of parseNote. A note with no status fields is just its text. */
export function serializeNote(status) {
  const tokens = [];
  if (status.contacted) tokens.push(status.contactedOn ? `contacted ${status.contactedOn}` : "contacted");
  if (status.followUp) tokens.push(`follow-up ${status.followUp}`);
  if (status.replied) tokens.push(status.repliedOn ? `replied ${status.repliedOn}` : "replied");
  tokens.push(...(status.extra || []));
  return tokens.length ? `@status ${tokens.join(" · ")}\n${status.text || ""}` : status.text || "";
}

/** Parsed note plus whether its follow-up is due today (`due`) or already past (`overdue`). */
export function noteStatusOf(person) {
  const status = parseNote(person?.note);
  const today = todayISO();
  status.due = !!status.followUp && status.followUp <= today;
  status.overdue = !!status.followUp && status.followUp < today;
  return status;
}

/** Today's local calendar date as "YYYY-MM-DD". */
export function todayISO() {
  return toISO(new Date());
}

/** The local calendar date `days` after `fromISO` (default today). */
export function addDaysISO(days, fromISO = todayISO()) {
  return toISO(new Date(new Date(fromISO + "T12:00:00").getTime() + days * MS_PER_DAY));
}

/** The note line written by "I sent it": "Reached out 2026-11-06: Career advice …". */
export function reachedOutLine(summary, dayISO = todayISO()) {
  return `${REACHED_OUT_PREFIX} ${dayISO}: ${summary}`;
}

/** Has a "Reached out" line already been logged for `dayISO`? Keeps logging idempotent per day. */
export function hasReachedOutOn(text, dayISO = todayISO()) {
  return String(text || "").split("\n").some((line) => line.startsWith(`${REACHED_OUT_PREFIX} ${dayISO}`));
}

// ---------- private helpers ----------

function isValidISO(value) {
  return ISO_DATE_RE.test(value) && !isNaN(new Date(value + "T12:00:00"));
}

function toISO(day) {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function applyToken(status, token) {
  const contacted = token.match(/^contacted(?:\s+(\S+))?$/i);
  if (contacted && (!contacted[1] || isValidISO(contacted[1]))) {
    status.contacted = true;
    status.contactedOn = contacted[1] || null;
    return;
  }
  const followUp = token.match(/^follow[- ]?up\s+(\S+)$/i);
  if (followUp && isValidISO(followUp[1])) {
    status.followUp = followUp[1];
    return;
  }
  const replied = token.match(/^replied(?:\s+(\S+))?$/i);
  if (replied && (!replied[1] || isValidISO(replied[1]))) {
    status.replied = true;
    status.repliedOn = replied[1] || null;
    return;
  }
  // v1 had a "★" star token; it was removed, so drop it instead of keeping it as unknown text.
  if (/^(★|star)$/i.test(token)) return;
  status.extra.push(token);
}
