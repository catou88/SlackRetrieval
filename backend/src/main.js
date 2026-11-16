#!/usr/bin/env node
// CLI entry point (every `npm run …` script lands here). Loads .env first,
// applies the global cache switch, parses flags and runs one command from
// cli/commands.js. The only module with process-level side effects.
import "dotenv/config";
import { parseArgs } from "node:util";
import { CONFIG } from "./config.js";
import { setCacheEnabled } from "./lib/cache.js";
import { COMMANDS, USAGE } from "./cli/commands.js";

// Boolean flags never swallow the next word, so `ask --no-cache "q"` works.
const FLAG_OPTIONS = {
  person: { type: "string" }, goal: { type: "string" }, k: { type: "string" }, to: { type: "string" }, in: { type: "string" },
  mentors: { type: "boolean" }, linkedin: { type: "boolean" }, sources: { type: "boolean" },
  all: { type: "boolean" }, full: { type: "boolean" }, "no-files": { type: "boolean" },
  fresh: { type: "boolean" }, "no-cache": { type: "boolean" },
};

runCli(process.argv.slice(2)).catch(reportFailure);

// ---------------------------------------------------------------- private helpers
async function runCli([commandName, ...rest]) {
  const { values: flags, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: false, options: FLAG_OPTIONS });
  setCacheEnabled(CONFIG.cache.isEnabled && !flags["no-cache"]);
  const command = COMMANDS[commandName];
  if (!command) {
    console.log(USAGE);
    return;
  }
  await command({ text: positionals.join(" "), flags });
}

function reportFailure(err) {
  console.error("Error:", err.data?.error || err.message);
  if (err.data?.needed) console.error(`Missing Slack scope: ${err.data.needed}`);
  process.exit(1);
}
