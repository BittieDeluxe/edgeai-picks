import { writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}

// ─── Season calendar ───────────────────────────────────────────────────────
const SEASON_MONTHS = {
  NBA:   [10, 11, 12, 1, 2, 3, 4, 5, 6],  // Oct – Jun
  NHL:   [10, 11, 12, 1, 2, 3, 4, 5, 6],  // Oct – Jun
  MLB:   [4, 5, 6, 7, 8, 9, 10],          // Apr – Oct
  NFL:   [9, 10, 11, 12, 1, 2],           // Sep – Feb
  NCAAB: [11, 12, 1, 2, 3, 4],            // Nov – Apr
  MLS:   [3, 4, 5, 6, 7, 8, 9, 10, 11],   // Mar – Nov
  UFC:   [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], // Year-round
};

// ─── ESPN sport config ─────────────────────────────────────────────────────
const ESPN_MAP = {
  NBA:   { sport: 'basketball', league: 'nba' },
  NHL:   { sport: 'hockey', league: 'nhl' },
  MLB:   { sport: 'baseball', league: 'mlb' },
  NFL:   { sport: 'football', league: 'nfl' },
  NCAAB: { sport: 'basketball', league: 'mens-college-basketball' },
  MLS:   { sport: 'soccer', league: 'usa.1' },
  UFC:   null, // No ESPN scoreboard coverage
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
  const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/scoreboard?dates=${dateParam}`;

  try {
    const res = await fetch(url);
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
  } catch {
    return [];
  }
}

async function fetchAllInjuries(sport) {
  const espn = ESPN_MAP[sport];
  if (!espn) return {};

  const url = `https://site.api.espn.com/apis/site/v2/sports/${espn.sport}/${espn.league}/injuries`;

  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    const data = await res.json();

    const injuryMap = {};
    const teamEntries = data.injuries ?? data.items ?? [];

    for (const teamEntry of teamEntries) {
      for (const inj of (teamEntry.injuries ?? [])) {
        const abbrev = inj.athlete?.team?.abbreviation;
        const status = inj.status ?? inj.type?.description ?? '';
        const playerName = inj.athlete?.displayName ?? 'Unknown';

        if (!abbrev) continue;
        // Only include significant injury statuses
        if (!['out', 'doubtful', 'questionable', 'day-to-day'].some(s => status.toLowerCase().includes(s))) continue;

        if (!injuryMap[abbrev]) injuryMap[abbrev] = [];
        injuryMap[abbrev].push(`${playerName} (${status})`);
      }
    }

    return injuryMap;
  } catch {
    return {};
  }
}

async function buildEspnContext(sport, dateStr) {
  const [games, injuryMap] = await Promise.all([
    fetchEspnGames(sport, dateStr),
    fetchAllInjuries(sport),
  ]);

  if (games.length === 0) return { games: [], contextBlock: '' };

  const lines = [`=== ${sport} Games Today (${dateStr}) ===`];

  for (const g of games) {
    lines.push(`\n${g.awayName || g.awayTeam} (${g.awayRecord}) @ ${g.homeName || g.homeTeam} (${g.homeRecord})`);
    const awayInj = injuryMap[g.awayTeam] ?? [];
    const homeInj = injuryMap[g.homeTeam] ?? [];
    if (awayInj.length > 0) lines.push(`  ${g.awayTeam} injuries: ${awayInj.join(', ')}`);
    if (homeInj.length > 0) lines.push(`  ${g.homeTeam} injuries: ${homeInj.join(', ')}`);
  }

  return { games, contextBlock: lines.join('\n') };
}

// ─── Gemini call ──────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr) {
  const { games, contextBlock } = await buildEspnContext(sport, dateStr);
  const hasEspnGames = games.length > 0;

  // If ESPN found games, we use them as the authoritative schedule.
  // If not (e.g. UFC, or ESPN hasn't populated yet), let Gemini reason from knowledge.
  const espnSection = hasEspnGames
    ? `REAL-TIME GAME DATA (from ESPN API, verified for ${dateStr}):\n${contextBlock}\n\nIMPORTANT: Only generate picks for the games listed above. These are the actual scheduled games today.`
    : `Note: No ESPN schedule data available. Use your knowledge to identify if ${sport} has games today (${dateStr}).`;

  const prompt = `You are generating the top 5 ${sport} betting picks for today, ${dateStr}.

${espnSection}

STEP 1 — ANALYSIS: For each game above, analyze:
- Team records and current season form (consider home/away splits, recent streak)
- Key injuries listed above and their impact on the matchup (who's missing, what does it remove from the offense/defense?)
- Head-to-head history: which team has historically covered, over/under trends
- Rest and schedule context: back-to-backs, travel, days of rest
- Matchup edges: pace mismatches, defensive assignments, coaching adjustments

STEP 2 — SELECT 5 PICKS with genuine edge:
- DO NOT suggest any moneyline with odds shorter than -400
- Prioritize spreads, totals (over/under), and player props over moneylines
- At least 1 pick must be an underdog or contrarian angle (positive odds preferred)
- Include realistic current market odds for each pick
- Confidence "high" = multiple factors align strongly; "medium" = solid lean with clear reason

STEP 3 — WRITE detailed rationale for each pick:
- 5-6 sentences per pick — this is the minimum, do not write less
- Reference the specific injury impact (e.g. "Landale is OUT, eliminating Atlanta's backup center minutes")
- Reference team records and what they indicate about current form
- Explain the h2h angle and why the line is beatable
- Describe the specific matchup edge that creates value
- End with what needs to happen for the pick to hit

If ${sport} has no games today, return: {"picks": []}

Return ONLY valid JSON, no markdown, no explanation:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "specific bet e.g. 'Celtics -5.5' or 'Over 224.5' or 'LeBron James Over 25.5 Points'",
      "odds": "+150",
      "confidence": "high|medium",
      "rationale": "5-6 sentences with specific injury impact, team records, h2h trends, matchup edges, and what needs to happen for the pick to hit"
    }
  ]
}`;

  const body = {
    system_instruction: {
      parts: [{ text: 'You are a sharp sports betting analyst. You have access to real-time ESPN data injected into this prompt. Use the injury reports and team records provided to build detailed, data-driven picks. Your rationales are 5-6 sentences each and cite specific player names, records, and matchup factors. Return only valid JSON.' }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
    },
  };

  // NOTE: google_search tool is intentionally omitted.
  // As of April 2026, gemini-2.5-flash + google_search returns empty parts
  // (model searches but produces no text output). ESPN data is injected directly instead.
  // See DECISIONS.md for full context.
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
