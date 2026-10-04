/**
 * FPL auto-sync — pulls gameweek data from the public "FPL Core Insights"
 * dataset (github.com/olbauday/FPL-Core-Insights) and writes it straight
 * into this league's Firestore:
 *   1. Player points & stats -> league/main/weeks/{week} (scores, playerStats)
 *      — exactly what "Import weekly points & stats" writes.
 *   2. Match results (home/away score) -> league/main's fixtures array
 *      — exactly what "Import match results" writes.
 * Everything for a run is written in a single atomic Firestore batch: it
 * either all commits or none of it does.
 *
 * Syncs LIVE, mid-gameweek, not just once a gameweek is fully finished: any
 * gameweek whose squad-selection deadline has already passed is synced every
 * run, whatever state it's in. The source's own player-stats and match files
 * for a gameweek only ever contain rows for teams that have already played,
 * same as the CSV you were importing by hand — rows for players/fixtures
 * that haven't played yet simply aren't written at all (never zeroed), so a
 * player or fixture only gets an entry once their match has actually
 * happened, and "left to play" stays accurate throughout the weekend. Each
 * run just overwrites with whatever the source currently has (matching how
 * provisional bonus points can tick up for an hour or so after a match
 * before being confirmed — the next run corrects it automatically).
 *
 * Run by the GitHub workflow .github/workflows/sync-fpl-data.yml on a
 * schedule (and on-demand via "Run workflow" in the Actions tab) — matched
 * to the source's own twice-daily refresh. Needs no secrets: this project's
 * Firestore rules already allow open writes (the same public config already
 * embedded in index.html is used here), matching how the app itself saves
 * data from any visitor's browser.
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
 * club + away club. The source uses its own short club names ("Spurs",
 * "Man Utd", "Nott'm Forest"), which usually don't match however your
 * fixtures spell them — so instead of relying on the source's names
 * directly, this script first figures out, for each source club, what YOUR
 * spelling of that club is: it looks at the players from that club it just
 * matched via External ID (reliable regardless of spelling) and uses their
 * `club` field as the real name. That mapping is then used to match
 * fixtures, so it stays correct automatically even if your spelling style
 * changes. Only Premier League fixtures are used (the source also includes
 * cup and European games). A fixture's score is only ever written if a
 * fixture with that week/home/away already exists in your fixtures list —
 * this never creates new fixtures, only fills in results for ones you've
 * already imported.
 *
 * Update SOURCE_SEASON below once a year when the new season's folder
 * appears in the source repo (e.g. "2027-2028").
 */

import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, collection, getDocs, writeBatch } from "firebase/firestore";
import { parse } from "csv-parse/sync";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCZ7vU_cwoJq1rKM1RZK0fwviyaEmCwxyU",
  authDomain: "fantasy-football-auction-9a665.firebaseapp.com",
  projectId: "fantasy-football-auction-9a665",
  storageBucket: "fantasy-football-auction-9a665.firebasestorage.app",
  messagingSenderId: "377336547547",
  appId: "1:377336547547:web:fdfc886c321ea340a964fe",
};

const SOURCE_SEASON = "2026-2027";
const SOURCE_RAW_BASE = `https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data/${SOURCE_SEASON}`;

async function fetchCsv(path) {
  const url = `${SOURCE_RAW_BASE}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${url}`);
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true });
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function teamCodeToString(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? String(Math.trunc(n)) : null;
}

async function main() {
  console.log(`Season folder: ${SOURCE_SEASON}`);

  const summaries = await fetchCsv("gameweek_summaries.csv");
  const nowEpoch = Math.floor(Date.now() / 1000);
  // Any gameweek whose deadline has passed has started (or finished) — sync
  // it regardless of whether the source has marked the whole round
  // "finished" yet, so in-progress gameweeks get live partial updates.
  const weeksToSync = summaries
    .filter((row) => {
      const id = Number(row.id);
      const deadline = Number(row.deadline_time_epoch);
      return Number.isFinite(id) && id > 0 && Number.isFinite(deadline) && deadline <= nowEpoch;
    })
    .map((row) => Number(row.id))
    .sort((a, b) => a - b);
  const finishedFlagById = {};
  summaries.forEach((row) => { finishedFlagById[Number(row.id)] = norm(row.finished) === "true"; });
  console.log(
    `Gameweeks to sync: ${weeksToSync.join(", ") || "(none yet)"} ` +
      `(${weeksToSync.filter((w) => finishedFlagById[w]).length} fully finished, ` +
      `${weeksToSync.filter((w) => !finishedFlagById[w]).length} still in progress)`
  );
  if (!weeksToSync.length) {
    console.log("Nothing to sync yet this season.");
    return;
  }

  const sourcePlayers = await fetchCsv("players.csv");
  const sourceTeams = await fetchCsv("teams.csv");
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

  // Figure out, for each of the source's own club names, what your fixtures
  // actually call that club — derived from players we just matched via
  // External ID (reliable no matter how club names are spelled), not from
  // the source's own naming. Majority vote per source club in case of a
  // stray mismatch.
  const clubNameVotes = {};
  sourcePlayers.forEach((p) => {
    const { player, matchedBy } = matchPlayer(p.player_id);
    if (!player || matchedBy !== "id") return;
    const sourceClub = clubNameByTeamCode[p.team_code] || "";
    if (!sourceClub) return;
    clubNameVotes[sourceClub] = clubNameVotes[sourceClub] || {};
    clubNameVotes[sourceClub][player.club] = (clubNameVotes[sourceClub][player.club] || 0) + 1;
  });
  const resolvedClubName = {};
  Object.entries(clubNameVotes).forEach(([sourceClub, counts]) => {
    let best = null, bestCount = 0;
    Object.entries(counts).forEach(([appClub, c]) => { if (c > bestCount) { best = appClub; bestCount = c; } });
    resolvedClubName[sourceClub] = best || sourceClub;
  });
  const renamed = Object.entries(resolvedClubName).filter(([src, app]) => norm(src) !== norm(app));
  if (renamed.length) {
    console.log("Resolved club-name spelling from matched players:");
    renamed.forEach(([src, app]) => console.log(`  - "${src}" (source) → "${app}" (yours)`));
  }

  const fixtureIndex = {};
  fixtures.forEach((f, i) => { fixtureIndex[`${f.week}|${norm(f.homeClub)}|${norm(f.awayClub)}`] = i; });

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

  for (const week of weeksToSync) {
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
      const tag = finishedFlagById[week] ? "" : " (in progress)";
      console.log(`Week ${week}${tag}: stats — ${matched} matched, ${unmatched} unmatched.`);
    } else {
      console.log(`Week ${week}: no stat rows yet (hasn't kicked off in the source), skipping stats for this week.`);
    }

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
      const rawHome = clubNameByTeamCode[teamCodeToString(r.home_team)];
      const rawAway = clubNameByTeamCode[teamCodeToString(r.away_team)];
      const homeClub = resolvedClubName[rawHome] || rawHome;
      const awayClub = resolvedClubName[rawAway] || rawAway;
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
      const tag = finishedFlagById[week] ? "" : " (in progress)";
      console.log(`Week ${week}${tag}: results — ${weekFixturesUpdated} updated, ${weekFixturesUnmatched} unmatched (of ${premMatches.length} finished PL matches so far).`);
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
    console.log("If these look like real mismatches (not just games not in your fixture list), check that fixture's homeClub/awayClub spelling in your app, or that the fixture exists at all for that week.");
  }
}

main().catch((e) => {
  console.error("Sync failed:", e);
  process.exit(1);
});
