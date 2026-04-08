import { writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}

// ─── Season calendar ────────────────────────────────────────────────────────
const SEASON_MONTHS = {
  NBA: [10, 11, 12, 1, 2, 3, 4, 5, 6],
  NHL: [10, 11, 12, 1, 2, 3, 4, 5, 6],
  MLB: [4, 5, 6, 7, 8, 9, 10],
  NFL: [9, 10, 11, 12, 1, 2],
  MLS: [3, 4, 5, 6, 7, 8, 9, 10, 11],
  UFC: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};

// ESPN scoreboard keys (sport/league path)
const ESPN_KEYS = {
  NBA: 'basketball/nba',
  NHL: 'hockey/nhl',
  MLB: 'baseball/mlb',
  NFL: 'football/nfl',
  MLS: 'soccer/usa.1',
};

// ESPN sport + league for team-specific endpoints (injuries, records)
const ESPN_SPORT_CONFIG = {
  NBA: { sport: 'basketball', league: 'nba' },
  NHL: { sport: 'hockey',     league: 'nhl' },
  MLB: { sport: 'baseball',   league: 'mlb' },
  NFL: { sport: 'football',   league: 'nfl' },
  MLS: { sport: 'soccer',     league: 'usa.1' },
};

const MAX_SPORTS = 5;

function getInSeasonSports(month) {
  return Object.entries(SEASON_MONTHS)
    .filter(([, months]) => months.includes(month))
    .map(([sport]) => sport)
    .slice(0, MAX_SPORTS);
}

// ─── ESPN scoreboard ─────────────────────────────────────────────────────────
async function getTodaysGames(sport, todayET) {
  const key = ESPN_KEYS[sport];
  if (!key) return []; // UFC — handled by Gemini search

  // ?dates=YYYYMMDD explicitly requests today's schedule
  const espnDate = todayET.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard?dates=${espnDate}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    const events = data.events ?? [];
    return events.map((e) => {
      const comps = e.competitions?.[0];
      const home = comps?.competitors?.find((c) => c.homeAway === 'home');
      const away = comps?.competitors?.find((c) => c.homeAway === 'away');
      const overallRecord = (comp) =>
        comp?.records?.find((r) => r.name === 'overall')?.summary ?? '';
      const homeRecord = (comp) =>
        comp?.records?.find((r) => r.name === 'home' || r.name === 'Home')?.summary ?? '';
      const awayRecord = (comp) =>
        comp?.records?.find((r) => r.name === 'away' || r.name === 'Road')?.summary ?? '';
      return {
        game:         `${away?.team?.displayName ?? 'Away'} vs ${home?.team?.displayName ?? 'Home'}`,
        awayTeam:     away?.team?.displayName ?? '',
        homeTeam:     home?.team?.displayName ?? '',
        awayAbbrev:   away?.team?.abbreviation?.toLowerCase() ?? '',
        homeAbbrev:   home?.team?.abbreviation?.toLowerCase() ?? '',
        awayOverall:  overallRecord(away),
        awayHomeRec:  awayRecord(away),
        homeOverall:  overallRecord(home),
        homeHomeRec:  homeRecord(home),
        time:         e.date,
        status:       comps?.status?.type?.description ?? '',
      };
    }).filter((g) => g.status !== 'Final');
  } catch (err) {
    console.error(`  ESPN fetch failed for ${sport}:`, err.message);
    return [];
  }
}

