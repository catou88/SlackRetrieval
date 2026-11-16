#!/usr/bin/env node
// Builds data/eval/review.html: a single self-contained page (data inline, no
// network, works from file://) for reviewing Claude's gold labels.
//
//   node backend/scripts/eval/build-review.js [--labels data/eval/labels.claude.json] [--out data/eval/review.html]
//
// The output contains message text, so it stays under data/ (git-ignored).
import fs from "node:fs";
import path from "node:path";
import { ROOT, EVAL_DIR, CLASSES, loadHeldout, readJSONFile } from "./common.js";

const argv = process.argv.slice(2);
const opt = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const labelsFile = path.resolve(ROOT, opt("labels", path.join(EVAL_DIR, "labels.claude.json")));
const outFile = path.resolve(ROOT, opt("out", path.join(EVAL_DIR, "review.html")));

const heldout = loadHeldout();
const labels = readJSONFile(labelsFile);
const items = heldout.items.map((x) => {
  const l = labels.items[x.id] || { labels: ["none"], confidence: "unsure", rationale: "(no Claude label)" };
  return {
    id: x.id,
    split: x.split,
    channel: x.channel,
    date: x.date,
    author: x.author,
    roles: x.author_roles,
    in_thread: x.in_thread,
    text: x.text,
    claude: { labels: l.labels, confidence: l.confidence, rationale: l.rationale },
    prediction: x.prediction,
  };
});
const payload = {
  key: `slack-eval-review:${heldout.meta.seed}:${heldout.meta.created}`,
  classes: CLASSES,
  meta: { ...labels.meta, heldout_seed: heldout.meta.seed, heldout_created: heldout.meta.created, source_labels: path.basename(labelsFile) },
  items,
};
// JSON inside <script type="application/json">: escape "<" so "</script>" in a message can't end the block.
const json = JSON.stringify(payload).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Label Review</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1f; --muted: #62646a; --border: #dcdcd8;
  --accent: #2f5bd3; --accent-weak: #e7edfb; --warn: #9a5b00; --warn-bg: #fff3dc;
  --ok: #1f7a3d; --ok-bg: #e3f4e8; --changed: #8a2fb3; --changed-bg: #f3e6fa; --focus: #2f5bd3;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141517; --panel: #1d1f22; --text: #e8e8e6; --muted: #a2a4a9; --border: #34373c;
    --accent: #8fb0ff; --accent-weak: #22304f; --warn: #f2c063; --warn-bg: #3a2e14;
    --ok: #7fd49a; --ok-bg: #173323; --changed: #d7a2f0; --changed-bg: #37224a; --focus: #8fb0ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--border); padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; }
