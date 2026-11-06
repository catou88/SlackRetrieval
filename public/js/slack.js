// Slack text → safe HTML.
// The ingester already resolved most <…> tokens ("label (url)", "@Name", "#chan") and decoded
// entities, then appended "[files: …]" and "[links: …]" lines. Leftover raw tokens
// (<mailto:…|…>, <#C…>, <!subteam…>) and stray &amp; still appear, so we handle both.
import { esc } from "./html.js";
import { store, nameOf } from "./store.js";

export const EMOJI = {
  wave: "👋", heart: "❤️", raised_hands: "🙌", "+1": "👍", thumbsup: "👍", "-1": "👎", eyes: "👀", fire: "🔥",
  white_check_mark: "✅", heavy_check_mark: "✔️", rocket: "🚀", pray: "🙏", sob: "😭", trophy: "🏆",
  slightly_smiling_face: "🙂", handshake: "🤝", saluting_face: "🫡", microphone: "🎤", point_down: "👇",
  point_up: "☝️", point_up_2: "👆", point_right: "👉", point_left: "👈", skull: "💀", bangbang: "‼️",
  sparkles: "✨", sparkling_heart: "💖", smiling_face_with_tear: "🥲", link: "🔗", second_place_medal: "🥈",
  first_place_medal: "🥇", third_place_medal: "🥉", heavy_plus_sign: "➕", grin: "😁", "star-struck": "🤩",
  boom: "💥", doughnut: "🍩", heart_hands: "🫶", smile: "😄", joy: "😂", robot_face: "🤖", blush: "😊",
  tada: "🎉", sweat_smile: "😅", 100: "💯", airplane: "✈️", goat: "🐐", computer: "💻", coffee: "☕",
  mega: "📣", smiley: "😃", face_with_cowboy_hat: "🤠", alien: "👽", moneybag: "💰", bulb: "💡",
  round_pushpin: "📍", pushpin: "📌", rotating_light: "🚨", bow: "🙇", bear: "🐻", hammer_and_wrench: "🛠️",
  star2: "🌟", star: "⭐", smile_cat: "😸", mending_heart: "❤️‍🩹", pensive: "😔", space_invader: "👾",
  muscle: "💪", wilted_flower: "🥀", v: "✌️", face_holding_back_tears: "🥹", partying_face: "🥳",
  exclamation: "❗", question: "❓", laughing: "😆", sunglasses: "😎", blue_heart: "💙", purple_heart: "💜",
  green_heart: "💚", orange_heart: "🧡", yellow_heart: "💛", broken_heart: "💔", heartpulse: "💗",
  rolling_on_the_floor_laughing: "🤣", money_with_wings: "💸", cry: "😢", thinking_face: "🤔",
  pleading_face: "🥺", briefcase: "💼", melting_face: "🫠", face_with_bags_under_eyes: "🫩",
  exploding_head: "🤯", musical_note: "🎵", stuck_out_tongue: "😛", wink: "😉", dizzy: "💫", brain: "🧠",
  gift: "🎁", camera_with_flash: "📸", relaxed: "☺️", airplane_arriving: "🛬", joy_cat: "😹",
  dark_sunglasses: "🕶️", x: "❌", arrow_up: "⬆️", arrow_right: "➡️", arrow_down: "⬇️", wrench: "🔧",
  clap: "👏", dart: "🎯", zap: "⚡", mag: "🔍", bridge_at_night: "🌉", innocent: "😇", mechanical_arm: "🦾",
  chart_with_upwards_trend: "📈", weary: "😩", yum: "😋", sunny: "☀️", triumph: "😤", loudspeaker: "📢",
  smiling_face_with_3_hearts: "🥰", otter: "🦦", dancer: "💃", soccer: "⚽", earth_africa: "🌍",
  earth_americas: "🌎", globe_with_meridians: "🌐", grinning: "😀", nerd_face: "🤓", burrito: "🌯",
  raising_hand: "🙋", sparkle: "❇️", disappointed: "😞", call_me_hand: "🤙", art: "🎨", memo: "📝",
  alarm_clock: "⏰", simple_smile: "🙂", sleeping: "😴", crescent_moon: "🌙", signal_strength: "📶",
  knife_fork_plate: "🍽️", billed_cap: "🧢", email: "📧", face_with_raised_eyebrow: "🤨", ski: "🎿",
  guitar: "🎸", squirrel: "🐿️", skull_and_crossbones: "☠️", hugging_face: "🤗", lion_face: "🦁",
  open_mouth: "😮", evergreen_tree: "🌲", palm_tree: "🌴", teddy_bear: "🧸", badger: "🦡", bee: "🐝",
  cat: "🐱", eye: "👁️", "female-technologist": "👩‍💻", "male-technologist": "👨‍💻", technologist: "🧑‍💻",
  foggy: "🌁", smirk_cat: "😼", smirk: "😏", frowning: "😦", llama: "🦙", telephone_receiver: "📞",
  scroll: "📜", speech_balloon: "💬", seedling: "🌱", banana: "🍌", bubble_tea: "🧋",
  statue_of_liberty: "🗽", shushing_face: "🤫", thread: "🧵", bug: "🐛", calendar: "📅", date: "📅",
  zzz: "💤", tired_face: "😫", cold_face: "🥶", hot_face: "🥵", performing_arts: "🎭", older_woman: "👵",
  sleeping_accommodation: "🛌", deaf_man: "🧏‍♂️", ok_hand: "👌", pizza: "🍕", hamburger: "🍔",
  trophy_cup: "🏆", sweat: "😓", upside_down_face: "🙃", heart_eyes: "😍", star_struck: "🤩",
  slightly_frowning_face: "🙁", scream: "😱", rofl: "🤣", ghost: "👻", crown: "👑", gem: "💎",
  books: "📚", book: "📖", pencil: "✏️", pencil2: "✏️", key: "🔑", lock: "🔒", unlock: "🔓", bell: "🔔",
  hourglass: "⌛", watch: "⌚", iphone: "📱", camera: "📷", movie_camera: "🎥", tv: "📺", battery: "🔋",
  electric_plug: "🔌", satellite: "📡", red_circle: "🔴", large_green_circle: "🟢", large_blue_circle: "🔵",
  warning: "⚠️", no_entry: "⛔", checkered_flag: "🏁", triangular_flag_on_post: "🚩", balloon: "🎈",
  confetti_ball: "🎊", medal: "🏅", sports_medal: "🏅", runner: "🏃", walking: "🚶", car: "🚗",
  bus: "🚌", train: "🚆", taxi: "🚕", house: "🏠", office: "🏢", school: "🏫", hotel: "🏨",
  mountain: "⛰️", ocean: "🌊", rainbow: "🌈", snowflake: "❄️", cloud: "☁️", umbrella: "☂️",
  apple: "🍎", tea: "🍵", beer: "🍺", wine_glass: "🍷", cake: "🍰", cookie: "🍪", popcorn: "🍿",
  dog: "🐶", panda_face: "🐼", unicorn_face: "🦄", penguin: "🐧", frog: "🐸", monkey: "🐒",
  see_no_evil: "🙈", hear_no_evil: "🙉", speak_no_evil: "🙊", eyes_closed: "😌", relieved: "😌",
  neutral_face: "😐", expressionless: "😑", grimacing: "😬", face_palm: "🤦", facepalm: "🤦",
  shrug: "🤷", man_shrugging: "🤷‍♂️", woman_shrugging: "🤷‍♀️", raised_hand: "✋", fist: "✊",
  punch: "👊", writing_hand: "✍️", handshake_tone: "🤝", flag_us: "🇺🇸", us: "🇺🇸", gb: "🇬🇧",
  kr: "🇰🇷", cn: "🇨🇳", "flag-ca": "🇨🇦", "flag-in": "🇮🇳", "flag-mx": "🇲🇽", "flag-ar": "🇦🇷",
  "flag-nl": "🇳🇱", jp: "🇯🇵", fr: "🇫🇷", de: "🇩🇪", four: "4️⃣", six: "6️⃣", seven: "7️⃣",
  clock130: "🕜", arrow_forward: "▶️", heavy_minus_sign: "➖", heavy_multiplication_x: "✖️",
  information_source: "ℹ️", new: "🆕", free: "🆓", sos: "🆘", cool: "🆒", top: "🔝", soon: "🔜",
};
export const emoji = (name) => EMOJI[name] || null;

