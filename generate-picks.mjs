import { writeFileSync, readFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set'); process.exit(1); }
if (!ODDS_API_KEY) { console.error('ODDS_API_KEY is not set'); process.exit(1); }
if (!PERPLEXITY_API_KEY) { console.error('PERPLEXITY_API_KEY is not set'); process.exit(1); }

// ─── Season calendar ───────────────────────────────────────────────────────
const SEASON_MONTHS = {
  NBA:      [10, 11, 12, 1, 2, 3, 4, 5, 6],
  NHL:      [10, 11, 12, 1, 2, 3, 4, 5, 6],
  MLB:      [4, 5, 6, 7, 8, 9, 10],
  NFL:      [9, 10, 11, 12, 1, 2],
  NCAAB:   [11, 12, 1, 2, 3, 4],
  MLS:      [3, 4, 5, 6, 7, 8, 9, 10, 11],
  UFC:      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  UCL:      [9, 10, 11, 12, 2, 3, 4, 5, 6], // UEFA Champions League — Sep–Dec + Feb–Jun
  UEL:      [9, 10, 11, 12, 2, 3, 4, 5, 6], // UEFA Europa League — Sep–Dec + Feb–Jun
  WORLDCUP: [6, 7],                           // FIFA World Cup 2026 — Jun 11–Jul 19 2026
};

const ESPN_MAP = {
  NBA:      { sport: 'basketball', league: 'nba' },
  NHL:      { sport: 'hockey', league: 'nhl' },
  MLB:      { sport: 'baseball', league: 'mlb' },
  NFL:      { sport: 'football', league: 'nfl' },
  NCAAB:   { sport: 'basketball', league: 'mens-college-basketball' },
  MLS:      { sport: 'soccer', league: 'usa.1' },
  UFC:      null,
  UCL:      { sport: 'soccer', league: 'uefa.champions' },
  UEL:      { sport: 'soccer', league: 'uefa.europa' },
  WORLDCUP: { sport: 'soccer', league: 'fifa.world' },
};

const ODDS_SPORT_KEY = {
  NBA:      'basketball_nba',
  NHL:      'icehockey_nhl',
  MLB:      'baseball_mlb',
  NFL:      'americanfootball_nfl',
  NCAAB:   'basketball_ncaab',
  MLS:      'soccer_usa_mls',
  UFC:      'mma_mixed_martial_arts',
  UCL:      'soccer_uefa_champs_league',
  UEL:      'soccer_uefa_europa_league',
  WORLDCUP: 'soccer_fifa_world_cup',
};

const MAX_SPORTS = 8; // increased to cover simultaneous World Cup + major leagues in Jun/Jul

function getInSeasonSports(month) {
  return Object.entries(SEASON_MONTHS)
    .filter(([, months]) => months.includes(month))
    .map(([sport]) => sport)
    .slice(0, MAX_SPORTS);
}

// ─── ESPN ──────────────────────────────────────────────────────────────────
async function fetchTeamLast5(sport, teamAbbrev) {
  if (!teamAbbrev) return [];
  const espn = ESPN_MAP[sport];
  if (!espn) return [];
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/teams/${teamAbbrev}/schedule`
    );
    if (!res.ok) return [];
    const data = await res.json();
    const events = data.events ?? [];
    const completed = events.filter(e => e.competitions?.[0]?.status?.type?.completed);
    return completed.slice(-5).map(e => {
      const comps = e.competitions?.[0]?.competitors ?? [];
      const myTeam = comps.find(c => c.team?.abbreviation?.toLowerCase() === teamAbbrev.toLowerCase());
      if (!myTeam) return '?';
      return myTeam.winner ? 'W' : 'L';
    });
  } catch { return []; }
}

function matchPickToGame(pick, games) {
  const parts = (pick.game ?? '').split(' vs ');
  if (parts.length !== 2) return null;
  const awayKey = parts[0].trim().toLowerCase().split(/\s+/).pop() ?? '';
  const homeKey = parts[1].trim().toLowerCase().split(/\s+/).pop() ?? '';
  for (const g of games) {
    const gAwayKey = (g.awayName ?? '').toLowerCase().split(/\s+/).pop() ?? '';
    const gHomeKey = (g.homeName ?? '').toLowerCase().split(/\s+/).pop() ?? '';
    if (gAwayKey === awayKey && gHomeKey === homeKey) return g;
  }
  return null;
}

async function fetchEspnGames(sport, dateStr) {
  const espn = ESPN_MAP[sport];
  if (!espn) return [];
  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${dateStr.replace(/-/g, '')}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events ?? []).map(event => {
      const comps = event.competitions?.[0]?.competitors ?? [];
      const away = comps.find(c => c.homeAway === 'away');
      const home = comps.find(c => c.homeAway === 'home');
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
    const map = {};
    for (const teamEntry of (data.injuries ?? data.items ?? [])) {
      // Key by full team display name — the athlete object has no team reference in this endpoint
      const teamName = teamEntry.displayName ?? '';
      if (!teamName) continue;
      for (const inj of (teamEntry.injuries ?? [])) {
        const status = inj.status ?? '';
        const name = inj.athlete?.displayName ?? 'Unknown';
        if (!['out', 'doubtful', 'questionable', 'day-to-day'].some(s => status.toLowerCase().includes(s))) continue;
        if (!map[teamName]) map[teamName] = [];
        map[teamName].push(`${name} (${status})`);
      }
    }
    return map;
  } catch { return {}; }
}

// ─── The Odds API ──────────────────────────────────────────────────────────
async function fetchOddsForSport(sport, dateStr) {
  const sportKey = ODDS_SPORT_KEY[sport];
  if (!sportKey) return {};
  const url = [
    `https://api.the-odds-api.com/v4/sports/${sportKey}/odds`,
    `?apiKey=${ODDS_API_KEY}`,
    `&regions=us&markets=h2h,spreads,totals&oddsFormat=american`,
    `&bookmakers=draftkings,fanduel,betmgm,williamhill_us,espnbet`,
  ].join('');
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const games = await res.json();
    if (!Array.isArray(games)) return {};

    const nextDay = new Date(dateStr + 'T12:00:00Z');
    nextDay.setDate(nextDay.getDate() + 1);
    const tomorrowStr = nextDay.toISOString().slice(0, 10);

    const oddsMap = {};
    for (const game of games) {
      const gameDate = game.commence_time?.slice(0, 10);
      if (gameDate !== dateStr && gameDate !== tomorrowStr) continue;

      let bestSpread = null, bestTotal = null, bestML = null;
      for (const bm of (game.bookmakers ?? [])) {
        for (const mkt of (bm.markets ?? [])) {
          if (mkt.key === 'spreads' && !bestSpread) {
            const away = mkt.outcomes.find(o => o.name === game.away_team);
            const home = mkt.outcomes.find(o => o.name === game.home_team);
            if (away && home) bestSpread = { awayPoint: away.point, awayOdds: away.price, homePoint: home.point, homeOdds: home.price };
          }
          if (mkt.key === 'totals' && !bestTotal) {
            const over = mkt.outcomes.find(o => o.name === 'Over');
            const under = mkt.outcomes.find(o => o.name === 'Under');
            if (over && under) bestTotal = { point: over.point, overOdds: over.price, underOdds: under.price };
          }
          if (mkt.key === 'h2h' && !bestML) {
            const away = mkt.outcomes.find(o => o.name === game.away_team);
            const home = mkt.outcomes.find(o => o.name === game.home_team);
            if (away && home) bestML = { awayOdds: away.price, homeOdds: home.price };
          }
        }
      }
      oddsMap[`${game.away_team}|||${game.home_team}`] = { awayTeam: game.away_team, homeTeam: game.home_team, bestSpread, bestTotal, bestML };
    }
    return oddsMap;
  } catch (e) {
    console.error(`  Odds API error for ${sport}:`, e.message);
    return {};
  }
}