header h1 { font-size: 16px; margin: 0 8px 0 0; }
.progress { flex: 1 1 200px; min-width: 160px; }
.bar { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin-top: 4px; }
.bar > div { height: 100%; background: var(--ok); width: 0; transition: width .2s; }
label.inline { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); font-size: 13px; }
select, button, input[type=text], textarea { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 5px 9px; }
button { cursor: pointer; }
button.primary { background: var(--accent); color: var(--panel); border-color: var(--accent); font-weight: 600; }
button.primary kbd { color: inherit; border-color: currentColor; opacity: .85; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
main { max-width: 900px; margin: 0 auto; padding: 16px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 13px; margin-bottom: 10px; }
.meta strong { color: var(--text); }
.chip { display: inline-block; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 20px; background: var(--accent-weak); color: var(--accent); }
.chip.warn { background: var(--warn-bg); color: var(--warn); }
.chip.ok { background: var(--ok-bg); color: var(--ok); }
.chip.changed { background: var(--changed-bg); color: var(--changed); }
.text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 15px; padding: 12px 14px; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); max-height: 50vh; overflow: auto; }
fieldset { border: 1px solid var(--border); border-radius: 8px; margin: 14px 0 0; padding: 10px 12px; }
legend { padding: 0 6px; font-weight: 600; font-size: 14px; }
.opts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px 12px; }
.opts label { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.opts label:hover { background: var(--bg); }
.opts input:checked + span { font-weight: 600; }
.opts label.claude { border-color: var(--border); }
kbd { font-family: var(--mono); font-size: 11px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; color: var(--muted); }
.rationale { margin-top: 10px; font-size: 14px; color: var(--muted); }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
.row .grow { flex: 1 1 260px; }
.row input[type=text] { width: 100%; }
.nav { display: flex; gap: 8px; justify-content: space-between; margin-top: 14px; flex-wrap: wrap; }
.pred { margin-top: 12px; font-size: 13px; border-top: 1px dashed var(--border); padding-top: 10px; }
.pred table { border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
.pred td, .pred th { padding: 2px 10px 2px 0; text-align: left; }
.help { color: var(--muted); font-size: 12.5px; margin-top: 16px; }
.empty { padding: 40px; text-align: center; color: var(--muted); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
</head>
<body>
<header>
  <h1>Label review</h1>
  <label class="inline">Show
    <select id="filter" aria-label="Filter messages">
      <option value="all">All messages</option>
      <option value="unsure">Claude-unsure first</option>
      <option value="unreviewed">Unreviewed only</option>
      <optgroup label="By class (current label)" id="classOpts"></optgroup>
    </select>
  </label>
  <label class="inline"><input type="checkbox" id="showPred"> Show classifier prediction</label>
  <div class="progress" aria-live="polite"><span id="progress"></span><div class="bar" aria-hidden="true"><div id="bar"></div></div></div>
  <button id="importBtn" type="button">Import…</button>
  <input id="importFile" type="file" accept="application/json,.json" class="sr" tabindex="-1" aria-hidden="true">
  <button id="export" class="primary" type="button">Export reviewed labels</button>
</header>
<main>
  <div id="card" class="card" aria-live="polite"></div>
  <p class="help">
    Keys: <kbd>1</kbd>–<kbd>5</kbd> toggle a class · <kbd>0</kbd> none · <kbd>Enter</kbd>/<kbd>J</kbd> confirm &amp; next ·
    <kbd>K</kbd> previous · <kbd>U</kbd> toggle unsure. Confirming marks the message reviewed. Progress saves in this browser automatically;
    use Export to get <code>labels.reviewed.json</code>, then run <code>node backend/scripts/eval/import-review.js &lt;file&gt;</code>.
    Definitions: <code>scripts/eval/LABELING_GUIDE.md</code>.
  </p>
</main>
<script type="application/json" id="data">${json}</script>
<script>
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var CLASSES = DATA.classes;
  var NAMES = { linkedin: "LinkedIn share", mentor_intro: "Mentor / judge intro", offer: "Offer of help", sponsor_opportunity: "Sponsor opportunity", teammate: "Teammate search", none: "None" };
  var byId = {};
  DATA.items.forEach(function (it) { byId[it.id] = it; });

  // ---- state (autosaved) ----
  var state = { review: {}, pos: 0, filter: "all", showPred: false };
  function load() {
    try {
      var raw = window.localStorage.getItem(DATA.key);
      if (raw) { var s = JSON.parse(raw); if (s && s.review) state = Object.assign(state, s); }
    } catch (e) { /* storage unavailable: work in memory */ }
  }
  function save() {
    try { window.localStorage.setItem(DATA.key, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function rec(id) {
    var r = state.review[id];
    if (!r) {
      var c = byId[id].claude;
      r = { labels: c.labels.slice(), confidence: c.confidence, note: "", reviewed: false };
    }
    return r;
  }
  function setRec(id, r) { state.review[id] = r; save(); }
  function norm(list) {
    var s = list.filter(function (l) { return CLASSES.indexOf(l) >= 0; });
    return s.length ? CLASSES.filter(function (c) { return s.indexOf(c) >= 0; }) : ["none"];
  }
  function changed(id) {
    var a = norm(rec(id).labels).join(","), b = norm(byId[id].claude.labels).join(",");
    return a !== b;
  }

  // ---- ordering / filters ----
  function order() {
    var f = state.filter, list = DATA.items.slice();
    if (f === "unsure") {
      list.sort(function (a, b) { return (a.claude.confidence === "unsure" ? 0 : 1) - (b.claude.confidence === "unsure" ? 0 : 1); });
    } else if (f === "unreviewed") {
      list = list.filter(function (it) { return !rec(it.id).reviewed; });
    } else if (f.indexOf("class:") === 0) {
      var c = f.slice(6);
      list = list.filter(function (it) { return norm(rec(it.id).labels).indexOf(c) >= 0 || norm(it.claude.labels).indexOf(c) >= 0; });
    }
    return list;
  }
  var view = [];

  // ---- rendering ----
  var card = document.getElementById("card");
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { if (k) n.appendChild(typeof k === "string" ? document.createTextNode(k) : k); });
    return n;
  }
  function roleText(r) {
    var out = [];
    if (r.is_mentor) out.push("mentor");
    if (r.judge) out.push("judge");
    if (r.sponsor) out.push("sponsor");
    if (r.organizer) out.push("organizer");
    if (r.org) out.push("org: " + r.org);
    return out.length ? out.join(" · ") : "no role";
  }
  function render(focusSel) {
    view = order();
    var reviewed = DATA.items.filter(function (it) { return rec(it.id).reviewed; }).length;
    var nChanged = DATA.items.filter(function (it) { return rec(it.id).reviewed && changed(it.id); }).length;
    document.getElementById("progress").textContent = reviewed + " / " + DATA.items.length + " reviewed · " + nChanged + " changed" +
      (view.length ? " · showing " + (Math.min(state.pos, view.length - 1) + 1) + " of " + view.length : "");
    document.getElementById("bar").style.width = (100 * reviewed / DATA.items.length) + "%";
    document.getElementById("filter").value = state.filter;
    document.getElementById("showPred").checked = !!state.showPred;
    card.textContent = "";
    if (!view.length) { card.appendChild(el("div", { class: "empty", text: "Nothing to show for this filter." })); return; }
    if (state.pos >= view.length) state.pos = view.length - 1;
    if (state.pos < 0) state.pos = 0;
    var it = view[state.pos], r = rec(it.id), cur = norm(r.labels), claude = norm(it.claude.labels);

    var chips = [el("span", { class: "chip", text: it.split })];
    if (it.claude.confidence === "unsure") chips.push(el("span", { class: "chip warn", text: "Claude unsure" }));
    if (r.confidence === "unsure") chips.push(el("span", { class: "chip warn", text: "you: unsure" }));
    if (r.reviewed) chips.push(el("span", { class: "chip ok", text: "reviewed" }));
    if (changed(it.id)) chips.push(el("span", { class: "chip changed", text: "changed" }));
    card.appendChild(el("div", { class: "meta" }, [
      el("span", null, [el("strong", { text: it.channel })]),
      el("span", { text: new Date(it.date).toLocaleString() }),
      el("span", null, [el("strong", { text: it.author }), " — " + roleText(it.roles)]),
      it.in_thread ? el("span", { text: "thread reply" }) : null,
    ].concat(chips)));
    card.appendChild(el("div", { class: "text", tabindex: "0", "aria-label": "Message text", text: it.text }));

    var fs = el("fieldset", null, [el("legend", { text: "Labels" })]);
    var grid = el("div", { class: "opts" });
    CLASSES.concat(["none"]).forEach(function (c, i) {
      var key = c === "none" ? "0" : String(i + 1);
      var id = "opt-" + c;
      var box = el("input", { type: "checkbox", id: id, "data-class": c });
      box.checked = cur.indexOf(c) >= 0;
      box.addEventListener("change", function () { toggle(c); });
      var lab = el("label", { for: id, class: claude.indexOf(c) >= 0 ? "claude" : "", title: claude.indexOf(c) >= 0 ? "Claude chose this" : "" },
        [box, el("span", { text: NAMES[c] }), " ", el("kbd", { text: key })]);
      grid.appendChild(lab);
    });
    fs.appendChild(grid);
    card.appendChild(fs);
    card.appendChild(el("div", { class: "rationale" }, [
      el("strong", { text: "Claude: " }), claude.map(function (c) { return NAMES[c]; }).join(", ") +
      " (" + it.claude.confidence + ") — " + (it.claude.rationale || ""),
    ]));

    var note = el("input", { type: "text", id: "note", placeholder: "Optional note (why you changed it)", "aria-label": "Note" });
    note.value = r.note || "";
    note.addEventListener("input", function () { var x = rec(it.id); x.note = note.value; setRec(it.id, x); });
    var unsure = el("input", { type: "checkbox", id: "unsure" });
    unsure.checked = r.confidence === "unsure";
    unsure.addEventListener("change", function () { toggleUnsure(); });
    card.appendChild(el("div", { class: "row" }, [
      el("label", { class: "inline", for: "unsure" }, [unsure, "Unsure ", el("kbd", { text: "U" })]),
      el("div", { class: "grow" }, [note]),
    ]));

    var prev = el("button", { type: "button", id: "prev" }, ["← Previous ", el("kbd", { text: "K" })]);
    prev.disabled = state.pos === 0;
    prev.addEventListener("click", function () { go(-1); });
    var next = el("button", { type: "button", id: "next", class: "primary" }, ["Confirm & next → ", el("kbd", { text: "Enter" })]);
    next.addEventListener("click", function () { confirmNext(); });
    card.appendChild(el("div", { class: "nav" }, [prev, el("span", { class: "meta", text: it.id }), next]));

    if (state.showPred) {
      var p = it.prediction || {}, rows = [el("tr", null, [el("th", { text: "class" }), el("th", { text: "pred" }), el("th", { text: "sim" }), el("th", { text: "conf" })])];
      CLASSES.forEach(function (c) {
        var s = p.scores && p.scores[c];
        rows.push(el("tr", null, [el("td", { text: c }), el("td", { text: (p.collections || []).indexOf(c) >= 0 ? "yes" : "·" }),
          el("td", { text: s == null ? "rule" : s.toFixed(3) }), el("td", { text: (p.confidence || {})[c] || "" })]));
      });
      card.appendChild(el("div", { class: "pred" }, [
        el("div", { text: "Classifier: " + ((p.collections || []).join(", ") || "none") + (p.mention ? " · keyword 'mention' flag" : "") +
          " · threshold " + p.threshold + " · sampled as " + p.stratum }),
        el("table", null, rows),
      ]));
    }
    var target = focusSel && card.querySelector(focusSel);
    if (target) target.focus();
    save();
  }

  // ---- actions ----
  function current() { return view[state.pos]; }
  function toggle(c) {
    var it = current(); if (!it) return;
    var r = rec(it.id), cur = norm(r.labels);
    if (c === "none") cur = ["none"];
    else {
      cur = cur.filter(function (x) { return x !== "none"; });
      var i = cur.indexOf(c);
      if (i >= 0) cur.splice(i, 1); else cur.push(c);
    }
    r.labels = norm(cur);
    setRec(it.id, r);
    render("#opt-" + c);
  }
  function toggleUnsure() {
    var it = current(); if (!it) return;
    var r = rec(it.id);
    r.confidence = r.confidence === "unsure" ? "sure" : "unsure";
    setRec(it.id, r);
    render("#unsure");
  }
  function confirmNext() {
    var it = current(); if (!it) return;
    var r = rec(it.id); r.reviewed = true; setRec(it.id, r);
    if (state.filter === "unreviewed") { render("#next"); return; } // item drops out; same index shows the next one
    go(1);
  }
  function go(d) {
    state.pos = Math.max(0, Math.min(view.length - 1, state.pos + d));
    render(d < 0 ? "#prev" : "#next");
  }

  // ---- export / import ----
  function exportJSON() {
    var items = {};
    DATA.items.forEach(function (it) {
      var r = rec(it.id);
      items[it.id] = { labels: norm(r.labels), confidence: r.confidence, rationale: it.claude.rationale || "",
        note: r.note || "", reviewed: !!r.reviewed, changed: changed(it.id), claude_labels: norm(it.claude.labels) };
    });
    var reviewedN = DATA.items.filter(function (it) { return rec(it.id).reviewed; }).length;
    var out = { meta: Object.assign({}, DATA.meta, { labeler: "human-reviewed (from claude)", reviewed: true, exported: new Date().toISOString(),
      reviewed_count: reviewedN, total: DATA.items.length }), items: items };
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "labels.reviewed.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function importJSON(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(fr.result), n = 0;
        Object.keys(data.items || {}).forEach(function (id) {
          if (!byId[id]) return;
          var x = data.items[id];
          state.review[id] = { labels: norm(x.labels || []), confidence: x.confidence || "sure", note: x.note || "", reviewed: !!x.reviewed };
          n++;
        });
        save(); render();
        alert("Imported " + n + " items.");
      } catch (e) { alert("Could not read that file: " + e.message); }
    };
    fr.readAsText(file);
  }

  // ---- wiring ----
  var classOpts = document.getElementById("classOpts");
  CLASSES.concat(["none"]).forEach(function (c) { classOpts.appendChild(el("option", { value: "class:" + c, text: NAMES[c] })); });
  document.getElementById("filter").addEventListener("change", function (e) { state.filter = e.target.value; state.pos = 0; render(); });
  document.getElementById("showPred").addEventListener("change", function (e) { state.showPred = e.target.checked; render(); });
  document.getElementById("export").addEventListener("click", exportJSON);
  document.getElementById("importBtn").addEventListener("click", function () { document.getElementById("importFile").click(); });
  document.getElementById("importFile").addEventListener("change", function (e) { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t && (t.tagName === "INPUT" && t.type === "text" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
      if (e.key === "Escape") t.blur();
      return;
    }
    var k = e.key.toLowerCase();
    if (k >= "1" && k <= String(CLASSES.length)) { toggle(CLASSES[Number(k) - 1]); e.preventDefault(); }
    else if (k === "0") { toggle("none"); e.preventDefault(); }
    else if (k === "enter" || k === "j") {
      if (k === "enter" && t && t.tagName === "BUTTON" && t.id !== "next") return; // let buttons activate normally
      confirmNext(); e.preventDefault();
    }
    else if (k === "k") { go(-1); e.preventDefault(); }
    else if (k === "u") { toggleUnsure(); e.preventDefault(); }
  });
  load();
  render();
})();
</script>
</body>
</html>
`;
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`Wrote ${path.relative(ROOT, outFile)} (${items.length} messages, labels from ${path.relative(ROOT, labelsFile)}, ${(html.length / 1024).toFixed(0)} KB)`);
