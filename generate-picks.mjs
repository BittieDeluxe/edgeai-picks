import { writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set'); process.exit(1); }
if (!ODDS_API_KEY) { console.error('ODDS_API_KEY is not set'); process.exit(1); }

// ─── Season calendar ───────────────────────────────────────────────────────
const SEASON_MONTHS = {
  NBA:   [10, 11, 12, 1, 2, 3, 4, 5, 6],
  NHL:   [10, 11, 12, 1, 2, 3, 4, 5, 6],
  MLB:   [4, 5, 6, 7, 8, 9, 10],
  NFL:   [9, 10, 11, 12, 1, 2],
  NCAAB: [11, 12, 1, 2, 3, 4],
  MLS:   [3, 4, 5, 6, 7, 8, 9, 10, 11],
  UFC:   [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};

// ─── ESPN sport config ─────────────────────────────────────────────────────
const ESPN_MAP = {
  NBA:   { sport: 'basketball', league: 'nba' },
  NHL:   { sport: 'hockey', league: 'nhl' },
  MLB:   { sport: 'baseball', league: 'mlb' },
  NFL:   { sport: 'football', league: 'nfl' },
  NCAAB: { sport: 'basketball', league: 'mens-college-basketball' },
  MLS:   { sport: 'soccer', league: 'usa.1' },
  UFC:   null,
};

// ─── The Odds API sport keys ───────────────────────────────────────────────
const ODDS_SPORT_KEY = {
  NBA:   'basketball_nba',
  NHL:   'icehockey_nhl',
  MLB:   'baseball_mlb',
  NFL:   'americanfootball_nfl',
  NCAAB: 'basketball_ncaab',
  MLS:   'soccer_usa_mls',
  UFC:   'mma_mixed_martial_arts',
};

const MAX_SPORTS = 5;

function getInSeasonSports(month) {
  return Object.entries(SEASON_MONTHS)
    .filter(([, months]) => months.includes(month))
    .map(([sport]) => sport)
    .slice(0, MAX_SPORTS);
}

// ─── ESPN data fetching ────────────────────────────────────────────────────
async function fetchEspnGames(sport, dateStr) {
  const espn = ESPN_MAP[sport];
  if (!espn) return [];
  const dateParam = dateStr.replace(/-/g, '');
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${dateParam}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events ?? []).map(event => {
      const competitors = event.competitions?.[0]?.competitors ?? [];
      const away = competitors.find(c => c.homeAway === 'away');
      const home = competitors.find(c => c.homeAway === 'home');
      return {
        awayTeam: away?.team?.abbreviation ?? '',
        awayName: away?.team?.displayName ?? '',
        awayRecord: away?.records?.[0]?.summary ?? '',
        homeTeam: home?.team?.abbreviation ?? '',
        homeName: home?.team?.displayName ?? '',
        homeRecord: home?.records?.[0]?.summary ?? '',
      };
    });
  } catch { return []; }
}

