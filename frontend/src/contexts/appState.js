// App-wide data loaded once per session (stats, people, teammates, channels, collections, intros,
// offer counts) that every page reads, plus the serial note-save queue that keeps
// `store.peopleById` in step with what the server has.
import { getJson, postJson } from "../services/api.js";
import { roleOf } from "../utils/people.js";

const OFFER_FALLBACK_COLLECTIONS = ["offer", "linkedin"];
const noteSaveQueues = new Map();

/** Session state. Filled by loadInitialState(); the other loaders fill their fields lazily. */
export const store = {
  stats: null,
  people: [],
  peopleById: new Map(),
  teammates: [],
  teammatesById: new Map(),
  channels: null,
  collections: null,
  opportunityCount: 0,
  introPostByUserId: null,
  // Only used against servers that predate /api/people offer_count (see offerCountOf).
  offerCountsFallback: null,
};

/** Load stats, people and teammates. Must finish before any page renders. */
export async function loadInitialState() {
  const [stats, people, teammates] = await Promise.all([getJson("/api/stats"), getJson("/api/people"), getJson("/api/teammates")]);
  store.stats = stats;
  store.people = people;
  for (const person of people) store.peopleById.set(person.id, person);
  store.teammates = teammates;
  for (const teammate of teammates) store.teammatesById.set(teammate.id, teammate);
  if (people.length && people[0].offer_count === undefined) store.offerCountsFallback = await loadOfferCountsFallback();
}

/** Their /api/teammates row, if any (the second argument roleOf and friends need). */
export function teammateOf(personId) {
  return store.teammatesById.get(personId);
}

/** Role flags for a person from the current state. */
export function roleFor(person) {
  return roleOf(person, teammateOf(person?.id));
}

/**
 * How many distinct posts someone offered help in. The server's offer_count is the number the
 * profile shows too, so the People list and the profile agree.
 */
export function offerCountOf(person) {
  if (person.offer_count !== undefined) return person.offer_count || 0;
  const entry = store.offerCountsFallback?.get(person.id);
  if (!entry) return 0;
  const hasOffered = entry.offer > 0 || (entry.linkedin > 0 && roleFor(person).helper);
  return hasOffered ? entry.total : 0;
}

/** Offer subtypes the server detected for this person ("resume", "mentorship", …). */
export function offerTypesOf(person) {
  return Array.isArray(person.offer_types) ? person.offer_types : [];
}

/** Channel list (cached after the first call). */
export async function loadChannels() {
  if (!store.channels) store.channels = await getJson("/api/channels");
  return store.channels;
}

/** Collection summaries; also sets the Opportunities nav count. */
export async function loadCollections() {
  if (!store.collections) {
    store.collections = await getJson("/api/collections");
    store.opportunityCount = store.collections.find((entry) => entry.key === "sponsor_opportunity")?.messages || 0;
  }
  return store.collections;
}

/** Map of user id → their newest intro post. */
export async function loadIntroPosts() {
  if (!store.introPostByUserId) {
    const rows = await getJson("/api/collection?key=mentor_intro").catch(() => []);
    store.introPostByUserId = new Map();
    // Rows arrive oldest first; walking them backwards keeps each person's newest intro.
    for (const row of [...rows].reverse()) if (!store.introPostByUserId.has(row.user_id)) store.introPostByUserId.set(row.user_id, row);
  }
  return store.introPostByUserId;
}

/**
 * Save a note body. One queue per person: while a save is in flight only the latest pending body
 * is sent next, so fast typing never reorders writes.
 * @param {(state: "saving"|"saved"|"error", error?: Error) => void} [onState]
 * @returns {{retry: () => void}}
 */
export function saveNote(personId, body, onState) {
  const queue = noteSaveQueues.get(personId) || { isBusy: false, next: null };
  noteSaveQueues.set(personId, queue);
  queue.next = body;
  const person = store.peopleById.get(personId);
  if (person) person.note = body;
  const run = () => drainNoteQueue(personId, queue, onState, run);
  run();
  return { retry: run };
}

// ---------- private helpers ----------

async function drainNoteQueue(personId, queue, onState, run) {
  if (queue.isBusy || queue.next == null) return;
  queue.isBusy = true;
  const body = queue.next;
  queue.next = null;
  onState?.("saving");
  try {
    await postJson("/api/note", { person_id: personId, body });
  } catch (error) {
    onState?.("error", error);
    if (queue.next == null) queue.next = body;
    queue.isBusy = false;
    return;
  }
  queue.isBusy = false;
  onState?.(queue.next == null ? "saved" : "saving");
  run();
}

// user id → { offer, linkedin, total } distinct non-DM posts, from the collection endpoints.
async function loadOfferCountsFallback() {
  const results = await Promise.all(OFFER_FALLBACK_COLLECTIONS.map((key) => getJson(`/api/collection?key=${key}`).catch(() => [])));
  const countsByUser = new Map();
  const seenMessageIds = new Set();
  OFFER_FALLBACK_COLLECTIONS.forEach((kind, i) => {
    for (const row of results[i]) {
      if (row.channel_type === "im" || !row.user_id) continue;
      const entry = countsByUser.get(row.user_id) || { offer: 0, linkedin: 0, total: 0 };
      entry[kind]++;
      if (!seenMessageIds.has(row.id)) {
        seenMessageIds.add(row.id);
        entry.total++;
      }
      countsByUser.set(row.user_id, entry);
    }
  });
  return countsByUser;
}
