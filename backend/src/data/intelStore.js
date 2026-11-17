// Owns the hackathon-intel tables in the SQLite database: schema, idempotent
// upserts of normalized adapter records (keyed by source URL, so re-running an
// adapter never duplicates), and the read queries the services/HTTP layer use.
// Normalized record shape: { kind, source, sourceUrl, data } (see adapters/).

export const RECORD_KINDS = ["hackathon", "project", "person", "contribution", "sponsor", "job"];

const INTEL_DDL = `
  CREATE TABLE IF NOT EXISTS hackathons (
    id INTEGER PRIMARY KEY, source_url TEXT UNIQUE NOT NULL, source TEXT, name TEXT NOT NULL,
    city TEXT, region TEXT, start_date TEXT, end_date TEXT, year INTEGER, url TEXT
  );
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY, source_url TEXT UNIQUE NOT NULL, source TEXT, title TEXT NOT NULL,
    tagline TEXT, description TEXT, hackathon_id INTEGER REFERENCES hackathons(id),
    devpost_url TEXT, github_url TEXT, hf_url TEXT, built_with TEXT, is_winner INTEGER DEFAULT 0,
    what_it_is TEXT, architecture TEXT, readme TEXT, file_tree TEXT
  );
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY, source_url TEXT UNIQUE NOT NULL, source TEXT, name TEXT NOT NULL,
    devpost_url TEXT, github_url TEXT, linkedin_url TEXT, bio TEXT, skills TEXT
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id), person_id INTEGER NOT NULL REFERENCES people(id),
    PRIMARY KEY (project_id, person_id)
  );
  CREATE TABLE IF NOT EXISTS contributions (
    project_id INTEGER NOT NULL REFERENCES projects(id), person_id INTEGER NOT NULL REFERENCES people(id),
    summary TEXT NOT NULL, evidence TEXT, source TEXT,
    PRIMARY KEY (project_id, person_id)
  );
  CREATE TABLE IF NOT EXISTS sponsors (
    id INTEGER PRIMARY KEY, source_url TEXT UNIQUE NOT NULL, name TEXT NOT NULL, website TEXT, jobs_board TEXT
  );
  CREATE TABLE IF NOT EXISTS hackathon_sponsors (
    hackathon_id INTEGER NOT NULL REFERENCES hackathons(id), sponsor_id INTEGER NOT NULL REFERENCES sponsors(id),
    PRIMARY KEY (hackathon_id, sponsor_id)
  );
  CREATE TABLE IF NOT EXISTS project_prizes (
    project_id INTEGER NOT NULL REFERENCES projects(id), prize TEXT NOT NULL,
    sponsor_id INTEGER REFERENCES sponsors(id), is_winner INTEGER DEFAULT 1,
    PRIMARY KEY (project_id, prize)
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY, source_url TEXT UNIQUE NOT NULL, source TEXT, title TEXT NOT NULL,
    company TEXT, location TEXT, sponsor_id INTEGER REFERENCES sponsors(id), posted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS projects_hackathon ON projects(hackathon_id);
  CREATE INDEX IF NOT EXISTS jobs_sponsor ON jobs(sponsor_id);
`;

/** @param {import("better-sqlite3").Database} db */
export function createIntelTables(db) {
  db.exec(INTEL_DDL);
}

/**
 * Insert or update one normalized record. Unknown kinds throw.
 * Relationships reference other records by source URL; a reference to a record
 * that is not stored yet creates a stub row (filled in when its own record
 * arrives), so adapters may emit records in any order.
 * @param {import("better-sqlite3").Database} db
 * @param {{ kind: string, source: string, sourceUrl: string, data: object }} record
 * @returns {number} row id
 */
export function upsertRecord(db, record) {
  const handler = UPSERTS[record.kind];
  if (!handler) throw new Error(`Unknown record kind "${record.kind}"`);
  return db.transaction(() => handler(db, record))();
}

