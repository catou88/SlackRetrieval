// Shared components. All return html`` values (escaped by default).
import { html, raw, icon, NEWTAB, esc, num, date, time, dayKey, dayLabel, isoDate, plural } from "./html.js";
import { store, nameOf, cleanName, initials, chipsOf, stripOf, howMet, lineOf, liSlug, liSearch } from "./store.js";
import { render, splitExtras, emoji, shortUrl } from "./slack.js";
import { statusOf } from "./notes.js";

// ---------- avatar ----------
const HUES = ["stone", "indigo", "teal", "amber", "rose", "sky"];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export function avatar(p, size = 40, fallbackName) {
  const name = p ? nameOf(p) : cleanName(fallbackName);
  const kind = p ? stripOf(p) : "none";
  const hue = kind !== "none" && kind !== "likely" && kind !== "dual" ? `role-${kind}` : `hue-${HUES[hash(p?.id || name) % 6]}`;
  const mono = esc(initials(name));
  if (p?.has_avatar)
    return raw(`<span class="avatar avatar--${size} ${hue}" aria-hidden="true" data-i="${mono}"><img src="/avatars/${esc(p.id)}.jpg" width="${size}" height="${size}" loading="lazy" decoding="async" alt=""></span>`);
  return raw(`<span class="avatar avatar--${size} ${hue}" aria-hidden="true">${mono}</span>`);
}
// Broken avatar image → monogram (one capturing listener for the whole app).
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName === "IMG" && img.parentElement?.classList.contains("avatar")) img.parentElement.textContent = img.parentElement.dataset.i || "?";
}, true);

// ---------- chips ----------
export const chip = (c) =>
  c.kind === "likely"
    ? html`<span class="chip chip--likely" data-tip="${c.tip}">${c.label}</span>`
    : html`<span class="chip tint-${c.kind}" ${c.aria ? raw(`aria-label="${esc(c.aria)}"`) : ""}>${c.label}</span>`;
export function chips(p, max = 2, more = true) {
  const all = chipsOf(p);
  const shown = all.slice(0, max).map(chip);
  if (more && all.length > max) shown.push(html`<span class="chip chip--more" aria-label="${all.slice(max).map((c) => c.label).join(", ")}">+${all.length - max}</span>`);
  return shown;
}
export function statusChips(p) {
  const s = statusOf(p), out = [];
  if (s.contacted) out.push(html`<span class="chip tint-ok">${icon("check", "i i--12")}Contacted</span>`);
  if (s.followUp) out.push(html`<span class="chip ${s.due ? "tint-due" : "chip--quiet"}">Follow up · ${s.overdue ? "overdue" : isoDate(s.followUp)}</span>`);
  return out;
}

// ---------- LinkedIn buttons ----------
export function liButtons(p, { compact = false } = {}) {
  const n = nameOf(p);
  if (!p.linkedin?.length)
    return html`<a class="btn btn--icon btn--ghost" href="${liSearch(p)}" target="_blank" rel="noreferrer" aria-label="Search LinkedIn for ${n}" data-tip="Search LinkedIn for ${n}">${icon("search")}</a>`;
  const u = p.linkedin[0];
  return html`<a class="btn btn--icon ${compact ? "btn--ghost" : "btn--li"}" href="${u}" target="_blank" rel="noreferrer" aria-label="Open ${n}'s LinkedIn" data-tip="in/${liSlug(u)}">${icon("linkedin")}</a>
    <button class="btn btn--icon btn--ghost" type="button" data-copy="${u}" data-copy-msg="Copied LinkedIn link" aria-label="Copy ${n}'s LinkedIn link" data-tip="Copy link">${icon("copy")}</button>`;
}

// ---------- Name Tag badge ----------
export function badge(p, { reason = "", tilt = false } = {}) {
  const st = statusOf(p);
  const line = lineOf(p);
  return html`<article class="badge${tilt ? " badge--tilt" : ""}" data-strip="${stripOf(p)}" ${st.contacted ? raw("data-contacted") : ""}>
    <span class="badge__strip" aria-hidden="true"></span><span class="badge__slot" aria-hidden="true"></span>
    ${avatar(p, 56)}
    <h3 class="badge__name"><a href="#/people/${p.id}">${nameOf(p)}</a></h3>
    ${line ? html`<p class="badge__line">${line}</p>` : ""}
    <div class="badge__chips">${chips(p)}${st.contacted ? html`<span class="chip tint-ok">${icon("check", "i i--12")}Contacted</span>` : ""}</div>
    ${reason ? html`<p class="badge__reason">${reason}</p>` : ""}
    <div class="badge__actions">${liButtons(p, { compact: true })}</div>
    <footer class="badge__meta">${howMet(p) || "—"}</footer>
  </article>`;
}

