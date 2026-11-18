// Typed wrappers over /api/intel/* so pages never build URLs by hand.
import { getJson, postJson } from "./api.js";

const BASE = "/api/intel";

/** @param {{ hackathon?: string, sponsor?: string, stack?: string, winners?: boolean }} [filters] */
export function fetchProjects(filters = {}, options) {
  const query = new URLSearchParams();
  if (filters.hackathon) query.set("hackathon", filters.hackathon);
  if (filters.sponsor) query.set("sponsor", filters.sponsor);
  if (filters.stack) query.set("stack", filters.stack);
  if (filters.winners) query.set("winners", "1");
  return getJson(`${BASE}/projects?${query}`, options);
}

export const fetchProject = (id, options) => getJson(`${BASE}/project?id=${encodeURIComponent(id)}`, options);
export const fetchHackathons = (options) => getJson(`${BASE}/hackathons`, options);
export const fetchSponsors = (options) => getJson(`${BASE}/sponsors`, options);
export const fetchPeople = (options) => getJson(`${BASE}/people`, options);
export const fetchJobs = (filters = {}, options) => getJson(`${BASE}/jobs?${new URLSearchParams(filters)}`, options);
export const fetchTeammates = (q, options) => getJson(`${BASE}/teammates?${new URLSearchParams({ q })}`, options);
export const fetchPracticeTrack = () => getJson(`${BASE}/practice`, { fresh: true });
export const revealPracticeTrack = ({ hackathonId, prize }) =>
  getJson(`${BASE}/practice/reveal?${new URLSearchParams({ hackathon: hackathonId, prize })}`);
export const askIntel = (question) => postJson(`${BASE}/ask`, { question });