function fmt(n) { return n == null ? '?' : n > 0 ? `+${n}` : `${n}`; }

function matchOdds(espnGame, oddsMap) {
  for (const oddsGame of Object.values(oddsMap)) {
    const awayMatch = oddsGame.awayTeam.toLowerCase().includes(espnGame.awayName.split(' ').pop().toLowerCase()) ||
                      espnGame.awayName.toLowerCase().includes(oddsGame.awayTeam.split(' ').pop().toLowerCase());
    const homeMatch = oddsGame.homeTeam.toLowerCase().includes(espnGame.homeName.split(' ').pop().toLowerCase()) ||
                      espnGame.homeName.toLowerCase().includes(oddsGame.homeTeam.split(' ').pop().toLowerCase());
    if (awayMatch && homeMatch) return oddsGame;
  }
  return null;
}

// ─── Stage 1: Perplexity research ─────────────────────────────────────────
async function researchSport(sport, dateStr) {
  const prompt = `You are a sports research analyst. Search the web and compile a comprehensive betting research report for ${sport} on ${dateStr}.

For every game scheduled today, find and report:
1. INJURY REPORT: Which players are OUT, Doubtful, or Questionable for each team? What impact does each absence have on the team's offense/defense?
2. RECENT FORM: Each team's last 10 games W/L record, current streak, home/away splits this season
3. HEAD-TO-HEAD: Last 5 meetings between these teams — who won, who covered the spread, did it go over or under?
4. LINE MOVEMENT: What was the opening line and where is it now? Is sharp money moving the line in any direction?
5. SITUATIONAL FACTORS: Back-to-backs, rest days, travel, revenge games, motivation, playoff implications, load management
6. KEY PLAYER MATCHUPS: Any favorable or unfavorable defensive assignments, pace mismatches, or individual edges

Be specific with names, numbers, and stats. This research will be used to generate betting picks so accuracy is critical.`;

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar-pro',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`  Perplexity error: ${res.status} ${err.slice(0, 200)}`);
      return '';
    }
    const data = await res.json();
    const research = data.choices?.[0]?.message?.content ?? '';
    console.log(`  Perplexity research: ${research.length} chars`);
    return research;
  } catch (e) {
    console.error(`  Perplexity error:`, e.message);
    return '';
  }
}

