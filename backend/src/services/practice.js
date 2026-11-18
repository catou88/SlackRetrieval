// Hackathon practice: pick a real past prize track to ideate against, then
// reveal who actually won it. The prompt deliberately omits the winners.
import { listHackathons } from "../data/intelStore.js";

export const DEFAULT_MINUTES = 30;

/**
 * Pick a random past prize track.
 * @param {import("better-sqlite3").Database} db
 * @param {{ random?: () => number, minutes?: number }} [opts]  random is injectable for tests
 * @returns {{ track: object, minutes: number } | null} null when no prizes are stored
 */
export function pickTrack(db, { random = Math.random, minutes = DEFAULT_MINUTES } = {}) {
  const tracks = listTracks(db);
  if (!tracks.length) return null;
  return { track: tracks[Math.floor(random() * tracks.length)], minutes };
}

/**
 * Winners of one track, for the reveal step.
 * @returns {{ track: object, winners: object[] } | null}
 */
export function revealTrack(db, { hackathonId, prize }) {
  const track = listTracks(db).find((t) => t.hackathonId === hackathonId && t.prize === prize);
  if (!track) return null;
  const winners = db.prepare(`SELECT p.id, p.title, p.tagline, p.devpost_url, p.github_url FROM project_prizes pp
    JOIN projects p ON p.id = pp.project_id WHERE p.hackathon_id = ? AND pp.prize = ? AND pp.is_winner = 1 ORDER BY p.id`)
    .all(hackathonId, prize);
  return { track, winners };
}

// ---------------------------------------------------------------- private helpers
// A track is a (hackathon, prize) pair that has at least one winning project.
function listTracks(db) {
  const hackathons = new Map(listHackathons(db).map((h) => [h.id, h]));
  return db.prepare(`SELECT p.hackathon_id AS hackathonId, pp.prize AS prize, s.name AS sponsor, COUNT(*) AS winnerCount
    FROM project_prizes pp JOIN projects p ON p.id = pp.project_id LEFT JOIN sponsors s ON s.id = pp.sponsor_id
    WHERE pp.is_winner = 1 AND p.hackathon_id IS NOT NULL GROUP BY p.hackathon_id, pp.prize ORDER BY p.hackathon_id, pp.prize`)
    .all()
    .map((row) => ({ ...row, hackathon: hackathons.get(row.hackathonId)?.name ?? null }));
}