async function fetchAllInjuries(sport) {
  const espn = ESPN_MAP[sport];
  if (!espn) return {};
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/injuries`
    );
    if (!res.ok) return {};
    const data = await res.json();
    const injuryMap = {};
    for (const teamEntry of (data.injuries ?? data.items ?? [])) {
      for (const inj of (teamEntry.injuries ?? [])) {
        const abbrev = inj.athlete?.team?.abbreviation;
        const status = inj.status ?? inj.type?.description ?? '';
        const playerName = inj.athlete?.displayName ?? 'Unknown';
        if (!abbrev) continue;
        if (!['out', 'doubtful', 'questionable', 'day-to-day'].some(s => status.toLowerCase().includes(s))) continue;
        if (!injuryMap[abbrev]) injuryMap[abbrev] = [];
        injuryMap[abbrev].push(`${playerName} (${status})`);
      }
    }
    return injuryMap;
  } catch { return {}; }
}

// ─── The Odds API fetching ─────────────────────────────────────────────────
async function fetchOddsForSport(sport, dateStr) {
  const sportKey = ODDS_SPORT_KEY[sport];
  if (!sportKey) return {};

  const url = [
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`,
    `?apiKey=${ODDS_API_KEY}`,
    `&regions=us`,
    `&markets=h2h,spreads,totals`,
    `&oddsFormat=american`,
    `&bookmakers=draftkings,fanduel,betmgm,williamhill_us,espnbet`,
  ].join('');

  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const games = await res.json();
    if (!Array.isArray(games)) return {};

    // Filter to today's games — include both today and tomorrow UTC since US evening
    // games (7-10 PM ET) fall on the next UTC day. ESPN matching ensures we only use
    // games that are actually on today's schedule.
    const nextDayStr = new Date(dateStr + 'T12:00:00Z');
    nextDayStr.setDate(nextDayStr.getDate() + 1);
    const tomorrowStr = nextDayStr.toISOString().slice(0, 10);

    const oddsMap = {};
    for (const game of games) {
      const gameDate = game.commence_time?.slice(0, 10);
      if (gameDate !== dateStr && gameDate !== tomorrowStr) continue;

      // Aggregate best lines across all bookmakers
      let bestSpread = null; // { awayPoint, awayOdds, homePoint, homeOdds, book }
      let bestTotal = null;  // { point, overOdds, underOdds, book }
      let bestML = null;     // { awayOdds, homeOdds, book }

      for (const bm of (game.bookmakers ?? [])) {
        for (const mkt of (bm.markets ?? [])) {
          if (mkt.key === 'spreads' && !bestSpread) {
            const away = mkt.outcomes.find(o => o.name === game.away_team);
            const home = mkt.outcomes.find(o => o.name === game.home_team);
            if (away && home) bestSpread = {
              awayPoint: away.point, awayOdds: away.price,
              homePoint: home.point, homeOdds: home.price,
              book: bm.key,
            };
          }
          if (mkt.key === 'totals' && !bestTotal) {
            const over = mkt.outcomes.find(o => o.name === 'Over');
            const under = mkt.outcomes.find(o => o.name === 'Under');
            if (over && under) bestTotal = {
              point: over.point, overOdds: over.price, underOdds: under.price,
              book: bm.key,
            };
          }
          if (mkt.key === 'h2h' && !bestML) {
            const away = mkt.outcomes.find(o => o.name === game.away_team);
            const home = mkt.outcomes.find(o => o.name === game.home_team);
            if (away && home) bestML = {
              awayOdds: away.price, homeOdds: home.price, book: bm.key,
            };
          }
        }
      }

      // Key by normalized team names for matching against ESPN
      const key = `${game.away_team}|||${game.home_team}`;
      oddsMap[key] = { awayTeam: game.away_team, homeTeam: game.home_team, bestSpread, bestTotal, bestML };
    }
    return oddsMap;
  } catch (e) {
    console.error(`  Odds API error for ${sport}:`, e.message);
    return {};
  }
}

function formatOdds(n) {
  if (n === null || n === undefined) return '?';
  return n > 0 ? `+${n}` : `${n}`;
}

function matchOdds(espnGame, oddsMap) {
  // Try to match ESPN game to Odds API game by team name similarity
  for (const [, oddsGame] of Object.entries(oddsMap)) {
    const awayMatch = oddsGame.awayTeam.toLowerCase().includes(espnGame.awayName.split(' ').pop().toLowerCase()) ||
                      espnGame.awayName.toLowerCase().includes(oddsGame.awayTeam.split(' ').pop().toLowerCase());
    const homeMatch = oddsGame.homeTeam.toLowerCase().includes(espnGame.homeName.split(' ').pop().toLowerCase()) ||
                      espnGame.homeName.toLowerCase().includes(oddsGame.homeTeam.split(' ').pop().toLowerCase());
    if (awayMatch && homeMatch) return oddsGame;
  }
  return null;
}

// ─── Build full context block ──────────────────────────────────────────────
async function buildContext(sport, dateStr) {
  const [games, injuryMap, oddsMap] = await Promise.all([
    fetchEspnGames(sport, dateStr),
    fetchAllInjuries(sport),
    fetchOddsForSport(sport, dateStr),
  ]);

  const hasOdds = Object.keys(oddsMap).length > 0;
  console.log(`  ESPN games: ${games.length}, Odds games: ${Object.keys(oddsMap).length}`);

  if (games.length === 0 && !hasOdds) return { hasGames: false, contextBlock: '' };

  // If ESPN found no games but odds API has games, build from odds data
  const gameList = games.length > 0 ? games : Object.values(oddsMap).map(o => ({
    awayTeam: '', awayName: o.awayTeam, awayRecord: '',
    homeTeam: '', homeName: o.homeTeam, homeRecord: '',
  }));

  const lines = [`=== ${sport} Games Today (${dateStr}) ===`];

  for (const g of gameList) {
    const odds = games.length > 0 ? matchOdds(g, oddsMap) : Object.values(oddsMap).find(o => o.awayTeam === g.awayName);

    const record = (g.awayRecord || g.homeRecord)
      ? ` — ${g.awayName} (${g.awayRecord}) @ ${g.homeName} (${g.homeRecord})`
      : ` — ${g.awayName} @ ${g.homeName}`;
    lines.push(`\n${record}`);

    if (odds) {
      if (odds.bestSpread) {
        lines.push(`  Spread: ${g.awayName || odds.awayTeam} ${odds.bestSpread.awayPoint > 0 ? '+' : ''}${odds.bestSpread.awayPoint} (${formatOdds(odds.bestSpread.awayOdds)}) | ${g.homeName || odds.homeTeam} ${odds.bestSpread.homePoint > 0 ? '+' : ''}${odds.bestSpread.homePoint} (${formatOdds(odds.bestSpread.homeOdds)})`);
      }
      if (odds.bestTotal) {
        lines.push(`  Total: O/U ${odds.bestTotal.point} — Over (${formatOdds(odds.bestTotal.overOdds)}) / Under (${formatOdds(odds.bestTotal.underOdds)})`);
      }
      if (odds.bestML) {
        lines.push(`  Moneyline: ${g.awayName || odds.awayTeam} (${formatOdds(odds.bestML.awayOdds)}) / ${g.homeName || odds.homeTeam} (${formatOdds(odds.bestML.homeOdds)})`);
      }
    } else {
      lines.push(`  Lines: not available`);
    }

    const awayInj = injuryMap[g.awayTeam] ?? [];
    const homeInj = injuryMap[g.homeTeam] ?? [];
    if (awayInj.length > 0) lines.push(`  ${g.awayTeam || g.awayName} injuries: ${awayInj.join(', ')}`);
    if (homeInj.length > 0) lines.push(`  ${g.homeTeam || g.homeName} injuries: ${homeInj.join(', ')}`);
  }

  return { hasGames: true, contextBlock: lines.join('\n') };
}