const P0 = "\uE000", P1 = "\uE001";
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const stripProto = (u) => u.replace(/^(https?:\/\/)?(www\.)?/i, "").replace(/\/+$/, "");
export const shortUrl = (u, max = 42) => {
  const s = stripProto(decode(u));
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
// Links to other Slack messages point into the local archive (the workspace will be gone).
const SLACK_MSG = /^https?:\/\/[\w-]+\.slack\.com\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/;
const link = (url, label) => {
  const s = decode(url).match(SLACK_MSG);
  if (s) {
    const ch = store.channels?.find((c) => c.id === s[1]);
    return `<a class="slacklink" href="#/archive/${s[1]}?ts=${s[2]}.${s[3]}">↪ ${esc(ch ? `Message in ${ch.name}` : "Linked Slack message")}</a>`;
  }
  return `<a href="${esc(decode(url))}" target="_blank" rel="noreferrer">${esc(label ?? shortUrl(url))}<span class="sr"> (opens in new tab)</span></a>`;
};
const personLink = (id, fallback) => {
  const p = store.byId.get(id);
  return `<a class="mention" href="#/people/${esc(id)}">@${esc(p ? nameOf(p) : fallback || "someone")}</a>`;
};

// Split off the ingester's trailing "[files: …]" / "[links: …]" lines.
export function splitExtras(text) {
  let t = String(text || ""), links = [], files = [];
  const li = t.lastIndexOf("[links: ");
  if (li >= 0 && (li === 0 || t[li - 1] === "\n")) {
    const part = t.slice(li + 8).replace(/\]\s*$/, "");
    t = t.slice(0, li);
    links = part.split(/(?<=https?:\/\/\S+) \| /).map((seg) => {
      const bits = seg.split(" — ");
      const url = /^https?:\/\//.test(bits[bits.length - 1]) ? bits.pop().trim() : "";
      // Unfurl text is sometimes double-encoded ("&amp;#39;").
      const dd = (s) => decode(decode(s)).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
      return { title: dd(bits[0] || ""), desc: dd(bits.slice(1).join(" — ")), url };
    }).filter((x) => x.title || x.url);
  }
  const fi = t.lastIndexOf("[files: ");
  if (fi >= 0 && (fi === 0 || t[fi - 1] === "\n")) {
    files = t.slice(fi + 8).replace(/\]\s*$/, "").split(", ").filter(Boolean);
    t = t.slice(0, fi);
  }
  return { body: t.replace(/\s+$/, ""), links, files };
}