// ─── NBA Player Props: Perplexity research ────────────────────────────────
async function researchNBAPlayerProps(dateStr, nbaGames) {
  if (nbaGames.length === 0) return '';

  const gamesList = nbaGames.map(g => `${g.awayName} @ ${g.homeName}`).join('\n');

  const prompt = `You are a sports research analyst. For NBA games on ${dateStr}, compile a comprehensive player props research report.

TODAY'S NBA GAMES:
${gamesList}

For EACH game, find and report:

1. PROP LINES (from DraftKings and FanDuel, as of today):
   - Top 4–6 players per game with their current Points, Rebounds, and Assists over/under lines and odds
   - Format: "Player Name (Team): Points O/U X.X (-110/-110), Rebounds O/U Y.Y (-115/-105), Assists O/U Z.Z (-120/+100)"

2. PLAYER AVERAGES (current season):
   - Points per game, Rebounds per game, Assists per game for each player listed above
   - Last 10 games averages for each player (recent form indicator)
   - Total games played this season

3. POSITIONAL DEFENSIVE STATS (for each team):
   - Points allowed per game to each position (PG, SG, SF, PF, C)
   - Which positions does each team struggle to defend?
   - Specific opposing player matchup: who guards whom?

4. PACE & USAGE:
   - Each team's pace (possessions per 48 minutes — league average ~100)
   - Key player usage rates (% of team possessions used)
   - High-pace matchups = more possessions = easier to hit scoring overs

5. BACK-TO-BACK & REST:
   - Is either team on a back-to-back tonight?
   - Days of rest for each team
   - Do star players typically see reduced minutes on back-to-backs?

6. INJURY/LINEUP NEWS:
   - Any confirmed absences that would increase a teammate's usage or role?
   - Any load management or minutes-restriction news?

Be specific with numbers. If prop lines are not available for a player, say so explicitly.`;

  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonar-pro', messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`  NBA Props Perplexity error: ${res.status} ${err.slice(0, 200)}`);
      return '';
    }
    const data = await res.json();
    const research = data.choices?.[0]?.message?.content ?? '';
    console.log(`  NBA Props research: ${research.length} chars`);
    return research;
  } catch (e) {
    console.error(`  NBA Props Perplexity error:`, e.message);
    return '';
  }
}