// ─── ESPN injury report for one team ─────────────────────────────────────────
async function fetchTeamInjuries(sport, teamAbbrev) {
  const cfg = ESPN_SPORT_CONFIG[sport];
  if (!cfg || !teamAbbrev) return [];

  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/teams/${teamAbbrev}/injuries`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.injuries ?? data.items ?? [];
    if (!Array.isArray(items) || items.length === 0) return [];
    return items.slice(0, 8).map((inj) => {
      const name   = inj.athlete?.displayName ?? 'Unknown';
      const pos    = inj.athlete?.position?.abbreviation ?? '';
      const status = inj.status ?? '';
      const desc   = inj.longComment ?? inj.details?.fantasyStatus?.description ?? '';
      return `${name}${pos ? ` (${pos})` : ''} — ${status}${desc ? `: ${desc}` : ''}`;
    });
  } catch {
    return [];
  }
}

// ─── Build rich per-game context with records + injuries ──────────────────────
async function buildGameContext(sport, games) {
  // Collect unique team abbreviations across all games
  const abbrevs = [...new Set(
    games.flatMap((g) => [g.awayAbbrev, g.homeAbbrev].filter(Boolean))
  )];

  // Fetch all injury reports in parallel
  const injuryEntries = await Promise.all(
    abbrevs.map(async (abbrev) => [abbrev, await fetchTeamInjuries(sport, abbrev)])
  );
  const injuryMap = Object.fromEntries(injuryEntries);

  return games.map((g) => {
    const awayInj  = injuryMap[g.awayAbbrev] ?? [];
    const homeInj  = injuryMap[g.homeAbbrev] ?? [];

    const awayRecStr = [g.awayOverall && `${g.awayOverall} overall`, g.awayHomeRec && `${g.awayHomeRec} away`]
      .filter(Boolean).join(', ');
    const homeRecStr = [g.homeOverall && `${g.homeOverall} overall`, g.homeHomeRec && `${g.homeHomeRec} home`]
      .filter(Boolean).join(', ');

    let ctx = `${g.awayTeam}${awayRecStr ? ` (${awayRecStr})` : ''} at ${g.homeTeam}${homeRecStr ? ` (${homeRecStr})` : ''}`;
    ctx += `\n  ${g.awayTeam} injuries: ${awayInj.length > 0 ? awayInj.join(' | ') : 'none reported'}`;
    ctx += `\n  ${g.homeTeam} injuries: ${homeInj.length > 0 ? homeInj.join(' | ') : 'none reported'}`;
    return ctx;
  }).join('\n\n');
}

// ─── Gemini picks ─────────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr, games) {
  let gamesContext;

  if (games.length > 0) {
    console.log(`  Building ESPN context (records + injuries)...`);
    const richContext = await buildGameContext(sport, games);
    gamesContext = `Today's ${sport} games — records and injury reports pulled from ESPN:\n\n${richContext}`;
  } else {
    gamesContext = `Search for any ${sport} games scheduled today (${dateStr}).`;
  }

  const prompt = `You are a sharp sports betting analyst generating picks for ${dateStr}.

${gamesContext}

Using the injury and record data above as your foundation, also use Google Search to find:
- Current spread, total, and moneyline odds from DraftKings, FanDuel, or BetMGM
- Any lineup news or late scratches not yet reflected above
- Recent form (last 5-10 games), back-to-back situations, travel fatigue
- Head-to-head history between each matchup
- Public betting splits and line movement

Generate 5 high-value ${sport} betting picks. Rules:
- Only pick from the real games listed above
- Use the ACTUAL current lines you find via search — never fabricate odds or point spreads
- No moneyline picks with odds shorter than -400
- Prioritize spreads, totals, and player props
- Include at least 1 underdog or positive-odds pick
- If genuinely no games today for this sport, return {"picks":[]}

Rationale must be 5-6 sentences and explicitly reference: the specific injury situation from above, the actual current line you found via search, recent form or home/away record, head-to-head context, and the exact edge you are exploiting.

Return only this JSON — no markdown, no code fences, no extra text:
{"picks":[{"game":"Away Team vs Home Team","betType":"spread|total|moneyline|prop","pick":"e.g. Lakers +4.5 or Over 224.5","odds":"-110","confidence":"high|medium","rationale":"5-6 sentences with real data"}]}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: 'You are a sharp sports betting analyst. Use the provided ESPN data plus Google Search to generate picks grounded in real current information. Return only valid JSON with no markdown.' }],
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.3 },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  // google_search responses have multiple parts; find the text part
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.find((p) => p.text)?.text ?? '{"picks":[]}';
  console.log(`  Raw (first 300): ${raw.slice(0, 300)}`);

  // Extract JSON from response (may have surrounding prose)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log('  No JSON found in response');
    return [];
  }

  const parsed = JSON.parse(jsonMatch[0]);
  return (parsed.picks ?? []).filter((p) => {
    if (p.betType === 'moneyline') return parseInt(p.odds ?? '0') > -401;
    return true;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const dateStr = now.toISOString().slice(0, 10);
  const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr} | ET date: ${todayET} | Sports: ${inSeasonSports.join(', ')}`);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`\n── ${sport}`);
    try {
      const games = await getTodaysGames(sport, todayET);
      console.log(`  ESPN games found: ${games.length} (${games.map((g) => g.game).join(' | ') || 'none'})`);

      const picks = await getPicksForSport(sport, dateStr, games);
      console.log(`  Picks: ${picks.length}`);

      if (picks.length > 0) sports.push({ sport, picks });
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  writeFileSync('daily-picks.json', JSON.stringify({ date: dateStr, generatedAt: now.toISOString(), sports }, null, 2));
  console.log(`\nDone — ${sports.length} sport(s) written`);
}

main().catch((err) => { console.error(err); process.exit(1); });
