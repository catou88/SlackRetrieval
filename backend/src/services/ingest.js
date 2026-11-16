// Owns Slack ingestion: pulls every message you can see in the workspace
// (public + private channels, DMs, group DMs, and thread replies) plus the
// profiles of everyone who posted, and saves them to data/messages.json,
// users.json, channels.json and state.json. Shared files and profile photos
// go to data/files and data/avatars, so they survive after you lose access
// to the workspace.
//
// Re-running is incremental: it only fetches messages newer than the last run
// (per conversation, tracked in state.latestTs) unless `full` is set.
import fs from "node:fs";
import { CONFIG } from "../config.js";
import { assertUsableSlackToken, createSlackClient, downloadSlackFile, downloadProfilePhoto } from "../clients/slack.js";
import { readJSON, writeJSON, writeFileAtomic, dataPath, relativeFilePath, avatarPath, FILES } from "../data/jsonStore.js";
import { extractLinkedIn, extractUrls } from "../lib/patterns.js";

const CONVERSATION_TYPES = "public_channel,private_channel,mpim,im";
const PAGE_SIZE = 200;
const SAVE_EVERY_CONVERSATIONS = 10; // a crash mid-sync loses at most this many conversations
const SKIPPED_SUBTYPES = new Set(["channel_join", "channel_leave"]);
const SLACKBOT_ID = "USLACKBOT";
const FILES_DIR = "files";
const AVATARS_DIR = "avatars";

/**
 * Sync the workspace into data/ and (optionally) download files and photos.
 * @param {{ token?: string, onlyMember?: boolean, downloadFiles?: boolean, full?: boolean,
 *   log?: (line: string) => void }} [opts]
 *   onlyMember: false also reads public channels you haven't joined;
 *   full: re-read every conversation from the start (catches new replies to old threads)
 * @returns {Promise<{ messages: object[], users: Record<string, object>, state: object }>}
 * @throws {Error} when the token is missing/unusable or Slack rejects it
 */
export async function ingestSlackWorkspace({
  token = CONFIG.slack.token, onlyMember = true, downloadFiles = true, full = false, log = console.log,
} = {}) {
  assertUsableSlackToken(token);
  const slack = createSlackClient(token);

  const auth = await slack.auth.test();
  log(`Connected to workspace "${auth.team}" as ${auth.user} (${auth.user_id})`);

  const state = readJSON(FILES.state, { latestTs: {} });
  state.me = auth.user_id;
  state.team = auth.team;
  state.teamUrl = auth.url;

  const archive = {
    messagesById: new Map(readJSON(FILES.messages, []).map((message) => [message.id, message])),
    users: readJSON(FILES.users, {}),
    state,
    addedCount: 0,
  };

  await syncUserDirectory(slack, archive.users, log);
  const conversations = await listConversations(slack, { onlyMember });
  log(`Found ${conversations.length} conversations.`);

  for (const [position, conversation] of conversations.entries()) {
    if (position > 0 && position % SAVE_EVERY_CONVERSATIONS === 0) saveProgress(archive);
    await syncConversation(slack, conversation, archive, { full, log });
  }

  await fetchDetailedProfiles(slack, archive, log);

  const messages = sortedMessages(archive);
  writeJSON(FILES.messages, messages);
  writeJSON(FILES.users, archive.users);
  writeJSON(FILES.channels, conversations.map((conversation) => channelRecord(conversation, archive.users)));
  writeJSON(FILES.state, state);

  if (downloadFiles) await downloadAttachments({ token, messages, users: archive.users, log });
  log(`Saved ${messages.length} messages (${archive.addedCount} new) and ${Object.keys(archive.users).length} users to data/.`);
  return { messages, users: archive.users, state };
}

// ---------------------------------------------------------------- private helpers: users
async function syncUserDirectory(slack, users, log) {
  log("Fetching user directory…");
  for await (const page of slack.paginate("users.list", { limit: PAGE_SIZE })) {
    for (const member of page.members || []) {
      if (member.deleted) continue;
      users[member.id] = { ...(users[member.id] || {}), ...directoryEntry(member) };
    }
  }
}

function directoryEntry(member) {
  return {
    id: member.id,
    handle: member.name,
    name: member.profile?.real_name || member.real_name || member.name,
    display_name: member.profile?.display_name || "",
    title: member.profile?.title || "",
    email: member.profile?.email || "",
    timezone: member.tz || "",
    is_bot: !!member.is_bot || member.id === SLACKBOT_ID,
    is_admin: !!member.is_admin,
    avatar: member.profile?.image_192 || "",
  };
}