// ─── NBA Player Props: Gemini synthesis ───────────────────────────────────
async function getNBAPlayerProps(dateStr, propsResearch, nbaGames, nbaInjuryMap) {
  if (!propsResearch || nbaGames.length === 0) return [];

  const injuryLines = [`=== NBA Official Injury Report (${dateStr}) ===`];
  for (const g of nbaGames) {
    const awayInj = nbaInjuryMap[g.awayName] ?? [];
    const homeInj = nbaInjuryMap[g.homeName] ?? [];
    injuryLines.push(`${g.awayName} @ ${g.homeName}`);
    injuryLines.push(`  ${g.awayName}: ${awayInj.length ? awayInj.join(', ') : 'none listed'}`);
    injuryLines.push(`  ${g.homeName}: ${homeInj.length ? homeInj.join(', ') : 'none listed'}`);
  }

  const prompt = `You are a sharp NBA player props analyst. Today is ${dateStr}.

--- PLAYER PROPS RESEARCH (live web search via Perplexity) ---
${propsResearch}

--- OFFICIAL NBA INJURY REPORT (ESPN) ---
${injuryLines.join('\n')}

---

INSTRUCTIONS: Select 4–6 high-confidence NBA player prop picks for tonight. Apply ALL filters:

1. MINIMUM SAMPLE SIZE: Only pick players with 15+ games played this season. Skip any player where games played is unknown or under 15.

2. CONFIRMED PROP LINES ONLY: Use only lines found in the research from DraftKings or FanDuel. Do NOT estimate or make up lines.

3. POSITIONAL MATCHUP EDGE: The primary reason for the pick must be a clear positional defensive matchup advantage — cite which position the opponent struggles to defend and the specific PPG/RPG/APG allowed to that position.

4. RECENT FORM ALIGNMENT: The player's last-10 average must support the pick direction. Do not pick Over when the last-10 is trending well under the line. Do not pick Under when the player is hot.

5. PACE FACTOR: For scoring props, compare team paces. High-pace matchup (both teams above 100 possessions/game) supports Overs for usage-heavy players.

6. BACK-TO-BACK: If a player is on a back-to-back, use the "caution" field to flag potential minutes reduction. Only back back-to-back players who have strong historical data on second nights.

7. INJURY BONUS: If a star teammate is listed OUT in the official injury report, flag the usage increase for supporting players — this is an Over indicator.

8. AVOID STAR BIAS: Do not pick a player simply because they are famous. The edge must be specific and data-driven.

Return ONLY valid JSON, no markdown:
{
  "playerProps": [
    {
      "player": "Player Full Name",
      "team": "Team Full Name",
      "game": "Away Team vs Home Team",
      "propType": "points|rebounds|assists|steals|blocks|threes",
      "pick": "Over 25.5 Points",
      "odds": "-115",
      "confidence": "high|medium",
      "rationale": "5–6 sentences citing positional matchup PPG/RPG/APG allowed, season avg vs last-10 avg, pace data, injury context if relevant, and what needs to happen",
      "caution": null
    }
  ]
}

If there are no strong plays tonight, return {"playerProps": []}. Fewer sharp picks beat more mediocre ones.`;

  const body = {
    system_instruction: {
      parts: [{ text: 'You are a sharp NBA player props analyst. Only pick props with confirmed lines from DraftKings or FanDuel. Apply all filters: positional defense, pace, recent form, injury impact, and minimum 15-game sample size. Return only valid JSON.' }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3 },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Gemini NBA props error: ${res.status} ${text.slice(0, 200)}`);
    return [];
  }

  const json = await res.json();
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"playerProps":[]}';
  console.log(`  NBA Props raw (first 400): ${raw.slice(0, 400)}`);

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed.playerProps ?? [];
  } catch {
    console.error('Failed to parse NBA player props JSON:', raw.slice(0, 300));
    return [];
  }
}

// ─── Build structured game context ────────────────────────────────────────
async function buildContext(sport, dateStr) {
  const [games, injuryMap, oddsMap] = await Promise.all([
    fetchEspnGames(sport, dateStr),
    fetchAllInjuries(sport),
    fetchOddsForSport(sport, dateStr),
  ]);

  const hasOdds = Object.keys(oddsMap).length > 0;
  if (games.length === 0 && !hasOdds) return { hasGames: false, structuredContext: '', games: [] };

  const gameList = games.length > 0 ? games : Object.values(oddsMap).map(o => ({
    awayTeam: '', awayName: o.awayTeam, awayRecord: '',
    homeTeam: '', homeName: o.homeTeam, homeRecord: '',
  }));

  const lines = [`=== ${sport} Verified Lines & Injuries (${dateStr}) ===`];
  for (const g of gameList) {
    const odds = games.length > 0 ? matchOdds(g, oddsMap) : Object.values(oddsMap).find(o => o.awayTeam === g.awayName);
    lines.push(`\n${g.awayName || '?'} (${g.awayRecord}) @ ${g.homeName || '?'} (${g.homeRecord})`);
    if (odds?.bestSpread) lines.push(`  Spread: ${g.awayName} ${odds.bestSpread.awayPoint > 0 ? '+' : ''}${odds.bestSpread.awayPoint} (${fmt(odds.bestSpread.awayOdds)}) | ${g.homeName} ${odds.bestSpread.homePoint > 0 ? '+' : ''}${odds.bestSpread.homePoint} (${fmt(odds.bestSpread.homeOdds)})`);
    if (odds?.bestTotal) lines.push(`  Total: O/U ${odds.bestTotal.point} — Over (${fmt(odds.bestTotal.overOdds)}) / Under (${fmt(odds.bestTotal.underOdds)})`);
    if (odds?.bestML) lines.push(`  Moneyline: ${g.awayName} (${fmt(odds.bestML.awayOdds)}) / ${g.homeName} (${fmt(odds.bestML.homeOdds)})`);
    if (!odds) lines.push(`  Lines: not yet available`);
    // injuryMap keyed by full team display name (e.g. "Minnesota Timberwolves")
    const awayInj = injuryMap[g.awayName] ?? [];
    const homeInj = injuryMap[g.homeName] ?? [];
    if (awayInj.length) lines.push(`  ${g.awayName} OFFICIAL injuries: ${awayInj.join(', ')}`);
    else lines.push(`  ${g.awayName} OFFICIAL injuries: none listed — assume all players available`);
    if (homeInj.length) lines.push(`  ${g.homeName} OFFICIAL injuries: ${homeInj.join(', ')}`);
    else lines.push(`  ${g.homeName} OFFICIAL injuries: none listed — assume all players available`);
  }

  console.log(`  ESPN games: ${games.length}, Odds games: ${Object.keys(oddsMap).length}`);
  return { hasGames: true, structuredContext: lines.join('\n'), games: gameList };
}

// ─── Stage 2: Gemini reasoning ────────────────────────────────────────────
async function getPicksForSport(sport, dateStr) {
  // Run Perplexity research and ESPN/Odds API fetching in parallel
  const [researchText, { hasGames, structuredContext, games }] = await Promise.all([
    researchSport(sport, dateStr),
    buildContext(sport, dateStr),
  ]);

  if (!hasGames) {
    console.log(`  No games/events found for ${sport} today — skipping`);
    return { picks: [], games: [] };
  }

  const prompt = `You are a sharp sports betting analyst generating the top 5 ${sport} picks for today, ${dateStr}.

You have been given two sources of data:

--- SOURCE 1: LIVE RESEARCH (from Perplexity web search) ---
${researchText || 'Not available — rely on verified lines below.'}

--- SOURCE 2: VERIFIED LINES & INJURIES (from ESPN + The Odds API) ---
${structuredContext || 'Not available — rely on research above.'}

---

INSTRUCTIONS:

1. USE EXACT LINES: For any spread, total, or moneyline pick, use only the exact odds from Source 2. Do not invent or estimate lines. If a game has no verified lines, skip it.

CRITICAL — INJURY AUTHORITY: Source 2 contains the OFFICIAL ESPN injury report. This is the ground truth. A player is OUT only if listed as "Out" in Source 2. If Source 2 says "none listed — assume all players available" for a team, treat ALL players as available regardless of what Source 1 (Perplexity) says. Do NOT assume a player is out based on Perplexity alone — Perplexity can return stale or incorrect injury data. Never build a high-confidence pick around a player absence that isn't confirmed in Source 2.

2. PICK VARIETY: Your 5 picks must include a mix — do not pick all spreads. Include at least:
   - 1–2 spread picks
   - 1–2 total (over/under) picks
   - 1 player prop OR underdog moneyline (use research to identify a specific player prop angle; if prop odds aren't available in Source 2, you may estimate odds for props only and note it)
   - At least 1 pick with positive odds

3. QUALITY OVER QUANTITY: Only pick games where the research reveals a genuine edge — injury impact, line movement, situational angle, or clear matchup advantage. Skip a game if there is no real edge.

4. CURRENT ROSTERS ONLY: For player props, confirm the player is actually on that team TODAY using Source 1 (Perplexity research). Never assume player-team assignments from memory — trades happen constantly. If you cannot confirm the player's current team from the research, skip that prop.

4. RATIONALE (5–6 sentences each, mandatory):
   - Name specific injured players and explain exactly how their absence changes the matchup
   - Cite the team's recent form and record
   - Reference a head-to-head or situational trend from the research
   - Describe the specific matchup edge creating betting value
   - Explain what line movement or sharp action (if any) signals
   - End with what needs to happen for the pick to hit

If ${sport} has no games today, return: {"picks": []}

Return ONLY valid JSON, no markdown:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "e.g. 'Celtics -5.5' or 'Over 224.5' or 'LeBron James Over 25.5 Points'",
      "odds": "-110",
      "confidence": "high|medium",
      "rationale": "5–6 sentences with specific injury impact, team records, h2h trends, line movement, matchup edge, and what needs to happen"
    }
  ]
}`;

  const body = {
    system_instruction: {
      parts: [{ text: 'You are a sharp sports betting analyst. You receive live research from Perplexity and verified lines from ESPN and The Odds API. Use exact lines from the verified data — never estimate spreads, totals, or moneylines. You may estimate odds for player props if no line is available. Produce 5 picks with varied bet types and 5–6 sentence rationales citing specific data. Return only valid JSON. CRITICAL: For player props, use ONLY the player-team assignments from the Perplexity research — never assume a player is on a team based on training data, as rosters change constantly via trades and free agency. If the research does not confirm a player is on a given team for today\'s game, do not pick that player.' }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4 },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    parsed.picks = (parsed.picks ?? []).filter(p => {
      if (p.betType === 'moneyline') return parseInt(p.odds ?? '0') > -401;
      return true;
    });
    return { picks: parsed.picks, games };
  } catch {
    console.error(`Failed to parse picks JSON for ${sport}:`, raw);
    return { picks: [], games };
  }
}

// ─── Player prop grading ──────────────────────────────────────────────────

// Maps pick text stat names → ESPN box score column headers
const PROP_STAT_KEYS = {
  // NBA
  'points': 'PTS',
  'rebounds': 'REB',
  'assists': 'AST',
  'steals': 'STL',
  'blocks': 'BLK',
  'three pointers': '3PT',
  'three-pointers': '3PT',
  'threes': '3PT',
  'turnovers': 'TO',
  // NHL (use distinct keys so NBA 'assists'→'AST' is not overwritten)
  'goals': 'G',
  'nhl assists': 'A',
  'saves': 'SV',
  'shots': 'SOG',
  'shots on goal': 'SOG',
  // MLB
  'hits': 'H',
  'home runs': 'HR',
  'rbis': 'RBI',
  'rbi': 'RBI',
  'strikeouts': 'K',
  'walks': 'BB',
  'runs': 'R',
  'runs batted in': 'RBI',
  'earned runs': 'ER',
  'innings pitched': 'IP',
  // "total bases" intentionally omitted — not a raw ESPN stat
};

function playerNameMatches(espnName, pickName) {
  const a = (espnName ?? '').toLowerCase().trim();
  const b = (pickName ?? '').toLowerCase().trim();
  if (a === b) return true;
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  const aLast = aParts[aParts.length - 1];
  const bLast = bParts[bParts.length - 1];
  if (aLast !== bLast) return false;
  return aParts[0][0] === bParts[0][0]; // same last name + same first initial
}

function findPlayerStat(summaryData, playerName, statKey) {
  const teams = summaryData.boxscore?.players ?? [];
  for (const teamData of teams) {
    for (const statGroup of (teamData.statistics ?? [])) {
      const colIndex = (statGroup.names ?? []).indexOf(statKey);
      if (colIndex === -1) continue;
      const athlete = (statGroup.athletes ?? []).find(a =>
        playerNameMatches(a.athlete?.displayName, playerName) ||
        playerNameMatches(a.athlete?.shortName, playerName)
      );
      if (!athlete) continue;
      const raw = athlete.stats?.[colIndex] ?? '';
      // "3-4" format (made-attempted) → parseFloat gives made count
      const value = parseFloat(raw);
      if (isNaN(value)) continue;
      return { value, display: raw };
    }
  }
  return null;
}

async function gradePropPick(pick, event, sport) {
  const espn = ESPN_MAP[sport];
  if (!espn) return { result: '?', score: '' };

  // Expected format: "Player Name Over/Under X.Y Stat Name"
  const m = pick.pick.trim().match(/^(.+?)\s+(Over|Under)\s+([\d.]+)\s+(.+)$/i);
  if (!m) return { result: '?', score: '' };

  const [, playerName, direction, lineStr, rawStat] = m;
  const line = parseFloat(lineStr);
  const dir = direction.toLowerCase();
  const statKey = PROP_STAT_KEYS[rawStat.toLowerCase().trim()];

  if (!statKey) {
    console.log(`  Prop stat not supported: "${rawStat}"`);
    return { result: '?', score: `${playerName}: "${rawStat}" not auto-gradeable` };
  }

  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/summary?event=${event.id}`
    );
    if (!res.ok) return { result: '?', score: '' };
    const data = await res.json();

    const found = findPlayerStat(data, playerName, statKey);
    if (!found) {
      console.log(`  Prop: player/stat not found in box score — ${playerName} ${statKey}`);
      return { result: '?', score: `${playerName}: not found in box score` };
    }

    const { value, display } = found;
    let result;
    if (value > line) result = dir === 'over' ? 'W' : 'L';
    else if (value < line) result = dir === 'over' ? 'L' : 'W';
    else result = 'P';

    const score = `${playerName}: ${display} ${rawStat} (line ${lineStr})`;
    console.log(`  ${pick.pick}: ${result} (${score})`);
    return { result, score };
  } catch (e) {
    console.error(`  Prop grading error:`, e.message);
    return { result: '?', score: '' };
  }
}

