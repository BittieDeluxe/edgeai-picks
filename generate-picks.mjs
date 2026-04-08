import { writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}

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

const MAX_SPORTS = 5;

function getInSeasonSports(month) {
  return Object.entries(SEASON_MONTHS)
    .filter(([, months]) => months.includes(month))
    .map(([sport]) => sport)
    .slice(0, MAX_SPORTS);
}

// ─── ESPN sport config ─────────────────────────────────────────────────────
const ESPN_CONFIG = {
  NBA:   { key: 'basketball/nba',   sport: 'basketball', league: 'nba'   },
  NHL:   { key: 'hockey/nhl',       sport: 'hockey',     league: 'nhl'   },
  MLB:   { key: 'baseball/mlb',     sport: 'baseball',   league: 'mlb'   },
  NFL:   { key: 'football/nfl',     sport: 'football',   league: 'nfl'   },
  NCAAB: { key: 'basketball/mens-college-basketball', sport: 'basketball', league: 'mens-college-basketball' },
  MLS:   { key: 'soccer/usa.1',     sport: 'soccer',     league: 'usa.1' },
};

// ─── ESPN: today's games with records ─────────────────────────────────────
async function getTodaysGames(sport, todayET) {
  const cfg = ESPN_CONFIG[sport];
  if (!cfg) return [];

  const espnDate = todayET.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.key}/scoreboard?dates=${espnDate}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.events ?? []).map((e) => {
      const comps = e.competitions?.[0];
      const home = comps?.competitors?.find((c) => c.homeAway === 'home');
      const away = comps?.competitors?.find((c) => c.homeAway === 'away');
      const rec = (comp, type) => comp?.records?.find((r) => r.name === type)?.summary ?? '';
      return {
        awayTeam:   away?.team?.displayName ?? '',
        homeTeam:   home?.team?.displayName ?? '',
        awayAbbrev: away?.team?.abbreviation?.toLowerCase() ?? '',
        homeAbbrev: home?.team?.abbreviation?.toLowerCase() ?? '',
        awayRecord: rec(away, 'overall'),
        awayAway:   rec(away, 'Road') || rec(away, 'away'),
        homeRecord: rec(home, 'overall'),
        homeHome:   rec(home, 'Home') || rec(home, 'home'),
        status:     comps?.status?.type?.description ?? '',
      };
    }).filter((g) => g.status !== 'Final');
  } catch {
    return [];
  }
}