// Custom profile fields are where people often put their LinkedIn; fetched
// once per person who posted or DMed with you.
async function fetchDetailedProfiles(slack, archive, log) {
  const { users } = archive;
  const records = [...archive.messagesById.values()];
  const posters = new Set(records.map((message) => message.user_id));
  const dmPartners = new Set(records.map((message) => message.dm_with).filter(Boolean));
  const needProfile = [...new Set([...posters, ...dmPartners])].filter(
    (id) => users[id] && !users[id].is_bot && !users[id].profile_fetched
  );
  log(`Fetching detailed profiles for ${needProfile.length} people…`);
  for (const id of needProfile) {
    try {
      const { profile } = await slack.users.profile.get({ user: id });
      applyDetailedProfile(users[id], profile);
    } catch (err) {
      if (err.data?.error === "missing_scope") {
        log("  (no users.profile:read scope — skipping custom profile fields)");
        break;
      }
      // Any other failure only costs this person's extra fields.
    }
  }
}

function applyDetailedProfile(user, profile) {
  const fields = Object.values(profile?.fields || {}).map((field) => ({
    label: field.label || "",
    value: field.value || "",
    alt: field.alt || "",
  }));
  user.profile_fields = fields;
  user.status = profile?.status_text || "";
  user.pronouns = profile?.pronouns || "";
  user.profile_fetched = true;
  const fromProfile = extractLinkedIn(
    [profile?.title, profile?.status_text, ...fields.map((field) => `${field.value} ${field.alt}`)].join(" ")
  );
  if (fromProfile.length) user.linkedin_from_profile = fromProfile;
}

// ---------------------------------------------------------------- private helpers: conversations
async function listConversations(slack, { onlyMember }) {
  const conversations = [];
  for await (const page of slack.paginate("users.conversations", {
    types: CONVERSATION_TYPES,
    exclude_archived: false,
    limit: PAGE_SIZE,
  })) {
    conversations.push(...(page.channels || []));
  }
  if (onlyMember) return conversations;
  // Also read public channels you haven't joined (Slack allows history on
  // public channels for user tokens with channels:history).
  const joined = new Set(conversations.map((conversation) => conversation.id));
  for await (const page of slack.paginate("conversations.list", {
    types: "public_channel",
    exclude_archived: false,
    limit: PAGE_SIZE,
  })) {
    for (const channel of page.channels || []) if (!joined.has(channel.id)) conversations.push(channel);
  }
  return conversations;
}

// One conversation: its history since the last run, then every thread that
// has replies. A failure (no access, archived DM, …) skips the conversation.
async function syncConversation(slack, conversation, archive, { full, log }) {
  const label = conversationLabel(conversation, archive.users);
  const counts = { messages: 0 };
  try {
    const threadRoots = await syncHistory(slack, conversation, archive, { full, counts });
    for (const threadTs of threadRoots) await syncThread(slack, conversation, threadTs, archive, counts);
    log(`  ${label}: ${counts.messages} new messages${threadRoots.length ? ` (${threadRoots.length} threads)` : ""}`);
  } catch (err) {
    log(`  ${label}: skipped (${err.data?.error || err.message})`);
  }
}

/** @returns {Promise<string[]>} ts of every top-level message that has replies */
async function syncHistory(slack, conversation, archive, { full, counts }) {
  const { latestTs } = archive.state;
  const oldest = full ? undefined : latestTs[conversation.id];
  const threadRoots = [];
  for await (const page of slack.paginate("conversations.history", {
    channel: conversation.id,
    limit: PAGE_SIZE,
    ...(oldest ? { oldest } : {}),
  })) {
    for (const message of page.messages || []) {
      if (SKIPPED_SUBTYPES.has(message.subtype)) continue;
      storeMessage(archive, conversation, message);
      counts.messages++;
      if (message.reply_count) threadRoots.push(message.ts);
      if (!latestTs[conversation.id] || Number(message.ts) > Number(latestTs[conversation.id]))
        latestTs[conversation.id] = message.ts;
    }
  }
  return threadRoots;
}

async function syncThread(slack, conversation, threadTs, archive, counts) {
  for await (const page of slack.paginate("conversations.replies", {
    channel: conversation.id,
    ts: threadTs,
    limit: PAGE_SIZE,
  })) {
    for (const message of page.messages || []) {
      if (message.ts === threadTs) continue; // the root is already stored from history
      storeMessage(archive, conversation, message);
      counts.messages++;
    }
  }
}

function storeMessage(archive, conversation, message) {
  const record = messageRecord(conversation, message, archive.users);
  if (!archive.messagesById.has(record.id)) archive.addedCount++;
  archive.messagesById.set(record.id, record);
}

function saveProgress(archive) {
  writeJSON(FILES.messages, sortedMessages(archive));
  writeJSON(FILES.users, archive.users);
  writeJSON(FILES.state, archive.state);
}