// ─── Gemini call ──────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr) {
  const { hasGames, contextBlock } = await buildContext(sport, dateStr);

  if (!hasGames) {
    console.log(`  No games found for ${sport}`);
    return [];
  }

  const prompt = `You are generating the top 5 ${sport} betting picks for today, ${dateStr}.

REAL-TIME DATA (ESPN + The Odds API, verified for ${dateStr}):
${contextBlock}

IMPORTANT: Use ONLY the actual lines shown above in your picks. Do not estimate or invent odds. If a game shows "Lines: not available", skip it.

STEP 1 — ANALYSIS: For each game, analyze:
- Team records and current season form (home/away splits, current streak)
- Key injuries listed above and their impact (who's missing, what does it remove?)
- Head-to-head history: which team has historically covered, over/under trends
- Rest and schedule context: back-to-backs, travel, days of rest
- Matchup edges: pace mismatches, defensive assignments, situational angles

STEP 2 — SELECT 5 PICKS with genuine edge:
- Use the exact spread, total, and moneyline values shown above — no substitutions
- DO NOT suggest any moneyline with odds shorter than -400
- Prioritize spreads and totals over moneylines
- At least 1 pick must be an underdog or contrarian angle (positive odds preferred)
- Confidence "high" = multiple factors align; "medium" = solid lean

STEP 3 — WRITE detailed rationale (5-6 sentences each):
- Name the specific injured players and explain how their absence changes the matchup
- Reference team records and what the numbers indicate about current form
- Include a relevant h2h or situational trend
- Describe the matchup edge that creates betting value
- End with what specifically needs to happen for the pick to hit

If ${sport} has no games with available lines today, return: {"picks": []}

Return ONLY valid JSON, no markdown:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "e.g. 'Celtics -5.5' or 'Over 224.5'",
      "odds": "-110",
      "confidence": "high|medium",
      "rationale": "5-6 sentences with injury impact, team records, h2h trends, matchup edge, and what needs to happen"
    }
  ]
}`;

  const body = {
    system_instruction: {
      parts: [{ text: 'You are a sharp sports betting analyst. Real-time game data, injury reports, and betting lines are injected into every prompt. Use the exact lines provided — never estimate or invent odds. Rationales are 5-6 sentences with specific player names, records, and matchup factors. Return only valid JSON.' }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4 },
    // NOTE: google_search intentionally omitted — gemini-2.5-flash searches but returns
    // empty parts as of April 2026. ESPN + Odds API injection replaces it. See DECISIONS.md.
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini error for ${sport}: ${res.status} ${text}`);
  }

  const json = await res.json();
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"picks":[]}';
  console.log(`  Raw (first 400): ${raw.slice(0, 400)}`);

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    parsed.picks = (parsed.picks ?? []).filter((p) => {
      if (p.betType === 'moneyline') return parseInt(p.odds ?? '0') > -401;
      return true;
    });
    return parsed.picks;
  } catch {
    console.error(`Failed to parse picks JSON for ${sport}:`, raw);
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const dateStr = now.toISOString().slice(0, 10);

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr}, In-season sports for month ${month}:`, inSeasonSports);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`\nFetching picks for ${sport}…`);
    try {
      const picks = await getPicksForSport(sport, dateStr);
      if (picks.length > 0) {
        sports.push({ sport, picks });
        console.log(`  ✓ ${picks.length} picks`);
      } else {
        console.log(`  — No picks generated`);
      }
    } catch (err) {
      console.error(`  ✗ Error:`, err.message);
    }
  }

  writeFileSync('daily-picks.json', JSON.stringify({ date: dateStr, generatedAt: now.toISOString(), sports }, null, 2));
  console.log(`\nWrote ${sports.length} sport(s) to daily-picks.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
