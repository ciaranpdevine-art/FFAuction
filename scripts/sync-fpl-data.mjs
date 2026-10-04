/**
 * FPL auto-sync — pulls finished-gameweek data from the public "FPL Core
 * Insights" dataset (github.com/olbauday/FPL-Core-Insights) and writes it
 * straight into this league's Firestore:
 *   1. Player points & stats -> league/main/weeks/{week} (scores, playerStats)
 *      — exactly what "Import weekly points & stats" writes.
 *   2. Match results (home/away score) -> league/main's fixtures array
 *      — exactly what "Import match results" writes.
 * Everything for a run is written in a single atomic Firestore batch: it
 * either all commits or none of it does.
 *
 * Run by the GitHub workflow .github/workflows/sync-fpl-data.yml on a daily
 * schedule (and on-demand via "Run workflow" in the Actions tab). Needs no
 * secrets: this project's Firestore rules already allow open writes (the
 * same public config already embedded in index.html is used here), matching
 * how the app itself saves data from any visitor's browser.
 *
 * Matching a source player to one of your pool players (same logic as the
 * app's own import tools):
 *   1. External ID — if the player has an External ID set in Admin → Players
 *      and it matches the source's FPL player id, use that (unambiguous,
 *      works regardless of how club names are spelled).
 *   2. Name + club — match on name and club, ignoring case and accents
 *      (e.g. "Ünal" matches "Unal"), used as a fallback when no External ID
 *      is set.
 * Players that can't be matched either way are skipped and listed in this
 * run's log — nothing is guessed.
 *
 * Matching a source fixture to one of your existing fixtures: week + home
 * club + away club, ignoring case and accents, same as the player fallback.
 * Only Premier League fixtures are used (the source also includes cup and
 * European games). A fixture's score is only ever written if a fixture with
 * that week/home/away already exists in your fixtures list — this never
 * creates new fixtures, only fills in results for ones you've already
 * imported. If club names don't line up (e.g. source says "Man Utd" but
 * your fixtures say "Manchester United"), use Admin → Fixtures → "Fix a
 * club name across all fixtures" to align them.
 *
 * Update SOURCE_SEASON below once a year when the new season's folder
 * appears in the source repo (e.g. "2027-2028").
 */

import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, collection, getDocs, writeBatch } from "firebase/firestore";
import { parse } from "csv-parse/sync";

// Same public config already embedded in index.html — these are client
// identifiers, not secrets; Firestore access is controlled by its rules.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCZ7vU_cwoJq1rKM1RZK0fwviyaEmCwxyU",
  authDomain: "fantasy-football-auction-9a665.firebaseapp.com",
  projectId: "fantasy-football-auction-9a665",
  storageBucket: "fantasy-football-auction-9a665.firebasestorage.app",
  messagingSenderId: "377336547547",
  appId: "1:377336547547:web:fdfc886c321ea340a964fe",
};

const SOURCE_SEASON = "2026-2027"; // update each July when the new season folder appears
const SOURCE_RAW_BASE = `https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data/${SOURCE_SEASON}`;

