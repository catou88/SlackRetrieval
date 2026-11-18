// Adapter for public job boards (Greenhouse, Lever, Ashby) of sponsor
// companies. Boards come from sponsors.jobs_board (set by manual import) or
// options.boards; we never guess a company's board slug, because probing
// unknown slugs would mean hammering sites with misses.
import { makeRecord } from "../lib/records.js";

const SLUG = "[A-Za-z0-9][\\w-]*";
const BOARD_RE = new RegExp(`^(greenhouse|lever|ashby):(${SLUG})$`, "i");
const URL_BOARDS = [
  { vendor: "greenhouse", re: new RegExp(`^https?://boards\\.greenhouse\\.io/(${SLUG})/?$`, "i") },
  { vendor: "lever", re: new RegExp(`^https?://jobs\\.lever\\.co/(${SLUG})/?$`, "i") },
  { vendor: "ashby", re: new RegExp(`^https?://jobs\\.ashbyhq\\.com/(${SLUG})/?$`, "i") },
];
const MAX_JOBS_PER_BOARD = 200;

export const name = "jobs";

const VENDORS = {
  greenhouse: {
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    jobs: (json) => (json.jobs ?? []).map((j) => ({ title: j.title, url: j.absolute_url, location: j.location?.name, postedAt: j.updated_at })),
  },
  lever: {
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    jobs: (json) => (Array.isArray(json) ? json : []).map((j) => ({
      title: j.text, url: j.hostedUrl, location: j.categories?.location, postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    })),
  },
  ashby: {
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    jobs: (json) => (json.jobs ?? []).map((j) => ({ title: j.title, url: j.jobUrl, location: j.location, postedAt: j.publishedAt })),
  },
};

/**
 * @param {{ boards?: { company: string, board: string }[] }} options  extra boards to read
 * @param {{ http: object, sponsors?: object[] }} deps
 * @returns {Promise<object[]>} job records linked to their sponsor by name
 */
export async function fetchRecords(options, { http, sponsors = [] }) {
  const targets = [
    ...sponsors.filter((s) => s.jobs_board).map((s) => ({ company: s.name, board: s.jobs_board })),
    ...(options.boards ?? []),
  ];
  const records = [];
  for (const { company, board } of targets) {
    const parsed = parseBoard(board);
    if (!parsed) continue;
    const vendor = VENDORS[parsed.vendor];
    // A dead board (404, company moved ATS) must not stop the other companies.
    const json = await http.getJson(vendor.url(parsed.slug)).catch(() => null);
    if (!json) continue;
    for (const job of vendor.jobs(json).slice(0, MAX_JOBS_PER_BOARD)) {
      // Board JSON is third-party: only https links may become stored/rendered URLs.
      if (!job.title || !isHttps(job.url)) continue;
      records.push(makeRecord("job", name, job.url, {
        title: job.title, company, sponsorName: company, location: job.location ?? null, postedAt: job.postedAt ?? null,
      }));
    }
  }
  return records;
}

function isHttps(url) {
  try { return new URL(url).protocol === "https:"; } catch { return false; }
}

/**
 * Accepts "greenhouse:acme" or a public board URL.
 * @returns {{ vendor: string, slug: string } | null}
 */
export function parseBoard(board) {
  const text = String(board ?? "").trim();
  const short = BOARD_RE.exec(text);
  if (short) return { vendor: short[1].toLowerCase(), slug: short[2] };
  for (const { vendor, re } of URL_BOARDS) {
    const match = re.exec(text);
    if (match) return { vendor, slug: match[1] };
  }
  return null;
}
