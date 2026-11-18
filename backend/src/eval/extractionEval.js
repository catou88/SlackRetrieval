// Extraction evals: run the Devpost parsers over hand-labelled fixtures and
// score them against the gold labels (winner detection P/R, team-member F1,
// prize-sponsor linking accuracy, SF-and-2026 filter accuracy).
import fs from "node:fs";
import path from "node:path";
import { selectTargetHackathons, parseGallery, parseProject, parsePrizes, linkPrizeSponsors } from "../adapters/devpost.js";
import { precisionRecallF1, accuracy, round3 } from "./metrics.js";

/**
 * @param {string} goldFile  path to a devpost-gold.json file
 * @returns {Record<string, number>} metric name -> value (0..1)
 */
export function runExtractionEval(goldFile) {
  const gold = JSON.parse(fs.readFileSync(goldFile, "utf8"));
  const dir = path.join(path.dirname(goldFile), "..", gold.fixtureDir);
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");

  const winners = winnerScores(gold.gallery, read);
  const members = precisionRecallF1(parseProject(read(gold.project.file)).members.map((m) => m.name), gold.project.members);
  return {
    "winner.precision": round3(winners.precision),
    "winner.recall": round3(winners.recall),
    "members.f1": round3(members.f1),
    "sponsor_link.accuracy": round3(sponsorLinkAccuracy(gold.prizeSponsors, read)),
    "sf2026_filter.accuracy": round3(filterAccuracy(gold.hackathonListing, read)),
  };
}

// ---------------------------------------------------------------- private helpers
function winnerScores(goldGallery, read) {
  const found = parseGallery(read(goldGallery.file), goldGallery.baseUrl).filter((item) => item.isWinner).map((item) => item.url);
  return precisionRecallF1(found, goldGallery.winners);
}

function sponsorLinkAccuracy(goldPrizes, read) {
  const prizeList = parsePrizes(read(goldPrizes.file));
  const linked = linkPrizeSponsors(goldPrizes.labels.map((l) => ({ name: l.prize })), prizeList);
  return accuracy(linked.map((p, i) => p.sponsor === goldPrizes.labels[i].sponsor));
}

function filterAccuracy(goldListing, read) {
  const kept = new Set(selectTargetHackathons(JSON.parse(read(goldListing.file))).map((h) => h.url));
  return accuracy(Object.entries(goldListing.labels).map(([url, shouldKeep]) => kept.has(url) === shouldKeep));
}