function sortedMessages(archive) {
  return [...archive.messagesById.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

// ---------------------------------------------------------------- private helpers: records
function displayName(users, id) {
  return users[id]?.name || id;
}

function conversationLabel(conversation, users) {
  if (conversation.is_im) return `DM with ${displayName(users, conversation.user)}`;
  if (conversation.is_mpim) return `group DM (${conversation.name})`;
  return `#${conversation.name}`;
}

function conversationType(conversation) {
  if (conversation.is_im) return "im";
  if (conversation.is_mpim) return "mpim";
  return conversation.is_private ? "private" : "public";
}

function channelRecord(conversation, users) {
  return {
    id: conversation.id,
    name: conversationLabel(conversation, users),
    type: conversationType(conversation),
    dm_with: conversation.is_im ? conversation.user : null,
    topic: conversation.topic?.value || "",
    purpose: conversation.purpose?.value || "",
    created: conversation.created || 0,
    is_archived: !!conversation.is_archived,
  };
}

// Slack markup -> readable text: user/channel mentions, broadcasts, links, entities.
function resolveSlackMarkup(text = "", users) {
  return text
    .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => `@${displayName(users, id)}`)
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The searchable text: what was typed, plus the names of shared files and
// link previews (patterns.splitExtras peels these back off).
function searchableText(message, users) {
  const fileNames = (message.files || []).map((file) => file.title || file.name).filter(Boolean);
  const linkPreviews = (message.attachments || [])
    .map((attachment) => [attachment.title, attachment.text, attachment.from_url].filter(Boolean).join(" — "))
    .filter(Boolean);
  let text = resolveSlackMarkup(message.text, users);
  if (fileNames.length) text += `\n[files: ${fileNames.join(", ")}]`;
  if (linkPreviews.length) text += `\n[links: ${linkPreviews.join(" | ")}]`;
  return text;
}

function authorName(message, users) {
  if (message.user) return displayName(users, message.user);
  return message.username || message.bot_profile?.name || "bot";
}

function fileRecord(file) {
  return {
    id: file.id,
    name: file.name || file.title || file.id,
    title: file.title || "",
    mimetype: file.mimetype || "",
    size: file.size || 0,
    url: file.url_private_download || file.url_private || "",
    permalink: file.permalink || "",
  };
}

function messageRecord(conversation, message, users) {
  return {
    id: `${conversation.id}:${message.ts}`,
    channel_id: conversation.id,
    channel: conversationLabel(conversation, users),
    channel_type: conversationType(conversation),
    dm_with: conversation.is_im ? conversation.user : undefined,
    ts: message.ts,
    date: new Date(Number(message.ts) * 1000).toISOString(),
    user_id: message.user || message.bot_id || "unknown",
    user_name: authorName(message, users),
    text: searchableText(message, users),
    thread_ts: message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined,
    reply_count: message.reply_count || 0,
    raw_urls: extractUrls(message.text || ""),
    files: (message.files || []).filter((file) => file.id && file.mode !== "tombstone").map(fileRecord),
    reactions: (message.reactions || []).map((reaction) => ({
      name: reaction.name, count: reaction.count, users: reaction.users || [],
    })),
    // Full original Slack payload so nothing is lost even if a field isn't used yet.
    raw: message,
  };
}

// ---------------------------------------------------------------- private helpers: downloads
async function downloadAttachments({ token, messages, users, log }) {
  fs.mkdirSync(dataPath(FILES_DIR), { recursive: true });
  fs.mkdirSync(dataPath(AVATARS_DIR), { recursive: true });
  await downloadSharedFiles(token, messages, log);
  await downloadProfilePhotos(users, log);
}

async function downloadSharedFiles(token, messages, log) {
  const allFiles = messages.flatMap((message) => message.files || []).filter((file) => file.url);
  const pending = allFiles.filter((file) => !fs.existsSync(dataPath(relativeFilePath(file))));
  log(`Downloading ${pending.length} files (${allFiles.length - pending.length} already saved)…`);
  let savedCount = 0;
  for (const file of pending) {
    try {
      const result = await downloadSlackFile(file, token);
      if (result.outcome === "unauthorized") {
        log("  Can't download files: add the files:read scope to the app, reinstall, and update SLACK_USER_TOKEN.");
        break;
      }
      if (result.outcome === "unavailable") continue; // deleted or unavailable file
      writeFileAtomic(dataPath(relativeFilePath(file)), result.bytes);
      savedCount++;
    } catch (err) {
      log(`  ${file.name}: ${err.message}`);
    }
  }
  if (pending.length) log(`  saved ${savedCount}/${pending.length} files to data/files/`);
}

async function downloadProfilePhotos(users, log) {
  let savedCount = 0;
  for (const user of Object.values(users)) {
    const target = dataPath(avatarPath(user.id));
    if (!user.avatar || fs.existsSync(target)) continue;
    try {
      const bytes = await downloadProfilePhoto(user.avatar);
      if (bytes) {
        writeFileAtomic(target, bytes);
        savedCount++;
      }
    } catch {
      // A missing photo is cosmetic; the next sync retries it.
    }
  }
  if (savedCount) log(`  saved ${savedCount} profile photos to data/avatars/`);
}
