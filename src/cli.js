#!/usr/bin/env node
// Usage:
//   node src/cli.js sync                      # ingest Slack + build contacts + index
//   node src/cli.js ask "who offered to review my resume?" [--person "Jane"] [--mentors]
//   node src/cli.js search "react native auth" [--k 10]
//   node src/cli.js people [--mentors] [--linkedin]
//   node src/cli.js brief "Jane Doe" [--goal "ask about internships"]
//   node src/cli.js export                    # contacts.csv for spreadsheets
//   node src/cli.js serve                     # local website at http://localhost:3000
//   node src/cli.js backup [--to D:\]         # zip everything in data/
import "dotenv/config";
import fs from "node:fs";
import { ingest } from "./ingest.js";
import { buildPeople } from "./people.js";
import { buildIndex, search } from "./vectors.js";
import { ask, brief } from "./rag.js";
import { readJSON, dataPath, DATA_DIR } from "./store.js";
import { rebuildDb, openDb } from "./db.js";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ingestOpts = () => ({
  token: process.env.SLACK_USER_TOKEN,
  onlyMember: !flags.all,
  full: !!flags.full,
  downloadFiles: !flags["no-files"],
});

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith("--")) {
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) (flags[key] = next), i++;
    else flags[key] = true;
  } else positional.push(rest[i]);
}
const text = positional.join(" ");

async function main() {
  switch (cmd) {
    case "ingest":
      await ingest(ingestOpts());
      break;
    case "people:build":
      buildPeople();
      rebuildDb();
      break;
    case "index":
      await buildIndex();
      break;
    case "db":
      rebuildDb();
      break;
    case "sync":
      await ingest(ingestOpts());
      buildPeople();
      try {
        await buildIndex();
        const { categorize } = await import("./categorize.js");
        await categorize();
      } catch (err) {
        // Messages are already safely saved; search + collections can be built later.
        console.error(`Index/collections failed (${err.message}). Your data is saved; retry with: npm run categorize`);
      }
      rebuildDb();
      break;
    case "categorize": {
      // Re-sort networking collections (after tuning) and refresh the website DB.
      buildPeople();
      await buildIndex();
      const { categorize } = await import("./categorize.js");
      await categorize();
      rebuildDb();
      break;
    }
    case "pg": {
      // Organise the networking messages into pgvector (Docker).
      const { categorize } = await import("./categorize.js");
      const { pgUp, pgLoad, pgDump } = await import("./pg.js");
      await categorize();
      await pgUp();
      await pgLoad();
      pgDump();
      break;
    }
    case "collection": {
      // linkedin-directory | mentors | offers | linkedin | mentor_intro | offer
      const { pgCollection } = await import("./pg.js");
      const rows = await pgCollection(text || "linkedin-directory");
      for (const r of rows) {
        const who = [r.name || r.user_name, r.title].filter(Boolean).join(" — ");
        const link = Array.isArray(r.linkedin) ? r.linkedin.join(" ") : r.linkedin || "";
        console.log(`\n${who}  ${link}`.trimEnd());
        if (r.introduction || r.text) console.log("  " + (r.introduction || r.text).replace(/\n/g, " ").slice(0, 400));
      }
      console.log(`\n${rows.length} rows`);
      break;
    }
    case "pg:search": {
      const { pgSearch } = await import("./pg.js");
      for (const r of await pgSearch(text, { collection: flags.in, k: Number(flags.k) || 15 }))
        console.log(`${r.score.toFixed(3)} [${r.collections.join(",")}] ${r.channel} — ${r.user_name}: ${r.text.replace(/\n/g, " ").slice(0, 200)}`);
      break;
    }
    case "serve":
      await import("./server.js");
      return;
    case "backup": {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const out = path.resolve(flags.to || ".", `slack-backup-${stamp}.zip`);
      // Windows 10+ ships bsdtar, which can write zip files.
      // Flush the database write-ahead log so the copy is complete.
      openDb().pragma("wal_checkpoint(TRUNCATE)");
      const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\Windows", "System32", "tar.exe") : "tar";
      execFileSync(tar, ["-a", "-c", "-f", out, "-C", path.dirname(DATA_DIR), path.basename(DATA_DIR)], { stdio: "inherit" });
      console.log(`Backed up ${DATA_DIR} → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
      break;
    }

    case "search": {
      const byId = new Map(readJSON("messages.json", []).map((m) => [m.id, m]));
      for (const h of await search(text, { k: Number(flags.k) || 10 })) {
        const m = byId.get(h.id);
        console.log(`${h.score.toFixed(3)}  ${m.date.slice(0, 10)} ${m.channel} — ${m.user_name}: ${m.text.slice(0, 200).replace(/\n/g, " ")}`);
      }
      break;
    }
    case "ask": {
      if (!text) throw new Error('Usage: ask "your question"');
      const { answer, hits } = await ask(text, { person: flags.person, mentorsOnly: !!flags.mentors });
      console.log(answer);
      if (flags.sources) {
        console.log("\n--- sources ---");
        for (const h of hits) console.log(`${h.score.toFixed(3)} ${h.message.channel} ${h.message.user_name}: ${h.message.text.slice(0, 120)}`);
      }
      break;
    }
    case "brief": {
      if (!text) throw new Error('Usage: brief "Person Name" [--goal "..."]');
      const { person, answer, directCount } = await brief(text, { goal: flags.goal || "" });
      console.log(`# ${person.name}  (${directCount} direct messages found)\n`);
      console.log(answer);
      const out = dataPath(`briefs/${person.name.replace(/[^\w-]+/g, "_")}.md`);
      fs.mkdirSync(dataPath("briefs"), { recursive: true });
      fs.writeFileSync(out, `# ${person.name}\n\n${answer}\n`);
      console.log(`\n(saved to ${out})`);
      break;
    }
    case "people": {
      const people = Object.values(readJSON("people.json", {}))
        .filter((p) => !p.is_me)
        .filter((p) => !flags.mentors || p.is_mentor)
        .filter((p) => !flags.linkedin || p.linkedin.length)
        .sort((a, b) => b.dm_count - a.dm_count || b.message_count - a.message_count);
      for (const p of people) {
        const tags = [p.roles.join("/"), p.dm_count ? `${p.dm_count} DMs` : ""].filter(Boolean).join(", ");
        console.log(`${p.name.padEnd(28)} ${(p.title || "").slice(0, 34).padEnd(34)} ${(p.linkedin[0] || "").padEnd(50)} ${tags}`);
      }
      console.log(`\n${people.length} people`);
      break;
    }
    case "export": {
      const people = Object.values(readJSON("people.json", {})).filter((p) => !p.is_me);
      const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const rows = [
        ["name", "handle", "title", "roles", "linkedin", "other_links", "email", "dm_count", "message_count", "last_seen", "channels"],
        ...people.map((p) => [p.name, p.handle, p.title, p.roles.join("; "), p.linkedin.join(" "), p.other_links.join(" "), p.email, p.dm_count, p.message_count, p.last_seen, p.channels.join("; ")]),
      ];
      fs.writeFileSync(dataPath("contacts.csv"), rows.map((r) => r.map(esc).join(",")).join("\n"));
      console.log(`Wrote ${people.length} contacts to ${dataPath("contacts.csv")}`);
      break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 11).join("\n"));
  }
}

main().catch((err) => {
  console.error("Error:", err.data?.error || err.message);
  if (err.data?.needed) console.error(`Missing Slack scope: ${err.data.needed}`);
  process.exit(1);
});
