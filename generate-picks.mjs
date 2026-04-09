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
      for (const inj of (teamEntry.injuries ?? [])) {
        const abbrev = inj.athlete?.team?.abbreviation;
        const status = inj.status ?? inj.type?.description ?? '';
        const name = inj.athlete?.displayName ?? 'Unknown';
        if (!abbrev) continue;
        if (!['out', 'doubtful', 'questionable', 'day-to-day'].some(s => status.toLowerCase().includes(s))) continue;
        if (!map[abbrev]) map[abbrev] = [];
        map[abbrev].push(`${name} (${status})`);
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

// ─── Build structured game context ────────────────────────────────────────
async function buildContext(sport, dateStr) {
  const [games, injuryMap, oddsMap] = await Promise.all([
    fetchEspnGames(sport, dateStr),
    fetchAllInjuries(sport),
    fetchOddsForSport(sport, dateStr),
  ]);

  const hasOdds = Object.keys(oddsMap).length > 0;
  if (games.length === 0 && !hasOdds) return { hasGames: false, structuredContext: '' };

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
    const awayInj = injuryMap[g.awayTeam] ?? [];
    const homeInj = injuryMap[g.homeTeam] ?? [];
    if (awayInj.length) lines.push(`  ${g.awayTeam} injuries: ${awayInj.join(', ')}`);
    if (homeInj.length) lines.push(`  ${g.homeTeam} injuries: ${homeInj.join(', ')}`);
  }

  console.log(`  ESPN games: ${games.length}, Odds games: ${Object.keys(oddsMap).length}`);
  return { hasGames: true, structuredContext: lines.join('\n') };
}

// ─── Stage 2: Gemini reasoning ────────────────────────────────────────────
async function getPicksForSport(sport, dateStr) {
  // Run Perplexity research and ESPN/Odds API fetching in parallel
  const [researchText, { hasGames, structuredContext }] = await Promise.all([
    researchSport(sport, dateStr),
    buildContext(sport, dateStr),
  ]);

  if (!hasGames && !researchText) {
    console.log(`  No data found for ${sport}`);
    return [];
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

2. PICK VARIETY: Your 5 picks must include a mix — do not pick all spreads. Include at least:
   - 1–2 spread picks
   - 1–2 total (over/under) picks
   - 1 player prop OR underdog moneyline (use research to identify a specific player prop angle; if prop odds aren't available in Source 2, you may estimate odds for props only and note it)
   - At least 1 pick with positive odds

3. QUALITY OVER QUANTITY: Only pick games where the research reveals a genuine edge — injury impact, line movement, situational angle, or clear matchup advantage. Skip a game if there is no real edge.

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
      parts: [{ text: 'You are a sharp sports betting analyst. You receive live research from Perplexity and verified lines from ESPN and The Odds API. Use exact lines from the verified data — never estimate spreads, totals, or moneylines. You may estimate odds for player props if no line is available. Produce 5 picks with varied bet types and 5–6 sentence rationales citing specific data. Return only valid JSON.' }],
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
    return parsed.picks;
  } catch {
    console.error(`Failed to parse picks JSON for ${sport}:`, raw);
    return [];
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
    // Strip trailing "ML" suffix if present: "Philadelphia Flyers ML" → "Philadelphia Flyers"
    const cleanText = text.replace(/\s+ML$/i, '').trim();
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
      const res = await fetch(
        `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${date.replace(/-/g, '')}`
      );
      if (res.ok) {
        const data = await res.json();
        events = (data.events ?? []).filter(e => e.status?.type?.completed === true);
        console.log(`  ${sportData.sport} grading: ${events.length} completed events`);
      }
    } catch { /* graceful — picks get '?' */ }

    const gradedPicks = sportData.picks.map(pick => {
      const event = findMatchingEvent(pick.game, events);
      if (!event) {
        console.log(`  No match found: ${pick.game}`);
        return { game: pick.game, betType: pick.betType, pick: pick.pick, odds: pick.odds, confidence: pick.confidence, result: '?', score: '' };
      }
      const { result, score } = gradeOnePick(pick, event);
      console.log(`  ${pick.pick}: ${result} (${score})`);
      return { game: pick.game, betType: pick.betType, pick: pick.pick, odds: pick.odds, confidence: pick.confidence, result, score };
    });

    gradedSports.push({ sport: sportData.sport, picks: gradedPicks });
  }

  return { date, sports: gradedSports };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const dateStr = now.toISOString().slice(0, 10);

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
    const alreadyArchived = archive.some(e => e.date === yesterdayPicks.date);
    if (!alreadyArchived) {
      console.log(`\nGrading picks for ${yesterdayPicks.date}...`);
      try {
        const graded = await gradePicksForDate(yesterdayPicks);
        archive.unshift(graded);
        archive = archive.slice(0, 30);
        writeFileSync('picks-archive.json', JSON.stringify(archive, null, 2));
        console.log(`Archived results for ${yesterdayPicks.date}`);
      } catch (e) {
        console.error('Failed to grade picks:', e.message);
      }
    } else {
      console.log(`\nPicks for ${yesterdayPicks.date} already archived.`);
    }
  }

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr}, In-season sports:`, inSeasonSports);

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

main().catch(err => { console.error(err); process.exit(1); });
