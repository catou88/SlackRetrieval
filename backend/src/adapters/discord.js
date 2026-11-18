// Extracts job/internship postings from DiscordChatExporter JSON exports the
// owner drops in data/discord/. Offline only: no bot tokens, no live Discord
// access. One export file = one channel; every *.json in the folder is read.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../data/jsonStore.js";
import { makeRecord } from "../lib/records.js";
import { detectJobPost, stripChatMarkup, safeHttpsLink, SNIPPET_CHARS } from "../services/jobPostDetector.js";

export const name = "discord";

const MAX_EXPORT_BYTES = 200 * 1024 * 1024; // a larger export would exhaust memory in JSON.parse
const POSTING_MESSAGE_TYPES = new Set(["Default", "Reply"]);

/**
 * @param {{ discordDir?: string }} options  folder of exports (default data/discord)
 * @param {{ listFiles?: (dir: string) => string[], readFile?: (file: string) => string, warn?: (msg: string) => void, detect?: Function }} [deps]
 * @returns {Promise<object[]>} job records
 */
export async function fetchRecords(options = {}, deps = {}) {
  const dir = options.discordDir ?? path.join(DATA_DIR, "discord");
  const listFiles = deps.listFiles ?? defaultListFiles;
  const readFile = deps.readFile ?? ((file) => fs.readFileSync(file, "utf8"));
  const warn = deps.warn ?? ((msg) => console.warn(msg));
  const detect = deps.detect ?? detectJobPost;
  const records = [];
  for (const file of listFiles(dir)) {
    const exported = parseExport(file, readFile, warn);
    if (exported) records.push(...extractJobs(exported, detect));
  }
  return records;
}

/** @returns {string} Discord message permalink */
export function discordPermalink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// ---------------------------------------------------------------- private helpers
function defaultListFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json")).sort().map((f) => path.join(dir, f))
    .filter((file) => isPlainSmallFile(file));
}

/** Symlinks are skipped (they could point outside data/discord) and oversize files are not loaded. */
function isPlainSmallFile(file) {
  const stat = fs.lstatSync(file);
  return stat.isFile() && stat.size <= MAX_EXPORT_BYTES;
}

function parseExport(file, readFile, warn) {
  try {
    const data = JSON.parse(readFile(file));
    if (!data?.channel?.id || !Array.isArray(data.messages)) throw new Error("not a DiscordChatExporter JSON export");
    if (isDirectMessageExport(data)) throw new Error("direct-message exports are private and never read");
    return data;
  } catch (err) {
    warn(`discord: skipped ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

/** DMs export with a Direct* channel type and guild id "0"; they are private, not shared postings. */
function isDirectMessageExport({ guild, channel }) {
  return String(channel.type ?? "").startsWith("Direct") || !guild?.id || String(guild.id) === "0";
}

function extractJobs({ guild, channel, messages }, detect) {
  const records = [];
  const label = channelLabel(guild, channel);
  for (const message of messages) {
    if (!POSTING_MESSAGE_TYPES.has(message.type ?? "Default")) continue;
    const text = messageText(message);
    const found = detect({ text, channel: channel.name ?? "" });
    if (found.isJob) records.push(toJobRecord({ guild, channel, label, message, text, found }));
  }
  return records;
}

// Embeds carry the title/URL of link previews, which is often the whole posting.
function channelLabel(guild, channel) {
  const prefix = guild?.name ? `${guild.name} ` : "";
  return `${prefix}#${channel.name ?? channel.id}`;
}

function messageText(message) {
  const embeds = (message.embeds ?? []).flatMap((e) => [e.title, e.description, e.url]);
  return [message.content, ...embeds].filter(Boolean).join("\n");
}

function toJobRecord({ guild, channel, label, message, text, found }) {
  const guildId = guild.id;
  return makeRecord("job", name, `discord:message:${channel.id}:${message.id}`, {
    title: found.title ?? stripChatMarkup(text).slice(0, 80),
    company: found.company, location: found.location, link: safeHttpsLink(found.link),
    postedAt: message.timestamp ?? null, channel: label,
    permalink: discordPermalink(guildId, channel.id, message.id),
    snippet: stripChatMarkup(text).slice(0, SNIPPET_CHARS),
  });
}
