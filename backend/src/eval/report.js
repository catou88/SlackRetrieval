// Writes eval results: a dated Markdown report plus one appended row per metric
// in history.csv, so later sessions can see metric deltas over time.
import fs from "node:fs";
import path from "node:path";

const HISTORY_HEADER = "date,commit,suite,metric,value\n";

/**
 * @param {Record<string, Record<string, number | string>>} suites  suite name -> metric -> value
 * @param {{ dir: string, date: string, commit?: string, prefix?: string, historyName?: string }} meta
 * @returns {{ reportFile: string, historyFile: string }}
 */
export function writeEvalReport(suites, { dir, date, commit = "unknown", prefix = "intel-eval", historyName = "history.csv" }) {
  fs.mkdirSync(dir, { recursive: true });
  const reportFile = path.join(dir, `${prefix}-${date}.md`);
  const historyFile = path.join(dir, historyName);
  fs.writeFileSync(reportFile, renderMarkdown(suites, date, commit));
  appendHistory(historyFile, suites, date, commit);
  return { reportFile, historyFile };
}

/** @returns {{ metric: string, previous: number, current: number }[]} history rows for one suite, last two values per metric */
export function metricDeltas(historyFile, suite) {
  if (!fs.existsSync(historyFile)) return [];
  const byMetric = new Map();
  for (const line of fs.readFileSync(historyFile, "utf8").split("\n").slice(1)) {
    const [, , rowSuite, metric, value] = line.split(",");
    if (rowSuite !== suite || value === undefined || Number.isNaN(Number(value))) continue;
    byMetric.set(metric, [...(byMetric.get(metric) ?? []), Number(value)].slice(-2));
  }
  return [...byMetric].filter(([, v]) => v.length === 2).map(([metric, [previous, current]]) => ({ metric, previous, current }));
}

// ---------------------------------------------------------------- private helpers
function renderMarkdown(suites, date, commit) {
  const lines = [`# Intel eval ${date}`, "", `Commit: ${commit}`, ""];
  for (const [suite, metrics] of Object.entries(suites)) {
    lines.push(`## ${suite}`, "", "| metric | value |", "|---|---|");
    for (const [metric, value] of Object.entries(metrics)) lines.push(`| ${metric} | ${value} |`);
    lines.push("");
  }
  return lines.join("\n");
}

function appendHistory(historyFile, suites, date, commit) {
  if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, HISTORY_HEADER);
  const rows = Object.entries(suites).flatMap(([suite, metrics]) =>
    Object.entries(metrics).map(([metric, value]) => `${date},${commit},${suite},${metric},${value}`));
  fs.appendFileSync(historyFile, rows.join("\n") + "\n");
}
