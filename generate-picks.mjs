import { writeFileSync, readFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ODDS_API_KEY   = process.env.ODDS_API_KEY;

if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY is not set'); process.exit(1); }
if (!ODDS_API_KEY)   { console.error('ODDS_API_KEY is not set');   process.exit(1); }

// ─── Season calendar ───────────────────────────────────────────────────────
const SEASON_MONTHS = {
  NBA:      [10, 11, 12, 1, 2, 3, 4, 5, 6],
  NHL:      [10, 11, 12, 1, 2, 3, 4, 5, 6],
  MLB:      [4, 5, 6, 7, 8, 9, 10],
  NFL:      [9, 10, 11, 12, 1, 2],
  NCAAB:    [11, 12, 1, 2, 3, 4],
  MLS:      [3, 4, 5, 6, 7, 8, 9, 10, 11],
  UFC:      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  UCL:      [9, 10, 11, 12, 2, 3, 4, 5, 6],
  UEL:      [9, 10, 11, 12, 2, 3, 4, 5, 6],
  WORLDCUP: [6, 7],
};

const ESPN_MAP = {
  NBA:      { sport: 'basketball', league: 'nba' },
  NHL:      { sport: 'hockey',     league: 'nhl' },
  MLB:      { sport: 'baseball',   league: 'mlb' },
  NFL:      { sport: 'football',   league: 'nfl' },
  NCAAB:    { sport: 'basketball', league: 'mens-college-basketball' },
  MLS:      { sport: 'soccer',     league: 'usa.1' },
  UFC:      null,
  UCL:      { sport: 'soccer',     league: 'uefa.champions' },
  UEL:      { sport: 'soccer',     league: 'uefa.europa' },
  WORLDCUP: { sport: 'soccer',     league: 'fifa.world' },
};

const ODDS_SPORT_KEY = {
  NBA:      'basketball_nba',
  NHL:      'icehockey_nhl',
  MLB:      'baseball_mlb',
  NFL:      'americanfootball_nfl',
  NCAAB:    'basketball_ncaab',
  MLS:      'soccer_usa_mls',
  UFC:      'mma_mixed_martial_arts',
  UCL:      'soccer_uefa_champs_league',
  UEL:      'soccer_uefa_europa_league',
  WORLDCUP: 'soccer_fifa_world_cup',
};

const MAX_SPORTS = 8;

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
  const raw = (pick.game ?? '').replace(/ vs\. /gi, ' vs ');
  const parts = raw.includes(' vs ') ? raw.split(' vs ') : raw.split(' @ ');
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
    if (!res.ok) {
      const err = await res.text();
      console.error(`  Odds API error for ${sport}: ${res.status} ${err.slice(0, 200)}`);
      return {};
    }
    const games = await res.json();
    if (!Array.isArray(games)) {
      console.error(`  Odds API unexpected response for ${sport}:`, JSON.stringify(games).slice(0, 200));
      return {};
    }

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

// ─── Build structured game context (ESPN + Odds API, no Perplexity) ────────
async function buildContext(sport, dateStr) {
  const [games, oddsMap] = await Promise.all([
    fetchEspnGames(sport, dateStr),
    fetchOddsForSport(sport, dateStr),
  ]);

  const hasOdds = Object.keys(oddsMap).length > 0;
  if (games.length === 0 && !hasOdds) return { hasGames: false, structuredContext: '', games: [] };

  const gameList = games.length > 0 ? games : Object.values(oddsMap).map(o => ({
    awayTeam: '', awayName: o.awayTeam, awayRecord: '',
    homeTeam: '', homeName: o.homeTeam, homeRecord: '',
  }));

  const lines = [`=== ${sport} Verified Lines (${dateStr}) ===`];
  for (const g of gameList) {
    const odds = games.length > 0 ? matchOdds(g, oddsMap) : Object.values(oddsMap).find(o => o.awayTeam === g.awayName);
    lines.push(`\n${g.awayName || '?'} (${g.awayRecord}) @ ${g.homeName || '?'} (${g.homeRecord})`);
    if (odds?.bestSpread) lines.push(`  Spread: ${g.awayName} ${odds.bestSpread.awayPoint > 0 ? '+' : ''}${odds.bestSpread.awayPoint} (${fmt(odds.bestSpread.awayOdds)}) | ${g.homeName} ${odds.bestSpread.homePoint > 0 ? '+' : ''}${odds.bestSpread.homePoint} (${fmt(odds.bestSpread.homeOdds)})`);
    if (odds?.bestTotal) lines.push(`  Total: O/U ${odds.bestTotal.point} — Over (${fmt(odds.bestTotal.overOdds)}) / Under (${fmt(odds.bestTotal.underOdds)})`);
    if (odds?.bestML)    lines.push(`  Moneyline: ${g.awayName} (${fmt(odds.bestML.awayOdds)}) / ${g.homeName} (${fmt(odds.bestML.homeOdds)})`);
    if (!odds)           lines.push(`  Lines: not yet available`);
  }

  console.log(`  ESPN games: ${games.length}, Odds games: ${Object.keys(oddsMap).length}`);
  return { hasGames: true, structuredContext: lines.join('\n'), games: gameList };
}

// ─── Gemini picks (Google Search grounding replaces Perplexity) ────────────
async function getPicksForSport(sport, dateStr) {
  const { hasGames, structuredContext, games } = await buildContext(sport, dateStr);

  if (!hasGames) {
    console.log(`  No games/events found for ${sport} today — skipping`);
    return { picks: [], games: [] };
  }

  const prompt = `You are a sharp sports betting analyst. Today is ${dateStr}.

Search the web for today's ${sport} games, including:
- Current injury reports and lineup news (OUT, Doubtful, Questionable, load management)
- Each team's recent form (last 10 games W/L, current streak, home/away splits)
- Head-to-head history (last 5 matchups — who won, who covered, over/under trends)
- Line movement (opening line vs current — where is sharp money going?)
- Situational factors (back-to-backs, rest days, travel, playoff implications, revenge games)

Then generate the top 5 high-confidence ${sport} picks for today using the verified lines below.

--- VERIFIED LINES (ESPN + The Odds API) ---
${structuredContext}

---

INSTRUCTIONS:

1. USE EXACT LINES: Use only the spreads, totals, and moneylines from the verified data above. Do not invent or estimate lines. Skip any game with no verified lines.

2. INJURY AUTHORITY: Your web search is the source of truth for injuries. If a player is reported as OUT, injured, questionable, or on load management — do not build any pick around that player being active. Late scratches appear in news before official reports.

3. PICK VARIETY: Mix bet types across your 5 picks — do not pick all spreads or all totals.

4. QUALITY OVER QUANTITY: Only pick games where your research reveals a genuine edge. Skip a game if there is no real edge.

5. PLAYER PROPS: If you include a player prop, you MUST confirm via search that the player is active and on the team playing in that game today. The propTeam field must match one of the two teams in the game field exactly.

6. RATIONALE: 4–5 sentences per pick. Cite specific data from your search: injured players and their impact, recent form, h2h trend, line movement signal, and what needs to happen for the pick to hit.

If ${sport} has no games today, return {"picks": []}.`;

  const picksSchema = {
    type: 'OBJECT',
    properties: {
      picks: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            game:       { type: 'STRING' },
            betType:    { type: 'STRING', enum: ['spread', 'total', 'moneyline', 'prop'] },
            pick:       { type: 'STRING' },
            odds:       { type: 'STRING' },
            confidence: { type: 'STRING', enum: ['high', 'medium'] },
            rationale:  { type: 'STRING' },
            propPlayer: { type: 'STRING' },
            propTeam:   { type: 'STRING' },
          },
          required: ['game', 'betType', 'pick', 'odds', 'confidence', 'rationale'],
        },
      },
    },
    required: ['picks'],
  };

  const body = {
    system_instruction: {
      parts: [{ text: `You are a sharp sports betting analyst with access to live web search. Use search to find current injuries, lineup news, recent form, h2h history, and line movement for today's ${sport} games. Use exact lines from the verified data provided — never estimate spreads, totals, or moneylines. Produce 5 high-confidence picks with 4–5 sentence rationales citing specific searched data. For any player prop: confirm via search that the player is active and on one of the two teams in the game — propTeam must match exactly. If search reports a player as OUT, injured, or questionable, do not pick that player under any circumstances.` }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: picksSchema,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini error for ${sport}: ${res.status} ${text}`);
  }

  const json = await res.json();
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"picks":[]}';
  const sources = json.candidates?.[0]?.groundingMetadata?.groundingChunks?.length ?? 0;
  console.log(`  Search sources: ${sources} | Raw (first 300): ${raw.slice(0, 300)}`);

  try {
    const parsed = JSON.parse(raw);
    let picks = parsed.picks ?? [];

    // Drop heavy moneyline favourites
    picks = picks.filter(p => {
      if (p.betType === 'moneyline') return parseInt(p.odds ?? '0') > -401;
      return true;
    });

    // Hard validate props: propTeam last word must match a team in the game field
    picks = picks.filter(p => {
      if (p.betType !== 'prop') return true;
      const team = (p.propTeam ?? '').trim();
      if (!team) return true;
      const normalized = (p.game ?? '').replace(/ vs\. /gi, ' vs ');
      const parts = normalized.includes(' vs ') ? normalized.split(' vs ') : normalized.split(' @ ');
      if (parts.length !== 2) return true;
      const teamKeys = [
        parts[0].trim().toLowerCase().split(/\s+/).pop(),
        parts[1].trim().toLowerCase().split(/\s+/).pop(),
      ];
      const propKey = team.toLowerCase().split(/\s+/).pop();
      if (!teamKeys.includes(propKey)) {
        console.log(`  ✗ Dropping prop — "${team}" not in game "${p.game}" (player: ${p.propPlayer ?? p.pick})`);
        return false;
      }
      return true;
    });

    return { picks, games };
  } catch {
    console.error(`Failed to parse picks JSON for ${sport}:`, raw.slice(0, 300));
    return { picks: [], games };
  }
}

// ─── Player prop grading ──────────────────────────────────────────────────
const PROP_STAT_KEYS = {
  'points': 'PTS', 'rebounds': 'REB', 'assists': 'AST',
  'steals': 'STL', 'blocks': 'BLK',
  'three pointers': '3PT', 'three-pointers': '3PT', 'threes': '3PT',
  'turnovers': 'TO',
  'goals': 'G', 'nhl assists': 'A', 'saves': 'SV',
  'shots': 'SOG', 'shots on goal': 'SOG',
  'hits': 'H', 'home runs': 'HR', 'rbis': 'RBI', 'rbi': 'RBI',
  'strikeouts': 'K', 'walks': 'BB', 'runs': 'R',
  'runs batted in': 'RBI', 'earned runs': 'ER', 'innings pitched': 'IP',
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
  return aParts[0][0] === bParts[0][0];
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
    if (value > line)      result = dir === 'over' ? 'W' : 'L';
    else if (value < line) result = dir === 'over' ? 'L' : 'W';
    else                   result = 'P';

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
  const normalized = gameName.replace(/ vs\. /gi, ' vs ');
  const parts = normalized.includes(' vs ') ? normalized.split(' vs ') : normalized.split(' @ ');
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
    if (aKey === homeKey && hKey === awayKey) return event;
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
    const m = text.match(/^(Over|Under)\s+([\d.]+)/i);
    if (m) {
      const line = parseFloat(m[2]);
      const total = homeScore + awayScore;
      if (total === line) result = 'P';
      else result = m[1].toLowerCase() === 'over' ? (total > line ? 'W' : 'L') : (total < line ? 'W' : 'L');
    }
  } else if (pick.betType === 'moneyline') {
    const cleanText = text
      .replace(/\s+ML$/i, '')
      .replace(/\s+\([+-]?\d+\)$/, '')
      .replace(/\s+[+-]\d+$/, '')
      .trim();
    const pickedKey = lastWord(cleanText);
    const homeWon = homeScore > awayScore;
    const awayWon = awayScore > homeScore;
    if (lastWord(homeName) === pickedKey)      result = homeWon ? 'W' : 'L';
    else if (lastWord(awayName) === pickedKey) result = awayWon ? 'W' : 'L';
  } else if (pick.betType === 'spread') {
    const m = text.match(/^(.+?)\s+([+-][\d.]+)$/);
    if (m) {
      const pickedKey = lastWord(m[1].trim());
      const spread = parseFloat(m[2]);
      let pickedScore, opposingScore;
      if (lastWord(homeName) === pickedKey)      { pickedScore = homeScore; opposingScore = awayScore; }
      else if (lastWord(awayName) === pickedKey) { pickedScore = awayScore; opposingScore = homeScore; }
      if (pickedScore !== undefined) {
        const margin = pickedScore - opposingScore + spread;
        if (margin > 0)      result = 'W';
        else if (margin === 0) result = 'P';
        else                 result = 'L';
      }
    }
  }

  return { result, score: scoreStr };
}

async function gradePicksForDate(picksData) {
  const { date, sports } = picksData;
  const gradedSports = [];

  for (const sportData of sports) {
    const espn = ESPN_MAP[sportData.sport];
    if (!espn) {
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

  // Grade any playerProps from legacy entries (backward compat with old archive format)
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
        if (e.status?.type?.completed && !seen.has(e.id)) { seen.add(e.id); nbaEvents.push(e); }
      }
    } catch { /* graceful */ }

    gradedPlayerProps = await Promise.all(gradedPlayerProps.map(async prop => {
      const event = findMatchingEvent(prop.game, nbaEvents);
      if (!event) return { ...prop, result: '?', score: '' };
      const { result, score } = await gradePropPick({ pick: prop.pick, betType: 'prop' }, event, 'NBA');
      return { ...prop, result, score };
    }));
  }

  return { date, sports: gradedSports, playerProps: gradedPlayerProps };
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const month = parseInt(dateStr.split('-')[1]);

  // ─── Grade yesterday's picks ────────────────────────────────────────────
  let archive = [];
  try {
    archive = JSON.parse(readFileSync('picks-archive.json', 'utf8'));
    if (!Array.isArray(archive)) archive = [];
  } catch { archive = []; }

  let yesterdayPicks = null;
  try { yesterdayPicks = JSON.parse(readFileSync('daily-picks.json', 'utf8')); } catch { }

  if (yesterdayPicks?.date && yesterdayPicks.date !== dateStr) {
    const existingEntry = archive.find(e => e.date === yesterdayPicks.date);
    const hasAnyUngraded = existingEntry
      ? existingEntry.sports.some(s => s.picks.some(p => p.result === '?'))
        || (existingEntry.playerProps ?? []).some(p => p.result === '?')
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

  // ─── Re-grade recent archive entries with pending picks ─────────────────
  function hasGradablePendingPicks(entry) {
    const gamePicksGradable = entry.sports.some(s => {
      if (!ESPN_MAP[s.sport]) return false;
      return s.picks.some(p => {
        if (p.result !== '?') return false;
        if (p.betType === 'prop') {
          const m = p.pick.trim().match(/^.+?\s+(?:Over|Under)\s+[\d.]+\s+(.+)$/i);
          return m ? !!PROP_STAT_KEYS[m[1].toLowerCase().trim()] : false;
        }
        return true;
      });
    });
    const propPicksGradable = (entry.playerProps ?? []).some(p => {
      if (p.result !== '?') return false;
      const m = (p.pick ?? '').trim().match(/^.+?\s+(?:Over|Under)\s+[\d.]+\s+(.+)$/i);
      return m ? !!PROP_STAT_KEYS[m[1].toLowerCase().trim()] : false;
    });
    return gamePicksGradable || propPicksGradable;
  }

  const recentUngraded = archive.filter(e => {
    const daysDiff = (new Date(dateStr) - new Date(e.date)) / 86400000;
    return daysDiff >= 1 && daysDiff <= 3 && hasGradablePendingPicks(e);
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

  // ─── Generate today's picks ─────────────────────────────────────────────
  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr}, In-season sports:`, inSeasonSports);

  const sports = [];
  for (const sport of inSeasonSports) {
    console.log(`\nFetching picks for ${sport}…`);
    try {
      const { picks, games } = await getPicksForSport(sport, dateStr);
      if (picks.length > 0) {
        // Attach records and last5 from ESPN game data
        for (const pick of picks) {
          const g = matchPickToGame(pick, games);
          if (g) {
            pick.awayRecord = g.awayRecord || undefined;
            pick.homeRecord = g.homeRecord || undefined;
          }
        }
        const teamSet = new Map();
        for (const pick of picks) {
          const g = matchPickToGame(pick, games);
          if (g) {
            if (g.awayTeam) teamSet.set(g.awayTeam, sport);
            if (g.homeTeam) teamSet.set(g.homeTeam, sport);
          }
        }
        if (teamSet.size > 0) {
          console.log(`  Fetching last5 for ${teamSet.size} teams…`);
          const last5Map = {};
          await Promise.all([...teamSet.entries()].map(async ([abbrev, sp]) => {
            last5Map[abbrev] = await fetchTeamLast5(sp, abbrev);
          }));
          for (const pick of picks) {
            const g = matchPickToGame(pick, games);
            if (g) {
              if (last5Map[g.awayTeam]?.length) pick.awayLast5 = last5Map[g.awayTeam];
              if (last5Map[g.homeTeam]?.length) pick.homeLast5 = last5Map[g.homeTeam];
            }
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

  writeFileSync('daily-picks.json', JSON.stringify({ date: dateStr, generatedAt: now.toISOString(), sports, playerProps: [] }, null, 2));
  console.log(`\nWrote ${sports.length} sport(s) to daily-picks.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