// Inline tokens on RAW text. Each match becomes a placeholder holding finished HTML.
const TOKEN = new RegExp([
  /<mailto:([^|>]+)\|([^>]+)>/.source,                       // 1,2
  /<#C[A-Z0-9]+\|([^>]+)>/.source,                           // 3
  /<#C[A-Z0-9]+>/.source,                                    //
  /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/.source,                 // 4,5
  /<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/.source,              // 6
  /<!(here|channel|everyone)(?:\|[^>]*)?>/.source,           // 7
  /<(https?:\/\/[^|>\s]+)\|([^>]+)>/.source,                 // 8,9
  /<(https?:\/\/[^>\s]+)>/.source,                           // 10
  /(\S+) \((https?:\/\/[^\s)]+)\)/.source,                   // 11,12  "label (url)" from the ingester
  /(https?:\/\/[^\s<>()"]*[^\s<>()".,!?;:'’”])/.source,      // 13 bare url
].join("|"), "g");

function tokenize(s, keep) {
  return s.replace(TOKEN, (m, mt, ml, cn, uid, ul, st, bang, u1, l1, u2, lbl, u3, bare) => {
    let h;
    if (mt) h = link("mailto:" + mt, decode(ml));
    else if (cn) h = `<span class="mention">#${esc(decode(cn))}</span>`;
    else if (m.startsWith("<#")) h = `<span class="mention">#channel</span>`;
    else if (uid) h = personLink(uid, ul);
    else if (m.startsWith("<!subteam")) h = `<span class="mention">${esc(decode(st || "@team"))}</span>`;
    else if (bang) h = `<span class="mention">@${bang}</span>`;
    else if (u1) h = link(u1, decode(l1));
    else if (u2) h = link(u2);
    else if (u3) {
      // Same target twice ("devpost.com/x (http://devpost.com/x)") → one link.
      const same = stripProto(lbl).toLowerCase() === stripProto(u3).toLowerCase() || /^https?:/.test(lbl);
      h = same ? link(u3) : `${esc(decode(lbl))} ${link(u3)}`;
    } else if (bare) h = link(bare);
    else return m;
    keep.push(h);
    return P0 + (keep.length - 1) + P1;
  });
}

function inline(s) {
  // s is already HTML-escaped. Code spans first (protected), then emphasis and emoji.
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => (codes.push(`<code>${c}</code>`), `\uE002${codes.length - 1}\uE003`));
  s = s.replace(/(^|[\s(“"'>_~])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,!?:;'”"_~<])/g, "$1<b>$2</b>");
  s = s.replace(/(^|[\s(“"'>*~])_(?=\S)([^_\n]*?\S)_(?=$|[\s).,!?:;'”"*~<])/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(>*_])~(?=\S)([^~\n]*?\S)~(?=$|[\s).,!?:;*_<])/g, "$1<s>$2</s>");
  s = s.replace(/:([a-z0-9_+-]+):(?::skin-tone-\d:)?/g, (m, n) => (EMOJI[n] ? `<span class="emo" title=":${n}:">${EMOJI[n]}</span>` : `<span class="emo-txt">:${n}:</span>`));
  s = s.replace(/::?skin-tone-\d:/g, "");
  return s.replace(/\uE002(\d+)\uE003/g, (_, i) => codes[i]);
}