// Compact row for Home lanes: avatar 28 + name + chip + LinkedIn icon.
export function miniRow(p, sub, { chip: showChip = true } = {}) {
  const c = showChip && chipsOf(p)[0];
  return html`<li class="mini">
    ${avatar(p, 28)}
    <span class="mini__body"><a class="mini__name" href="#/people/${p.id}">${nameOf(p)}</a><span class="mini__sub">${sub ?? howMet(p)}</span></span>
    ${c ? chip(c) : ""}
    ${p.linkedin?.length ? html`<a class="btn btn--icon btn--ghost btn--sm" href="${p.linkedin[0]}" target="_blank" rel="noreferrer" aria-label="Open ${nameOf(p)}'s LinkedIn">${icon("linkedin")}</a>` : ""}
  </li>`;
}

// ---------- messages ----------
export const archiveHref = (m) => `#/archive/${m.channel_id}?ts=${m.ts}${m.thread_ts && m.thread_ts !== m.ts ? `&thread=${m.thread_ts}` : ""}`;

function files(m, nameOnly) {
  const fs = m.files?.length ? m.files : nameOnly.map((n) => ({ name: n }));
  if (!fs.length) return "";
  return html`<div class="msg__files">${fs.map((f) => {
    const href = f.local_path ? `/${f.local_path}` : f.permalink;
    const img = f.local_path && /^image\/(png|jpe?g|gif|webp)/.test(f.mimetype || "");
    if (img) return html`<a class="msg__img" href="${href}" target="_blank" rel="noreferrer"><img src="${href}" alt="${f.title || f.name}" loading="lazy" decoding="async">${NEWTAB}</a>`;
    return href
      ? html`<a class="filechip" href="${href}" target="_blank" rel="noreferrer">${icon("paperclip", "i i--12")}${f.name}${NEWTAB}</a>`
      : html`<span class="filechip">${icon("paperclip", "i i--12")}${f.name}</span>`;
  })}</div>`;
}
function unfurls(links) {
  const shown = links.filter((l) => l.url && !/slack\.com\/archives/.test(l.url)).slice(0, 2);
  return shown.length ? html`<div class="msg__unfurls">${shown.map((l) => html`<a class="unfurl" href="${l.url}" target="_blank" rel="noreferrer">
      <span class="unfurl__host">${shortUrl(l.url, 36)}</span><span class="unfurl__title">${l.title}</span>${l.desc ? html`<span class="unfurl__desc">${l.desc}</span>` : ""}${NEWTAB}</a>`)}</div>` : "";
}
function reactions(m) {
  if (!m.reactions?.length) return "";
  return html`<div class="msg__reacts">${m.reactions.slice(0, 8).map((r) => {
    const e = emoji(r.name.replace(/::skin-tone-\d$/, ""));
    return html`<span class="react" title=":${r.name}:">${e ? e : html`<span class="react__txt">:${r.name}:</span>`}<span class="react__n">${r.count}</span></span>`;
  })}</div>`;
}