async function fetchCsv(path) {
  const url = `${SOURCE_RAW_BASE}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true });
}

function norm(s) {
  // Case- and accent-insensitive (Ünal -> unal, Sánchez -> sanchez) so
  // matching isn't defeated by diacritics alone.
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function teamCodeToString(raw) {
  // Source CSVs export team codes as floats ("43.0") — normalize to match
  // teams.csv's plain-integer "code" column.
  const n = Number(raw);
  return Number.isFinite(n) ? String(Math.trunc(n)) : null;
}

async function main() {
  console.log(`Season folder: ${SOURCE_SEASON}`);

  // 1. Which gameweeks are finished and ready to sync.
  const summaries = await fetchCsv("gameweek_summaries.csv");
  const finishedWeeks = summaries
    .filter((row) => norm(row.finished) === "true")
    .map((row) => Number(row.id))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  console.log(`Finished gameweeks in source: ${finishedWeeks.join(", ") || "(none yet)"}`);
  if (!finishedWeeks.length) {
    console.log("Nothing to sync yet this season.");
    return;
  }

  // 2. Season player/club lookup, used for the name+club fallback match and
  // for resolving fixtures' numeric team codes to club names.
  const sourcePlayers = await fetchCsv("players.csv"); // player_code,player_id,first_name,second_name,web_name,team_code,position
  const sourceTeams = await fetchCsv("teams.csv"); // code,id,name,short_name,...
  const clubNameByTeamCode = {};
  sourceTeams.forEach((t) => { clubNameByTeamCode[t.code] = t.name; });
  const sourcePlayerById = {};
  sourcePlayers.forEach((p) => {
    sourcePlayerById[p.player_id] = {
      webName: p.web_name,
      fullName: `${p.first_name} ${p.second_name}`.trim(),
      club: clubNameByTeamCode[p.team_code] || "",
    };
  });

  // 3. Connect to Firestore and load current state.
  const app = initializeApp(FIREBASE_CONFIG);
  const db = getFirestore(app);
  const mainRef = doc(db, "league", "main");
  const mainSnap = await getDoc(mainRef);
  if (!mainSnap.exists()) throw new Error("league/main document doesn't exist — nothing to sync against.");
  const mainData = mainSnap.data();
  const players = mainData.players || [];
  const fixtures = [...(mainData.fixtures || [])];
  console.log(`Player pool: ${players.length} players. Fixtures on file: ${fixtures.length}.`);

  const byExternalId = {};
  players.forEach((p) => { if (p.externalId) byExternalId[String(p.externalId)] = p; });
  const byNameClub = {};
  players.forEach((p) => { byNameClub[`${norm(p.name)}|${norm(p.club)}`] = p; });

  function matchPlayer(fplId) {
    const byId = byExternalId[String(fplId)];
    if (byId) return { player: byId, matchedBy: "id" };
    const info = sourcePlayerById[fplId];
    if (!info) return { player: null };
    const key = `${norm(info.webName)}|${norm(info.club)}`;
    if (byNameClub[key]) return { player: byNameClub[key], matchedBy: "name" };
    const fullKey = `${norm(info.fullName)}|${norm(info.club)}`;
    if (byNameClub[fullKey]) return { player: byNameClub[fullKey], matchedBy: "name" };
    return { player: null };
  }

  const fixtureIndex = {};
  fixtures.forEach((f, i) => { fixtureIndex[`${f.week}|${norm(f.homeClub)}|${norm(f.awayClub)}`] = i; });

  // 4. Pull each finished week's player stats, writing straight to its week
  // document, preserving any existing entries this source didn't match.
  const weeksColRef = collection(db, "league", "main", "weeks");
  const existingWeeksSnap = await getDocs(weeksColRef);
  const existingWeeks = {};
  existingWeeksSnap.forEach((d) => { existingWeeks[d.id] = d.data(); });

  const batch = writeBatch(db);
  let weeksWritten = 0;
  let totalMatched = 0, totalUnmatched = 0;
  const unmatchedPlayersSample = [];
  let fixturesUpdated = 0, fixturesUnmatched = 0;
  const unmatchedFixturesSample = [];

  for (const week of finishedWeeks) {
    // --- Player points & stats for this week ---
    let statRows;
    try {
      statRows = await fetchCsv(`By Gameweek/GW${week}/player_gameweek_stats.csv`);
    } catch (e) {
      console.log(`Week ${week}: couldn't fetch player stats (${e.message}), skipping stats for this week.`);
      statRows = [];
    }

    if (statRows.length) {
      const existing = existingWeeks[String(week)] || { scores: {}, playerStats: {} };
      const scores = { ...(existing.scores || {}) };
      const playerStats = { ...(existing.playerStats || {}) };
      let matched = 0, unmatched = 0;

      statRows.forEach((row) => {
        const { player } = matchPlayer(row.id);
        if (!player) {
          unmatched++;
          if (unmatchedPlayersSample.length < 25) {
            const info = sourcePlayerById[row.id];
            unmatchedPlayersSample.push(`Week ${week}: ${info ? `${info.webName} (${info.club})` : `FPL id ${row.id}`}`);
          }
          return;
        }
        matched++;
        scores[player.id] = Number(row.total_points) || 0;
        playerStats[player.id] = {
          minutes: Number(row.minutes) || 0,
          goals: Number(row.goals_scored) || 0,
          assists: Number(row.assists) || 0,
          cleanSheets: Number(row.clean_sheets) || 0,
          yellowCards: Number(row.yellow_cards) || 0,
          redCards: Number(row.red_cards) || 0,
          saves: Number(row.saves) || 0,
          goalsConceded: Number(row.goals_conceded) || 0,
          defcon: Number(row.defensive_contribution) || 0,
          bonusPoints: Number(row.bonus) || 0,
        };
      });

      batch.set(doc(db, "league", "main", "weeks", String(week)), { scores, playerStats });
      weeksWritten++;
      totalMatched += matched;
      totalUnmatched += unmatched;
      console.log(`Week ${week}: stats — ${matched} matched, ${unmatched} unmatched.`);
    } else {
      console.log(`Week ${week}: no stat rows yet, skipping stats for this week.`);
    }

    // --- Match results for this week ---
    let matchRows;
    try {
      matchRows = await fetchCsv(`By Gameweek/GW${week}/matches.csv`);
    } catch (e) {
      console.log(`Week ${week}: couldn't fetch match results (${e.message}), skipping results for this week.`);
      continue;
    }
    const premMatches = matchRows.filter((r) => norm(r.tournament) === "prem" && norm(r.finished) === "true");
    let weekFixturesUpdated = 0, weekFixturesUnmatched = 0;
    premMatches.forEach((r) => {
      const homeClub = clubNameByTeamCode[teamCodeToString(r.home_team)];
      const awayClub = clubNameByTeamCode[teamCodeToString(r.away_team)];
      if (!homeClub || !awayClub || r.home_score === "" || r.away_score === "") return;
      const key = `${week}|${norm(homeClub)}|${norm(awayClub)}`;
      const idx = fixtureIndex[key];
      if (idx === undefined) {
        weekFixturesUnmatched++;
        if (unmatchedFixturesSample.length < 15) unmatchedFixturesSample.push(`Week ${week}: ${homeClub} vs ${awayClub}`);
        return;
      }
      const homeScore = Math.round(Number(r.home_score));
      const awayScore = Math.round(Number(r.away_score));
      if (fixtures[idx].homeScore !== homeScore || fixtures[idx].awayScore !== awayScore) {
        fixtures[idx] = { ...fixtures[idx], homeScore, awayScore };
        weekFixturesUpdated++;
      }
    });
    fixturesUpdated += weekFixturesUpdated;
    fixturesUnmatched += weekFixturesUnmatched;
    if (premMatches.length) {
      console.log(`Week ${week}: results — ${weekFixturesUpdated} updated, ${weekFixturesUnmatched} unmatched (of ${premMatches.length} finished PL matches).`);
    }
  }

  if (fixturesUpdated > 0) {
    batch.set(mainRef, { ...mainData, fixtures });
  }

  if (weeksWritten === 0 && fixturesUpdated === 0) {
    console.log("Nothing new to write.");
    return;
  }

  await batch.commit();
  console.log(`\nDone — wrote ${weeksWritten} week document(s), updated ${fixturesUpdated} fixture result(s).`);
  console.log(`Player stats: ${totalMatched} matched total, ${totalUnmatched} unmatched total.`);
  if (unmatchedPlayersSample.length) {
    console.log("\nSample of unmatched players (add their External ID in Admin → Players to fix):");
    unmatchedPlayersSample.forEach((line) => console.log(`  - ${line}`));
  }
  if (unmatchedFixturesSample.length) {
    console.log(`\n${fixturesUnmatched} fixture result(s) couldn't be matched to an existing fixture. Sample:`);
    unmatchedFixturesSample.forEach((line) => console.log(`  - ${line}`));
    console.log("If these look like real mismatches (not just games not in your fixture list), check club-name spelling via Admin → Fixtures → \"Fix a club name across all fixtures\".");
  }
}

main().catch((e) => {
  console.error("Sync failed:", e);
  process.exit(1);
});
