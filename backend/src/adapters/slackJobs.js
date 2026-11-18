// Extracts job/internship postings from the existing Slack archive
// (messages.json) into `job` records. Reads local data only; DMs are skipped
// because they are private conversations, not shared postings.
import { readJSON, FILES } from "../data/jsonStore.js";
import { makeRecord } from "../lib/records.js";
import { detectJobPost, stripChatMarkup, safeHttpsLink, SNIPPET_CHARS } from "../services/jobPostDetector.js";

export const name = "slackJobs";

const SKIPPED_SUBTYPES = new Set(["channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "message_deleted", "message_changed"]);
const PRIVATE_CHANNEL_TYPES = new Set(["im", "mpim", "dm"]);

/**
 * @param {{ workspaceUrl?: string }} options  e.g. "https://myteam.slack.com" to build message permalinks
 * @param {{ readMessages?: () => object[], detect?: Function }} [deps]
 * @returns {Promise<object[]>} job records, one per detected posting
 */
export async function fetchRecords(options = {}, deps = {}) {
  const messages = (deps.readMessages ?? (() => readJSON(FILES.messages, [])))();
  const detect = deps.detect ?? detectJobPost;
  const records = [];
  for (const message of messages) {
    if (PRIVATE_CHANNEL_TYPES.has(message.channel_type) || message.dm_with || SKIPPED_SUBTYPES.has(message.subtype)) continue;
    const found = detect({ text: message.text ?? "", channel: message.channel ?? "" });
    if (found.isJob) records.push(toJobRecord(message, found, options.workspaceUrl));
  }
  return records;
}

/** @returns {string | null} Slack message permalink, e.g. https://team.slack.com/archives/C1/p1700000000000100 */
export function slackPermalink(workspaceUrl, channelId, ts) {
  if (!workspaceUrl || !channelId || !ts) return null;
  const base = workspaceUrl.replace(/\/+$/, "");
  if (!/^https:\/\/[\w.-]+\.slack\.com$/.test(base)) return null;
  return `${base}/archives/${channelId}/p${String(ts).replace(".", "")}`;
}

// ---------------------------------------------------------------- private helpers
function toJobRecord(message, found, workspaceUrl) {
  return makeRecord("job", name, `slack:message:${message.channel_id}:${message.ts}`, {
    title: found.title ?? stripChatMarkup(message.text).slice(0, 80),
    company: found.company, location: found.location, link: safeHttpsLink(found.link),
    postedAt: message.date ?? null, channel: message.channel ?? null,
    permalink: slackPermalink(workspaceUrl, message.channel_id, message.ts),
    snippet: stripChatMarkup(message.text).slice(0, SNIPPET_CHARS),
  });
}