// ─── ESPN: injury report for one team ─────────────────────────────────────
async function fetchInjuries(sport, abbrev) {
  const cfg = ESPN_CONFIG[sport];
  if (!cfg || !abbrev) return [];
  const url = `https://site.api.espn.com/apis/site/v2/sports/${cfg.sport}/${cfg.league}/teams/${abbrev}/injuries`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.injuries ?? data.items ?? [];
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

// ─── Build ESPN context block ──────────────────────────────────────────────
async function buildESPNContext(sport, todayET) {
  const games = await getTodaysGames(sport, todayET);
  if (games.length === 0) return null;

  // Fetch all team injuries in parallel
  const abbrevs = [...new Set(games.flatMap((g) => [g.awayAbbrev, g.homeAbbrev].filter(Boolean)))];
  const injResults = await Promise.all(abbrevs.map(async (a) => [a, await fetchInjuries(sport, a)]));
  const injMap = Object.fromEntries(injResults);

  const lines = games.map((g) => {
    const awayRec = [g.awayRecord && `${g.awayRecord} overall`, g.awayAway && `${g.awayAway} away`].filter(Boolean).join(', ');
    const homeRec = [g.homeRecord && `${g.homeRecord} overall`, g.homeHome && `${g.homeHome} home`].filter(Boolean).join(', ');
    const awayInj = injMap[g.awayAbbrev] ?? [];
    const homeInj = injMap[g.homeAbbrev] ?? [];
    let line = `${g.awayTeam}${awayRec ? ` (${awayRec})` : ''} at ${g.homeTeam}${homeRec ? ` (${homeRec})` : ''}`;
    line += `\n  ${g.awayTeam} injuries: ${awayInj.length ? awayInj.join(' | ') : 'none reported'}`;
    line += `\n  ${g.homeTeam} injuries: ${homeInj.length ? homeInj.join(' | ') : 'none reported'}`;
    return line;
  });

  return lines.join('\n\n');
}

// ─── Gemini picks ─────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr, todayET) {
  // Inject ESPN data if available — gracefully skip if ESPN fails
  let espnBlock = '';
  try {
    const ctx = await buildESPNContext(sport, todayET);
    if (ctx) {
      espnBlock = `\nESPN DATA (records and injury reports as of now):\n${ctx}\n\nUsing the above as your foundation, also use Google Search to find current betting lines, any late injury updates, recent form, and head-to-head history.\n`;
    }
  } catch {
    // ESPN failed — Gemini will search for everything
  }

  const prompt = `You are generating the top 5 ${sport} betting picks for today, ${dateStr}.
${espnBlock}
STEP 1 — RESEARCH (use Google Search for each item below):
- Which ${sport} games are actually scheduled today (${dateStr})? Only pick from real games.
- For each game you consider, look up:
  * Current injury report: who is OUT, Doubtful, or Questionable for each team
  * Recent form: each team's last 10 games W/L, home/away splits, and current streak
  * Head-to-head history: last 5 matchups — who won, who covered the spread, did it go over/under
  * Rest and schedule: back-to-backs, days of rest, travel distance
  * Current lines and any line movement since opening (sharp action signals)
  * Key player matchup edges: favorable/unfavorable defensive assignments, pace mismatches
  * Relevant news: load management, motivation, revenge games, coaching adjustments

STEP 2 — SELECT 5 PICKS with genuine edge:
- DO NOT suggest any moneyline with odds shorter than -400
- Prioritize spreads, totals (over/under), and player props over moneylines
- At least 1 pick must be an underdog or contrarian angle (positive odds preferred)
- Every pick must have a real, current line/odds value found via search
- Confidence "high" = multiple data points align strongly; "medium" = solid lean with a clear reason

STEP 3 — WRITE the rationale for each pick. The rationale MUST:
- Be 5-6 sentences with specific data: exact injury status and its impact, the actual current line you found, recent form with stats, head-to-head context, and the precise edge being exploited
- Reference specific numbers (e.g. "Boston is 9-1 ATS in back-to-backs", "Lillard is OUT removing 28 PPG", "line moved from -2.5 to -4 on sharp action")
- Explain why the line is beatable

If ${sport} has no games scheduled today, return: {"picks": []}

Return ONLY valid JSON, no markdown, no explanation:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "specific bet e.g. 'Celtics -5.5' or 'Over 224.5' or 'LeBron James Over 25.5 Points'",
      "odds": "+150",
      "confidence": "high|medium",
      "rationale": "5-6 sentences referencing specific injury news, current line, recent form stats, H2H, and the edge"
    }
  ]
}`;

  const body = {
    system_instruction: {
      parts: [{ text: 'You are a sharp sports betting analyst. You always use Google Search to look up current injury reports, recent team form, head-to-head history, and line movement before making picks. Your rationales cite specific data points, not vague generalities. Return only valid JSON.' }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.4 },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini error for ${sport}: ${res.status} ${text}`);
  }

  const json = await res.json();
  // Use parts[0].text — proven working approach from April 6-7
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"picks":[]}';
  console.log(`  Raw (first 300): ${raw.slice(0, 300)}`);

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return (parsed.picks ?? []).filter((p) => {
      if (p.betType === 'moneyline') return parseInt(p.odds ?? '0') > -401;
      return true;
    });
  } catch {
    console.error(`  Failed to parse JSON for ${sport}:`, raw.slice(0, 500));
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const dateStr = now.toISOString().slice(0, 10);
  const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr} | ET: ${todayET} | Sports: ${inSeasonSports.join(', ')}`);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`\n── ${sport}`);
    try {
      const picks = await getPicksForSport(sport, dateStr, todayET);
      if (picks.length > 0) {
        sports.push({ sport, picks });
        console.log(`  ✓ ${picks.length} picks`);
      } else {
        console.log(`  — No games or no picks`);
      }
    } catch (err) {
      console.error(`  ✗ Error:`, err.message);
    }
  }

  writeFileSync('daily-picks.json', JSON.stringify({ date: dateStr, generatedAt: now.toISOString(), sports }, null, 2));
  console.log(`\nWrote ${sports.length} sport(s) to daily-picks.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