// One message. opts: {grouped, channel (show #chan link), clamp, thread (show replies button), jump}
export function message(m, opts = {}) {
  const p = store.byId.get(m.user_id);
  const { body, links, files: fnames } = splitExtras(m.text);
  const who = p ? nameOf(p) : cleanName(m.user_name) || "Unknown";
  const head = opts.grouped ? "" : html`<header class="msg__head">
      ${p ? html`<a class="msg__who" href="#/people/${p.id}">${who}</a>` : html`<span class="msg__who">${who}</span>`}
      ${p && !opts.noChips ? chips(p, 1, false) : ""}
      <time class="msg__time" datetime="${m.date}">${opts.channel ? date(m.date) + " · " : ""}${time(m.date)}</time>
      ${opts.channel ? html`<a class="msg__chan" href="${archiveHref(m)}">${m.channel}</a>` : ""}
    </header>`;
  return html`<article class="msg${opts.grouped ? " msg--grouped" : ""}" data-ts="${m.ts}" id="m-${m.ts.replace(".", "-")}">
    <div class="msg__gutter">${opts.grouped ? html`<time class="msg__hover-time">${time(m.date)}</time>` : avatar(p, 28, m.user_name)}</div>
    <div class="msg__main">
      ${head}
      ${body ? html`<div class="msg__text${opts.clamp === false ? "" : " clamp"}" style="--lines:${opts.lines || 6}">${raw(render(body))}</div>` : ""}
      ${files(m, fnames)}${unfurls(links)}${reactions(m)}
      ${opts.thread !== false && m.reply_count > 0 ? html`<button class="msg__thread" type="button" data-thread="${m.channel_id}|${m.ts}" aria-expanded="false">${icon("message", "i i--12")}${plural(m.reply_count, "reply", "replies")}</button><div class="thread" hidden></div>` : ""}
      ${opts.jump ? html`<a class="msg__jump" href="${archiveHref(m)}">Jump to message ${icon("arrow-right", "i i--12")}</a>` : ""}
    </div>
  </article>`;
}

// List with day dividers + same-author grouping (5 min).
export function messageList(msgs, opts = {}) {
  let prev = null, day = null;
  const out = [];
  for (const m of msgs) {
    const k = dayKey(m.date);
    if (opts.days !== false && k !== day) { out.push(html`<div class="dayrule" role="separator"><span>${dayLabel(m.date)}</span></div>`); day = k; prev = null; }
    const grouped = !opts.channel && prev && prev.user_id === m.user_id && (+m.ts - +prev.ts) < 300 && !prev.reply_count;
    out.push(message(m, { ...opts, grouped }));
    prev = m;
  }
  return out;
}

// Add "Show more" toggles to clamped text that actually overflows. Call after inserting.
export function finalizeClamps(root) {
  requestAnimationFrame(() => {
    for (const el of root.querySelectorAll(".clamp:not([data-checked])")) {
      el.dataset.checked = "1";
      if (el.scrollHeight > el.clientHeight + 4) {
        el.insertAdjacentHTML("afterend", `<button class="linkbtn more" type="button" data-unclamp aria-expanded="false">Show more</button>`);
      }
    }
  });
}

// ---------- states ----------
export const empty = ({ icon: ic = "info", title, body = "", actions = "" }) =>
  html`<div class="empty">${icon(ic, "i i--20")}<h2 class="empty__title">${title}</h2>${body ? html`<p class="empty__body">${body}</p>` : ""}${actions ? html`<div class="empty__actions">${actions}</div>` : ""}</div>`;
export const cmd = (text) => html`<span class="cmd"><code>${text}</code><button class="btn btn--icon btn--ghost btn--sm" type="button" data-copy="${text}" data-copy-msg="Copied command" aria-label="Copy command">${icon("copy")}</button></span>`;
export function errorCard(err, retry = "retry") {
  const net = err?.name === "NetError" || err?.constructor?.name === "NetError";
  return html`<div class="errcard" role="alert"><h2>Couldn't load this</h2>
    ${net ? html`<p>The archive server isn't running. Start it with ${cmd("npm start")}, then retry.</p>` : html`<p class="mono">${err?.message || String(err)}</p>`}
    <button class="btn btn--secondary" type="button" data-action="${retry}">${icon("refresh")}Retry</button></div>`;
}
export const skeleton = (kind = "rows", n = 6) =>
  html`<div class="skel skel--${kind}" aria-hidden="true">${Array.from({ length: n }, () => raw(`<div class="skel__item"></div>`))}</div>`;
// Show a skeleton only if loading takes longer than 150ms.
export function withSkeleton(el, h) {
  const t = setTimeout(() => (el.innerHTML = String(h)), 150);
  return () => clearTimeout(t);
}
export const countLine = (parts) => html`<p class="meta-line">${parts.filter(Boolean).map((x, i) => html`${i ? raw('<span class="sep">·</span>') : ""}${x}`)}</p>`;
export { num, plural };
