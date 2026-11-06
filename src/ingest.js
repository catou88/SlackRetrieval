// Pulls every message you can see in the Slack workspace (public + private
// channels, DMs, group DMs, and thread replies) plus the profiles of everyone
// who posted, and saves them to data/messages.json and data/users.json.
//
// Re-running is incremental: it only fetches messages newer than the last run.
import { WebClient } from "@slack/web-api";
import fs from "node:fs";
import path from "node:path";
import { readJSON, writeJSON, dataPath } from "./store.js";
import { extractLinkedIn, extractUrls } from "./people.js";

const TYPES = "public_channel,private_channel,mpim,im";

// Saves every shared file/image and every profile photo under data/files and
// data/avatars, so they survive after you lose access to the workspace.
function cookieHeader() {
  let c = (process.env.SLACK_COOKIE || "").trim().replace(/^d=/, "");
  if (!c) return {};
  if (!c.includes("%")) c = encodeURIComponent(c); // Slack expects the URL-encoded value
  return { Cookie: `d=${c}` };
}
const authHeaders = (token) => ({ Authorization: `Bearer ${token}`, ...cookieHeader() });

async function downloadAll({ token, messages, users, log }) {
  const filesDir = dataPath("files");
  const avatarDir = dataPath("avatars");
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(avatarDir, { recursive: true });

  const all = messages.flatMap((m) => m.files || []).filter((f) => f.url);
  const todo = all.filter((f) => !fs.existsSync(path.join(filesDir, localFileName(f))));
  log(`Downloading ${todo.length} files (${all.length - todo.length} already saved)…`);
  let ok = 0;
  for (const f of todo) {
    try {
      const res = await fetch(f.url, { headers: authHeaders(token) });
      const type = res.headers.get("content-type") || "";
      // Slack answers with its HTML login page when the token lacks files:read.
      const loginPage = type.includes("text/html") && !f.mimetype.includes("html");
      if (loginPage || res.status === 401 || res.status === 403) {
        log("  Can't download files: add the files:read scope to the app, reinstall, and update SLACK_USER_TOKEN.");
        break;
      }
      if (!res.ok) continue; // deleted or unavailable file
      fs.writeFileSync(path.join(filesDir, localFileName(f)), Buffer.from(await res.arrayBuffer()));
      ok++;
    } catch (err) {
      log(`  ${f.name}: ${err.message}`);
    }
  }
  if (todo.length) log(`  saved ${ok}/${todo.length} files to data/files/`);

  let av = 0;
  for (const u of Object.values(users)) {
    const out = path.join(avatarDir, `${u.id}.jpg`);
    if (!u.avatar || fs.existsSync(out)) continue;
    try {
      const res = await fetch(u.avatar);
      if (res.ok) fs.writeFileSync(out, Buffer.from(await res.arrayBuffer())), av++;
    } catch {}
  }
  if (av) log(`  saved ${av} profile photos to data/avatars/`);
}

export function localFileName(f) {
  return `${f.id}_${f.name.replace(/[^\w.\-]+/g, "_")}`.slice(0, 150);
}

