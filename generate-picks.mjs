import { writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}

// ─── Season calendar ────────────────────────────────────────────────────────
const SEASON_MONTHS = {
  NBA:   [10, 11, 12, 1, 2, 3, 4, 5, 6],
  NHL:   [10, 11, 12, 1, 2, 3, 4, 5, 6],
  MLB:   [4, 5, 6, 7, 8, 9, 10],
  NFL:   [9, 10, 11, 12, 1, 2],
  MLS:   [3, 4, 5, 6, 7, 8, 9, 10, 11],
  UFC:   [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};

// ESPN sport keys
const ESPN_KEYS = {
  NBA: 'basketball/nba',
  NHL: 'hockey/nhl',
  MLB: 'baseball/mlb',
  NFL: 'football/nfl',
  MLS: 'soccer/usa.1',
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
  if (!key) return []; // UFC — no ESPN scoreboard, will be handled by Gemini knowledge

  // Use ?dates=YYYYMMDD to explicitly request today's schedule (not ESPN's "current" default)
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
      return {
        game: `${away?.team?.displayName ?? 'Away'} vs ${home?.team?.displayName ?? 'Home'}`,
        time: e.date,
        status: comps?.status?.type?.description ?? '',
      };
    }).filter((g) => g.status !== 'Final'); // exclude already-finished games
  } catch (err) {
    console.error(`  ESPN fetch failed for ${sport}:`, err.message);
    return [];
  }
}

// ─── Gemini picks ─────────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr, games) {
  const gamesContext = games.length > 0
    ? `Today's ${sport} games:\n${games.map((g) => `- ${g.game}`).join('\n')}`
    : `Search for any ${sport} games scheduled today (${dateStr}).`;

  const prompt = `You are a sharp sports betting analyst. Use Google Search NOW to look up current injury reports, real betting lines, and recent news for today's ${sport} games before generating any picks.

${gamesContext}

Before picking, search for:
- Current spread, total, and moneyline odds from major sportsbooks (DraftKings, FanDuel, BetMGM)
- Today's injury and availability reports for key players
- Recent team form (last 5-10 games), home/away splits, back-to-back situations
- Head-to-head history between each matchup
- Any lineup news, motivation factors, or public betting trends

Generate 5 high-value betting picks for ${dateStr}. Rules:
- Only pick from real games happening today
- Use the ACTUAL lines you find via search — never fabricate odds or spreads
- No moneyline picks with odds shorter than -400
- Prioritize spreads, totals, and player props
- Include at least 1 underdog or positive-odds pick
- If no games today for this sport, return {"picks":[]}

Rationale must be 5-6 sentences and include: the specific injury or availability situation, the actual current line you found, recent form data, head-to-head context, and the exact edge you are exploiting.

Return only this JSON with no markdown, no code fences, no extra text:
{"picks":[{"game":"Away Team vs Home Team","betType":"spread|total|moneyline|prop","pick":"e.g. Lakers +4.5 or Over 224.5","odds":"-110","confidence":"high|medium","rationale":"5-6 sentences with real data"}]}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: 'You are a sharp sports betting analyst. Always use Google Search to find current lines and injury data before generating picks. Return only valid JSON with no markdown.' }],
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
  // google_search responses may have multiple parts; find the text part
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const raw = parts.find((p) => p.text)?.text ?? '{"picks":[]}';
  console.log(`  Raw (first 300): ${raw.slice(0, 300)}`);

  // Extract JSON object from response (may have surrounding prose)
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
  // Use ET date as authoritative "today" — matches what the app displays
  const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr} | ET date: ${todayET} | Sports: ${inSeasonSports.join(', ')}`);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`\n── ${sport}`);
    try {
      const games = await getTodaysGames(sport, todayET);
      console.log(`  ESPN games found: ${games.length} (${games.map(g => g.game).join(' | ') || 'none'})`);

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