// ─── Results grading ──────────────────────────────────────────────────────
function lastWord(s) {
  return (s ?? '').trim().toLowerCase().split(/\s+/).pop() ?? '';
}

function findMatchingEvent(gameName, events) {
  // gameName: "Away Team vs Home Team"
  const parts = gameName.split(' vs ');
  if (parts.length !== 2) return null;
  const awayKey = lastWord(parts[0].trim());
  const homeKey = lastWord(parts[1].trim());
  for (const event of events) {
    const comps = event.competitions?.[0]?.competitors ?? [];
    const homeComp = comps.find(c => c.homeAway === 'home');
    const awayComp = comps.find(c => c.homeAway === 'away');
    if (!homeComp || !awayComp) continue;
    const hKey = lastWord(homeComp.team?.displayName ?? '');
    const aKey = lastWord(awayComp.team?.displayName ?? '');
    if (aKey === awayKey && hKey === homeKey) return event;
    if (aKey === homeKey && hKey === awayKey) return event; // reversed order
  }
  return null;
}

function gradeOnePick(pick, event) {
  const comps = event.competitions?.[0]?.competitors ?? [];
  const homeComp = comps.find(c => c.homeAway === 'home');
  const awayComp = comps.find(c => c.homeAway === 'away');
  if (!homeComp || !awayComp) return { result: '?', score: '' };

  const homeScore = parseFloat(homeComp.score ?? '0');
  const awayScore = parseFloat(awayComp.score ?? '0');
  const homeName = homeComp.team?.displayName ?? '';
  const awayName = awayComp.team?.displayName ?? '';
  const scoreStr = `${awayName} ${awayScore}, ${homeName} ${homeScore}`;

  const text = pick.pick.trim();
  let result = '?';

  if (pick.betType === 'total') {
    // Allow extra words after number: "Under 6.5 Goals", "Under 7.5 Runs"
    const m = text.match(/^(Over|Under)\s+([\d.]+)/i);
    if (m) {
      const line = parseFloat(m[2]);
      const total = homeScore + awayScore;
      if (total === line) result = 'P';
      else result = m[1].toLowerCase() === 'over' ? (total > line ? 'W' : 'L') : (total < line ? 'W' : 'L');
    }
  } else if (pick.betType === 'moneyline') {
    // Strip trailing odds/suffix variants:
    //   "Philadelphia Flyers ML" → "Philadelphia Flyers"
    //   "Braves -175" → "Braves"
    //   "Portland Trail Blazers (+100)" → "Portland Trail Blazers"
    const cleanText = text
      .replace(/\s+ML$/i, '')              // "... ML"
      .replace(/\s+\([+-]?\d+\)$/, '')    // " (+100)" or " (-118)"
      .replace(/\s+[+-]\d+$/, '')          // " -175" or " +100"
      .trim();
    const pickedKey = lastWord(cleanText);
    const homeWon = homeScore > awayScore;
    const awayWon = awayScore > homeScore;
    if (lastWord(homeName) === pickedKey) result = homeWon ? 'W' : 'L'; // draw = L (soccer)
    else if (lastWord(awayName) === pickedKey) result = awayWon ? 'W' : 'L';
  } else if (pick.betType === 'spread') {
    const m = text.match(/^(.+?)\s+([+-][\d.]+)$/);
    if (m) {
      const pickedKey = lastWord(m[1].trim());
      const spread = parseFloat(m[2]);
      let pickedScore, opposingScore;
      if (lastWord(homeName) === pickedKey) { pickedScore = homeScore; opposingScore = awayScore; }
      else if (lastWord(awayName) === pickedKey) { pickedScore = awayScore; opposingScore = homeScore; }
      if (pickedScore !== undefined) {
        const margin = pickedScore - opposingScore + spread;
        if (margin > 0) result = 'W';
        else if (margin === 0) result = 'P';
        else result = 'L';
      }
    }
  }
  // prop → stays '?'

  return { result, score: scoreStr };
}