export async function ingest({ token, onlyMember = true, downloadFiles = true, full = false, log = console.log }) {
  if (!token || token.includes("your-token"))
    throw new Error("Put your real token in .env as SLACK_USER_TOKEN (see README).");
  if (token.startsWith("xoxc-") && !process.env.SLACK_COOKIE)
    throw new Error("xoxc- tokens also need SLACK_COOKIE (the d cookie, starts with xoxd-) in .env.");
  // Browser-session tokens (xoxc-) also need the d cookie from the same session.
  const slack = new WebClient(token, { retryConfig: { retries: 10 }, headers: cookieHeader() });

  const auth = await slack.auth.test();
  log(`Connected to workspace "${auth.team}" as ${auth.user} (${auth.user_id})`);

  const state = readJSON("state.json", { latestTs: {} });
  state.me = auth.user_id;
  state.team = auth.team;
  state.teamUrl = auth.url;

  const byId = new Map(readJSON("messages.json", []).map((m) => [m.id, m]));
  const users = readJSON("users.json", {});

  // ---- users (directory) -------------------------------------------------
  log("Fetching user directory…");
  for await (const page of slack.paginate("users.list", { limit: 200 })) {
    for (const u of page.members || []) {
      if (u.deleted) continue;
      users[u.id] = {
        ...(users[u.id] || {}),
        id: u.id,
        handle: u.name,
        name: u.profile?.real_name || u.real_name || u.name,
        display_name: u.profile?.display_name || "",
        title: u.profile?.title || "",
        email: u.profile?.email || "",
        timezone: u.tz || "",
        is_bot: !!u.is_bot || u.id === "USLACKBOT",
        is_admin: !!u.is_admin,
        avatar: u.profile?.image_192 || "",
      };
    }
  }
  const nameOf = (id) => users[id]?.name || id;

  // ---- conversations -------------------------------------------------------
  const convs = [];
  for await (const page of slack.paginate("users.conversations", {
    types: TYPES,
    exclude_archived: false,
    limit: 200,
  })) {
    convs.push(...(page.channels || []));
  }
  if (!onlyMember) {
    // Also read public channels you haven't joined (Slack allows history on
    // public channels for user tokens with channels:history).
    const seen = new Set(convs.map((c) => c.id));
    for await (const page of slack.paginate("conversations.list", {
      types: "public_channel",
      exclude_archived: false,
      limit: 200,
    })) {
      for (const c of page.channels || []) if (!seen.has(c.id)) convs.push(c);
    }
  }
  log(`Found ${convs.length} conversations.`);

  const convName = (c) => {
    if (c.is_im) return `DM with ${nameOf(c.user)}`;
    if (c.is_mpim) return `group DM (${c.name})`;
    return `#${c.name}`;
  };
  const convType = (c) =>
    c.is_im ? "im" : c.is_mpim ? "mpim" : c.is_private ? "private" : "public";

  const resolveText = (text = "") =>
    text
      .replace(/<@([UW][A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => `@${nameOf(id)}`)
      .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
      .replace(/<!(here|channel|everyone)>/g, "@$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");

  const toRecord = (c, m) => {
    const files = (m.files || []).map((f) => f.title || f.name).filter(Boolean);
    const attachments = (m.attachments || [])
      .map((a) => [a.title, a.text, a.from_url].filter(Boolean).join(" — "))
      .filter(Boolean);
    let text = resolveText(m.text);
    if (files.length) text += `\n[files: ${files.join(", ")}]`;
    if (attachments.length) text += `\n[links: ${attachments.join(" | ")}]`;
    const userId = m.user || m.bot_id || "unknown";
    return {
      id: `${c.id}:${m.ts}`,
      channel_id: c.id,
      channel: convName(c),
      channel_type: convType(c),
      dm_with: c.is_im ? c.user : undefined,
      ts: m.ts,
      date: new Date(Number(m.ts) * 1000).toISOString(),
      user_id: userId,
      user_name: m.user ? nameOf(m.user) : m.username || m.bot_profile?.name || "bot",
      text,
      thread_ts: m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : undefined,
      reply_count: m.reply_count || 0,
      raw_urls: extractUrls(m.text || ""),
      files: (m.files || [])
        .filter((f) => f.id && f.mode !== "tombstone")
        .map((f) => ({
          id: f.id,
          name: f.name || f.title || f.id,
          title: f.title || "",
          mimetype: f.mimetype || "",
          size: f.size || 0,
          url: f.url_private_download || f.url_private || "",
          permalink: f.permalink || "",
        })),
      reactions: (m.reactions || []).map((r) => ({ name: r.name, count: r.count, users: r.users || [] })),
      // Full original Slack payload so nothing is lost even if a field isn't used yet.
      raw: m,
    };
  };

  let added = 0;
  const saveProgress = () => {
    writeJSON("messages.json", [...byId.values()].sort((a, b) => Number(a.ts) - Number(b.ts)));
    writeJSON("users.json", users);
    writeJSON("state.json", state);
  };
  for (const [i, c] of convs.entries()) {
    if (i > 0 && i % 10 === 0) saveProgress();
    const label = convName(c);
    // --full re-reads everything (catches new replies to old threads).
    const oldest = full ? undefined : state.latestTs[c.id];
    let count = 0;
    const threads = [];
    try {
      for await (const page of slack.paginate("conversations.history", {
        channel: c.id,
        limit: 200,
        ...(oldest ? { oldest } : {}),
      })) {
        for (const m of page.messages || []) {
          if (m.subtype === "channel_join" || m.subtype === "channel_leave") continue;
          const rec = toRecord(c, m);
          if (!byId.has(rec.id)) added++;
          byId.set(rec.id, rec);
          count++;
          if (m.reply_count) threads.push(m.ts);
          if (!state.latestTs[c.id] || Number(m.ts) > Number(state.latestTs[c.id]))
            state.latestTs[c.id] = m.ts;
        }
      }
      for (const ts of threads) {
        for await (const page of slack.paginate("conversations.replies", {
          channel: c.id,
          ts,
          limit: 200,
        })) {
          for (const m of page.messages || []) {
            if (m.ts === ts) continue;
            const rec = toRecord(c, m);
            if (!byId.has(rec.id)) added++;
            byId.set(rec.id, rec);
            count++;
          }
        }
      }
      log(`  ${label}: ${count} new messages${threads.length ? ` (${threads.length} threads)` : ""}`);
    } catch (err) {
      log(`  ${label}: skipped (${err.data?.error || err.message})`);
    }
  }

  // ---- custom profile fields (LinkedIn often lives here) -------------------
  const posters = new Set([...byId.values()].map((m) => m.user_id));
  const dmPartners = new Set([...byId.values()].map((m) => m.dm_with).filter(Boolean));
  const needProfile = [...new Set([...posters, ...dmPartners])].filter(
    (id) => users[id] && !users[id].is_bot && !users[id].profile_fetched
  );
  log(`Fetching detailed profiles for ${needProfile.length} people…`);
  for (const id of needProfile) {
    try {
      const { profile } = await slack.users.profile.get({ user: id });
      const fields = Object.values(profile?.fields || {}).map((f) => ({
        label: f.label || "",
        value: f.value || "",
        alt: f.alt || "",
      }));
      users[id].profile_fields = fields;
      users[id].status = profile?.status_text || "";
      users[id].pronouns = profile?.pronouns || "";
      users[id].profile_fetched = true;
      const fromProfile = extractLinkedIn(
        [profile?.title, profile?.status_text, ...fields.map((f) => `${f.value} ${f.alt}`)].join(" ")
      );
      if (fromProfile.length) users[id].linkedin_from_profile = fromProfile;
    } catch (err) {
      if (err.data?.error === "missing_scope") {
        log("  (no users.profile:read scope — skipping custom profile fields)");
        break;
      }
    }
  }

  const messages = [...byId.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  writeJSON("messages.json", messages);
  writeJSON("users.json", users);
  writeJSON(
    "channels.json",
    convs.map((c) => ({
      id: c.id,
      name: convName(c),
      type: convType(c),
      dm_with: c.is_im ? c.user : null,
      topic: c.topic?.value || "",
      purpose: c.purpose?.value || "",
      created: c.created || 0,
      is_archived: !!c.is_archived,
    }))
  );
  writeJSON("state.json", state);

  if (downloadFiles) await downloadAll({ token, messages, users, log });
  log(`Saved ${messages.length} messages (${added} new) and ${Object.keys(users).length} users to data/.`);
  return { messages, users, state };
}