// Full renderer → HTML string (block-level: paragraphs, quotes, lists, pre).
export function render(text) {
  const keep = [];
  let s = String(text || "").replace(/\r/g, "");
  const pres = [];
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => (pres.push(c.replace(/^\n|\n$/g, "")), `\n\uE004${pres.length - 1}\uE005\n`));
  s = tokenize(s, keep);
  s = esc(decode(s));
  const lines = s.split("\n");
  const out = [];
  let list = null, quote = null;
  const flush = () => {
    if (list) out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`), (list = null);
    if (quote) out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`), (quote = null);
  };
  let para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^\uE004(\d+)\uE005$/))) { flushPara(); flush(); out.push(`<pre>${esc(decode(pres[m[1]]))}</pre>`); continue; }
    if ((m = line.match(/^\s*(?:•|◦|▪|-|\*)\s+(.*)$/)) && !/^\s*\*[^*\s]/.test(line)) { flushPara(); if (quote) flush(); (list ||= []).push(m[1]); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); if (list) flush(); (quote ||= []).push(m[1]); continue; }
    flush();
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara(); flush();
  return out.join("").replace(/\uE000(\d+)\uE001/g, (_, i) => keep[i]);
}

// One-line plain excerpt (for rows, palette, quotes). Returns plain text — escape on output.
export function plain(text, max = 160) {
  let s = splitExtras(text).body
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g, (_, id) => "@" + (store.byId.get(id) ? nameOf(store.byId.get(id)) : "someone"))
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1").replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2").replace(/<(https?:[^>]+)>/g, (_, u) => shortUrl(u, 30))
    .replace(/(\S+) \((https?:\/\/[^\s)]+)\)/g, (m, l, u) => (stripProto(l) === stripProto(u) || /^https?:/.test(l) ? shortUrl(u, 30) : l))
    .replace(/https?:\/\/\S+/g, (u) => shortUrl(u, 30))
    .replace(/```/g, "").replace(/[*_~`]/g, "")
    .replace(/:([a-z0-9_+-]+):(?::skin-tone-\d:)?/g, (m, n) => EMOJI[n] || "")
    .replace(/^&gt;\s?|^>\s?/gm, "");
  s = decode(s).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// URLs in a message, for link chips. Skips Slack-internal links and LinkedIn (has its own button).
export function urlsIn(text, max = 3) {
  const seen = new Set(), out = [];
  for (const m of String(text || "").matchAll(/https?:\/\/[^\s<>()|"]*[^\s<>()|".,!?;:'’”\]]/g)) {
    const u = decode(m[0]);
    const k = stripProto(u).toLowerCase();
    if (seen.has(k) || /slack\.com\/|linkedin\.com\//i.test(u)) continue;
    seen.add(k); out.push(u);
    if (out.length >= max) break;
  }
  return out;
}