/** @returns {Record<string, number>} row count per table, for ingest summaries */
export function intelCounts(db) {
  const tables = ["hackathons", "projects", "people", "sponsors", "jobs", "contributions"];
  return Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ hackathonId?: number, sponsor?: string, stack?: string, winnersOnly?: boolean }} [filters]
 * @returns {object[]} projects with hackathon name, prizes and members
 */
export function listProjects(db, filters = {}) {
  const where = [];
  const params = {};
  if (filters.hackathonId) { where.push("p.hackathon_id = @hackathonId"); params.hackathonId = filters.hackathonId; }
  if (filters.winnersOnly) where.push("p.is_winner = 1");
  if (filters.stack) { where.push("LOWER(p.built_with) LIKE @stack"); params.stack = `%${filters.stack.toLowerCase()}%`; }
  if (filters.sponsor) {
    where.push(`EXISTS (SELECT 1 FROM project_prizes pp JOIN sponsors s ON s.id = pp.sponsor_id
                        WHERE pp.project_id = p.id AND LOWER(s.name) = @sponsor)`);
    params.sponsor = filters.sponsor.toLowerCase();
  }
  const sql = `SELECT p.*, h.name AS hackathon_name FROM projects p LEFT JOIN hackathons h ON h.id = p.hackathon_id
               ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.id`;
  return db.prepare(sql).all(params).map((row) => withProjectRelations(db, row));
}

/** @returns {object | null} one project with prizes, members and contributions */
export function getProject(db, id) {
  const row = db.prepare(`SELECT p.*, h.name AS hackathon_name FROM projects p
                          LEFT JOIN hackathons h ON h.id = p.hackathon_id WHERE p.id = ?`).get(id);
  if (!row) return null;
  const project = withProjectRelations(db, row);
  project.contributions = db.prepare(
    `SELECT c.person_id, pe.name, c.summary, c.evidence FROM contributions c
     JOIN people pe ON pe.id = c.person_id WHERE c.project_id = ?`).all(id)
    .map((c) => ({ ...c, evidence: parseJson(c.evidence, []) }));
  return project;
}

/** @returns {object[]} all hackathons, newest first */
export function listHackathons(db) {
  return db.prepare("SELECT * FROM hackathons ORDER BY start_date DESC, id").all();
}