async function gradePicksForDate(picksData) {
  const { date, sports } = picksData;
  const gradedSports = [];

  for (const sportData of sports) {
    const espn = ESPN_MAP[sportData.sport];
    if (!espn) {
      // UFC — cannot auto-grade from ESPN
      gradedSports.push({
        sport: sportData.sport,
        picks: sportData.picks.map(p => ({
          game: p.game, betType: p.betType, pick: p.pick, odds: p.odds, confidence: p.confidence,
          result: '?', score: '',
        })),
      });
      continue;
    }

    let events = [];
    try {
      // Fetch picks date AND +1 UTC day: late-night MLB/NHL games that tip around
      // 7–10 PM ET start on picks-date in ET but complete after midnight UTC,
      // so ESPN may store the completed status under the next UTC date.
      const nextDate = new Date(date + 'T12:00:00Z');
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const nextDateStr = nextDate.toISOString().slice(0, 10).replace(/-/g, '');
      const [resA, resB] = await Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${date.replace(/-/g, '')}`),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${nextDateStr}`),
      ]);
      const eventsA = resA.ok ? ((await resA.json()).events ?? []) : [];
      const eventsB = resB.ok ? ((await resB.json()).events ?? []) : [];
      // Merge, deduplicate by event ID, keep only completed
      const seen = new Set();
      for (const e of [...eventsA, ...eventsB]) {
        if (e.status?.type?.completed && !seen.has(e.id)) {
          seen.add(e.id);
          events.push(e);
        }
      }
      console.log(`  ${sportData.sport} grading: ${events.length} completed events (${eventsA.length} + ${eventsB.length} raw)`);
    } catch { /* graceful — picks get '?' */ }

    const gradedPicks = await Promise.all(sportData.picks.map(async pick => {
      const event = findMatchingEvent(pick.game, events);
      if (!event) {
        console.log(`  No match found: ${pick.game}`);
        return { game: pick.game, betType: pick.betType, pick: pick.pick, odds: pick.odds, confidence: pick.confidence, result: '?', score: '' };
      }

      let result, score;
      if (pick.betType === 'prop') {
        ({ result, score } = await gradePropPick(pick, event, sportData.sport));
      } else {
        ({ result, score } = gradeOnePick(pick, event));
        console.log(`  ${pick.pick}: ${result} (${score})`);
      }

      return { game: pick.game, betType: pick.betType, pick: pick.pick, odds: pick.odds, confidence: pick.confidence, result, score };
    }));

    gradedSports.push({ sport: sportData.sport, picks: gradedPicks });
  }

  // ─── Grade player props (NBA only) ───────────────────────────────────────
  let gradedPlayerProps = picksData.playerProps ?? [];
  if (gradedPlayerProps.length > 0) {
    const espn = ESPN_MAP['NBA'];
    let nbaEvents = [];
    try {
      const nextDate = new Date(date + 'T12:00:00Z');
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const nextDateStr = nextDate.toISOString().slice(0, 10).replace(/-/g, '');
      const [resA, resB] = await Promise.all([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${date.replace(/-/g, '')}`),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${nextDateStr}`),
      ]);
      const eventsA = resA.ok ? ((await resA.json()).events ?? []) : [];
      const eventsB = resB.ok ? ((await resB.json()).events ?? []) : [];
      const seen = new Set();
      for (const e of [...eventsA, ...eventsB]) {
        if (e.status?.type?.completed && !seen.has(e.id)) {
          seen.add(e.id);
          nbaEvents.push(e);
        }
      }
      console.log(`  NBA props grading: ${nbaEvents.length} completed events`);
    } catch { /* graceful */ }
    } catch { /* graceful */ }

    gradedPlayerProps = await Promise.all(gradedPlayerProps.map(async prop => {
      const event = findMatchingEvent(prop.game, nbaEvents);
      if (!event) {
        console.log(`  Props: no game match for ${prop.game}`);
        return { ...prop, result: '?', score: '' };
      }
      const fakePick = { pick: prop.pick, betType: 'prop' };
      const { result, score } = await gradePropPick(fakePick, event, 'NBA');
      return { ...prop, result, score };
    }));
  }

  return { date, sports: gradedSports, playerProps: gradedPlayerProps };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  // Use ET date so manual runs after midnight UTC still produce the correct US date
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  const month = parseInt(dateStr.split('-')[1]);

  // ─── Grade yesterday's picks and update archive ──────────────────────────
  let archive = [];
  try {
    archive = JSON.parse(readFileSync('picks-archive.json', 'utf8'));
    if (!Array.isArray(archive)) archive = [];
  } catch { archive = []; }

  let yesterdayPicks = null;
  try {
    yesterdayPicks = JSON.parse(readFileSync('daily-picks.json', 'utf8'));
  } catch { }

  if (yesterdayPicks?.date && yesterdayPicks.date !== dateStr) {
    const existingEntry = archive.find(e => e.date === yesterdayPicks.date);
    // Re-grade if:
    // - not yet in archive, OR
    // - any pick still has '?' AND the entry is recent (within 3 days, so games are now finished)
    const hasAnyUngraded = existingEntry
      ? existingEntry.sports.some(s => s.picks.some(p => p.result === '?'))
      : false;
    const isRecent = existingEntry
      ? (new Date(dateStr) - new Date(existingEntry.date)) / 86400000 <= 3
      : false;
    const shouldGrade = !existingEntry || (hasAnyUngraded && isRecent);

    if (shouldGrade) {
      const reason = !existingEntry ? 'new entry' : 'has ungraded picks within 3-day window';
      console.log(`\nGrading picks for ${yesterdayPicks.date} (${reason})...`);
      try {
        const graded = await gradePicksForDate(yesterdayPicks);
        archive = archive.filter(e => e.date !== yesterdayPicks.date);
        archive.unshift(graded);
        archive = archive.slice(0, 30);
        writeFileSync('picks-archive.json', JSON.stringify(archive, null, 2));
        console.log(`Archived results for ${yesterdayPicks.date}`);
      } catch (e) {
        console.error('Failed to grade picks:', e.message);
      }
    } else {
      console.log(`\nPicks for ${yesterdayPicks.date} already fully graded.`);
    }
  }

  // Also re-grade any recent archive entries that still have ungraded picks
  // (catches cases where daily-picks.json jumped ahead but older entries are partial)
  const recentUngraded = archive.filter(e => {
    const daysDiff = (new Date(dateStr) - new Date(e.date)) / 86400000;
    return daysDiff >= 1 && daysDiff <= 3 && e.sports.some(s => s.picks.some(p => p.result === '?'));
  });
  for (const entry of recentUngraded) {
    console.log(`\nRe-grading archive entry ${entry.date} (partial results)...`);
    try {
      const graded = await gradePicksForDate(entry);
      archive = archive.map(e => e.date === entry.date ? graded : e);
      writeFileSync('picks-archive.json', JSON.stringify(archive, null, 2));
      console.log(`Re-graded ${entry.date}`);
    } catch (e) {
      console.error(`Failed to re-grade ${entry.date}:`, e.message);
    }
  }

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr}, In-season sports:`, inSeasonSports);

  const sports = [];
  for (const sport of inSeasonSports) {
    console.log(`\nFetching picks for ${sport}…`);
    try {
      const { picks, games } = await getPicksForSport(sport, dateStr);
      if (picks.length > 0) {
        // Attach records from ESPN game data
        for (const pick of picks) {
          const g = matchPickToGame(pick, games);
          if (g) {
            pick.awayRecord = g.awayRecord || undefined;
            pick.homeRecord = g.homeRecord || undefined;
          }
        }
        // Collect unique team abbreviations that appear in picks
        const teamSet = new Map();
        for (const pick of picks) {
          const g = matchPickToGame(pick, games);
          if (g) {
            if (g.awayTeam) teamSet.set(g.awayTeam, sport);
            if (g.homeTeam) teamSet.set(g.homeTeam, sport);
          }
        }
        // Fetch last5 in parallel for all matched teams
        const last5Map = {};
        if (teamSet.size > 0) {
          console.log(`  Fetching last5 for ${teamSet.size} teams…`);
          await Promise.all([...teamSet.entries()].map(async ([abbrev, sp]) => {
            last5Map[abbrev] = await fetchTeamLast5(sp, abbrev);
          }));
        }
        // Attach last5 to each pick
        for (const pick of picks) {
          const g = matchPickToGame(pick, games);
          if (g) {
            if (last5Map[g.awayTeam]?.length) pick.awayLast5 = last5Map[g.awayTeam];
            if (last5Map[g.homeTeam]?.length) pick.homeLast5 = last5Map[g.homeTeam];
          }
        }
        sports.push({ sport, picks });
        console.log(`  ✓ ${picks.length} picks`);
      } else {
        console.log(`  — No picks generated`);
      }
    } catch (err) {
      console.error(`  ✗ Error:`, err.message);
    }
  }

  // ─── NBA Player Props ──────────────────────────────────────────────────────
  let playerProps = [];
  if (inSeasonSports.includes('NBA')) {
    console.log('\nFetching NBA player props…');
    try {
      const [nbaGames, nbaInjuryMap] = await Promise.all([
        fetchEspnGames('NBA', dateStr),
        fetchAllInjuries('NBA'),
      ]);
      if (nbaGames.length > 0) {
        const propsResearch = await researchNBAPlayerProps(dateStr, nbaGames);
        playerProps = await getNBAPlayerProps(dateStr, propsResearch, nbaGames, nbaInjuryMap);
        console.log(`  ✓ ${playerProps.length} player props`);
      } else {
        console.log('  — No NBA games today');
      }
    } catch (err) {
      console.error('  ✗ NBA props error:', err.message);
    }
  }

  writeFileSync('daily-picks.json', JSON.stringify({ date: dateStr, generatedAt: now.toISOString(), sports, playerProps }, null, 2));
  console.log(`\nWrote ${sports.length} sport(s) + ${playerProps.length} player props to daily-picks.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