/** @returns {object[]} all sponsors with the number of prizes they backed */
export function listSponsors(db) {
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM project_prizes pp WHERE pp.sponsor_id = s.id) AS prize_count
                     FROM sponsors s ORDER BY prize_count DESC, s.name`).all();
}

/** @returns {object[]} jobs with their sponsor name */
export function listJobs(db, { sponsor } = {}) {
  const rows = db.prepare(`SELECT j.*, s.name AS sponsor_name FROM jobs j LEFT JOIN sponsors s ON s.id = j.sponsor_id
                           ORDER BY j.id`).all();
  return sponsor ? rows.filter((j) => j.sponsor_name?.toLowerCase() === sponsor.toLowerCase()) : rows;
}

/** @returns {object[]} people with the projects they worked on */
export function listPeople(db) {
  return db.prepare("SELECT * FROM people ORDER BY name").all().map((row) => ({
    ...row,
    skills: parseJson(row.skills, []),
    projects: db.prepare(`SELECT p.id, p.title, p.is_winner FROM project_members m
                          JOIN projects p ON p.id = m.project_id WHERE m.person_id = ?`).all(row.id),
  }));
}

// ---------------------------------------------------------------- private helpers
const UPSERTS = { hackathon: upsertHackathon, project: upsertProject, person: upsertPerson,
  contribution: upsertContribution, sponsor: upsertSponsor, job: upsertJob };

function upsertHackathon(db, { source, sourceUrl, data }) {
  db.prepare(`INSERT INTO hackathons (source_url, source, name, city, region, start_date, end_date, year, url)
    VALUES (@sourceUrl, @source, @name, @city, @region, @startDate, @endDate, @year, @url)
    ON CONFLICT(source_url) DO UPDATE SET source=excluded.source, name=excluded.name, city=excluded.city,
      region=excluded.region, start_date=excluded.start_date, end_date=excluded.end_date, year=excluded.year, url=excluded.url`)
    .run({ sourceUrl, source, name: data.name, city: data.city ?? null, region: data.region ?? null,
      startDate: data.startDate ?? null, endDate: data.endDate ?? null, year: data.year ?? null, url: data.url ?? sourceUrl });
  const id = idOf(db, "hackathons", sourceUrl);
  for (const sponsor of data.sponsors ?? []) {
    const sponsorId = ensureSponsor(db, sponsor);
    db.prepare("INSERT OR IGNORE INTO hackathon_sponsors (hackathon_id, sponsor_id) VALUES (?, ?)").run(id, sponsorId);
  }
  return id;
}

function upsertProject(db, { source, sourceUrl, data }) {
  const hackathonId = data.hackathonUrl ? ensureStub(db, "hackathons", data.hackathonUrl, data.hackathonName ?? data.hackathonUrl) : null;
  const prizes = data.prizes ?? [];
  const isWinner = prizes.some((p) => p.isWinner !== false) ? 1 : 0;
  db.prepare(`INSERT INTO projects (source_url, source, title, tagline, description, hackathon_id, devpost_url, github_url,
      hf_url, built_with, is_winner, readme, file_tree)
    VALUES (@sourceUrl, @source, @title, @tagline, @description, @hackathonId, @devpostUrl, @githubUrl, @hfUrl,
      @builtWith, @isWinner, @readme, @fileTree)
    ON CONFLICT(source_url) DO UPDATE SET source=excluded.source, title=excluded.title, tagline=excluded.tagline,
      description=excluded.description, hackathon_id=COALESCE(excluded.hackathon_id, projects.hackathon_id),
      devpost_url=COALESCE(excluded.devpost_url, projects.devpost_url), github_url=COALESCE(excluded.github_url, projects.github_url),
      hf_url=COALESCE(excluded.hf_url, projects.hf_url), built_with=excluded.built_with, is_winner=excluded.is_winner,
      readme=COALESCE(excluded.readme, projects.readme), file_tree=COALESCE(excluded.file_tree, projects.file_tree)`)
    .run({ sourceUrl, source, title: data.title, tagline: data.tagline ?? null, description: data.description ?? null,
      hackathonId, devpostUrl: data.devpostUrl ?? null, githubUrl: data.githubUrl ?? null, hfUrl: data.hfUrl ?? null,
      builtWith: JSON.stringify(data.builtWith ?? []), isWinner, readme: data.readme ?? null,
      fileTree: data.fileTree ? JSON.stringify(data.fileTree) : null });
  const id = idOf(db, "projects", sourceUrl);
  for (const prize of prizes) {
    const sponsorId = prize.sponsor ? ensureSponsor(db, typeof prize.sponsor === "string" ? { name: prize.sponsor } : prize.sponsor) : null;
    db.prepare(`INSERT INTO project_prizes (project_id, prize, sponsor_id, is_winner) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, prize) DO UPDATE SET sponsor_id=excluded.sponsor_id, is_winner=excluded.is_winner`)
      .run(id, prize.name, sponsorId, prize.isWinner === false ? 0 : 1);
  }
  for (const member of data.members ?? []) {
    const personId = ensureStub(db, "people", member.url, member.name);
    db.prepare("INSERT OR IGNORE INTO project_members (project_id, person_id) VALUES (?, ?)").run(id, personId);
  }
  return id;
}

function upsertPerson(db, { source, sourceUrl, data }) {
  db.prepare(`INSERT INTO people (source_url, source, name, devpost_url, github_url, linkedin_url, bio, skills)
    VALUES (@sourceUrl, @source, @name, @devpostUrl, @githubUrl, @linkedinUrl, @bio, @skills)
    ON CONFLICT(source_url) DO UPDATE SET name=excluded.name, devpost_url=COALESCE(excluded.devpost_url, people.devpost_url),
      github_url=COALESCE(excluded.github_url, people.github_url), linkedin_url=COALESCE(excluded.linkedin_url, people.linkedin_url),
      bio=COALESCE(excluded.bio, people.bio), skills=excluded.skills`)
    .run({ sourceUrl, source, name: data.name, devpostUrl: data.devpostUrl ?? null, githubUrl: data.githubUrl ?? null,
      linkedinUrl: data.linkedinUrl ?? null, bio: data.bio ?? null, skills: JSON.stringify(data.skills ?? []) });
  return idOf(db, "people", sourceUrl);
}

function upsertContribution(db, { source, data }) {
  const projectId = idOf(db, "projects", data.projectUrl);
  const personId = idOf(db, "people", data.personUrl);
  if (!projectId || !personId) throw new Error("Contribution references an unknown project or person");
  db.prepare(`INSERT INTO contributions (project_id, person_id, summary, evidence, source) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, person_id) DO UPDATE SET summary=excluded.summary, evidence=excluded.evidence, source=excluded.source`)
    .run(projectId, personId, data.summary, JSON.stringify(data.evidence ?? []), source);
  db.prepare("INSERT OR IGNORE INTO project_members (project_id, person_id) VALUES (?, ?)").run(projectId, personId);
  return projectId;
}

function upsertSponsor(db, { sourceUrl, data }) {
  return ensureSponsor(db, { name: data.name, url: sourceUrl, website: data.website, jobsBoard: data.jobsBoard });
}

function upsertJob(db, { source, sourceUrl, data }) {
  const sponsorId = data.sponsorName ? ensureSponsor(db, { name: data.sponsorName }) : null;
  db.prepare(`INSERT INTO jobs (source_url, source, title, company, location, sponsor_id, posted_at)
    VALUES (@sourceUrl, @source, @title, @company, @location, @sponsorId, @postedAt)
    ON CONFLICT(source_url) DO UPDATE SET title=excluded.title, company=excluded.company, location=excluded.location,
      sponsor_id=COALESCE(excluded.sponsor_id, jobs.sponsor_id), posted_at=excluded.posted_at`)
    .run({ sourceUrl, source, title: data.title, company: data.company ?? null, location: data.location ?? null,
      sponsorId, postedAt: data.postedAt ?? null });
  return idOf(db, "jobs", sourceUrl);
}

/** Sponsors are keyed by a stable URL; without one, a slug of the name, so "Acme" dedupes across adapters. */
function ensureSponsor(db, { name, url, website, jobsBoard }) {
  const key = url ?? `sponsor:${name.trim().toLowerCase().replace(/\s+/g, "-")}`;
  db.prepare(`INSERT INTO sponsors (source_url, name, website, jobs_board) VALUES (?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET website=COALESCE(excluded.website, sponsors.website),
      jobs_board=COALESCE(excluded.jobs_board, sponsors.jobs_board)`).run(key, name, website ?? null, jobsBoard ?? null);
  return idOf(db, "sponsors", key);
}

function ensureStub(db, table, sourceUrl, name) {
  const existing = idOf(db, table, sourceUrl);
  if (existing) return existing;
  db.prepare(`INSERT INTO ${table} (source_url, name) VALUES (?, ?)`).run(sourceUrl, name);
  return idOf(db, table, sourceUrl);
}

function idOf(db, table, sourceUrl) {
  return db.prepare(`SELECT id FROM ${table} WHERE source_url = ?`).get(sourceUrl)?.id ?? null;
}

function withProjectRelations(db, row) {
  return {
    ...row,
    built_with: parseJson(row.built_with, []),
    file_tree: parseJson(row.file_tree, null),
    prizes: db.prepare(`SELECT pp.prize, pp.is_winner, s.name AS sponsor FROM project_prizes pp
                        LEFT JOIN sponsors s ON s.id = pp.sponsor_id WHERE pp.project_id = ?`).all(row.id),
    members: db.prepare(`SELECT pe.id, pe.name, pe.devpost_url, pe.github_url, pe.linkedin_url FROM project_members m
                         JOIN people pe ON pe.id = m.person_id WHERE m.project_id = ?`).all(row.id),
  };
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
