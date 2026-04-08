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
async function getTodaysGames(sport) {
  const key = ESPN_KEYS[sport];
  if (!key) return []; // UFC — no ESPN scoreboard, will be handled by Gemini knowledge

  const url = `https://site.api.espn.com/apis/site/v2/sports/${key}/scoreboard`;
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
    }).filter((g) => g.status !== 'Final'); // only upcoming/live
  } catch (err) {
    console.error(`  ESPN fetch failed for ${sport}:`, err.message);
    return [];
  }
}

// ─── Gemini picks ─────────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr, games) {
  const gamesContext = games.length > 0
    ? `Today's ${sport} games:\n${games.map((g) => `- ${g.game}`).join('\n')}`
    : `Check if there are any ${sport} games today (${dateStr}).`;

  const prompt = `You are a sharp sports betting analyst generating the top 5 ${sport} picks for ${dateStr}.

${gamesContext}

Generate 5 high-value betting picks using your knowledge of current team form, injuries, trends, and betting markets. Apply these rules:
- Only pick from real games happening today
- No moneyline picks with odds shorter than -400
- Prioritize spreads, totals (over/under), and player props
- Include at least 1 underdog or positive-odds pick
- Rationale must reference specific team/player context (injuries, form, H2H, matchup edges)
- If there are genuinely no games today for this sport, return {"picks": []}

Return this exact JSON:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "e.g. Lakers -4.5 or Over 224.5",
      "odds": "+150",
      "confidence": "high|medium",
      "rationale": "2-3 sentences with specific reasoning"
    }
  ]
}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: 'You are a sharp sports betting analyst. Return only valid JSON.' }],
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini error ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"picks":[]}';
  console.log(`  Raw JSON (first 200): ${raw.slice(0, 200)}`);

  const parsed = JSON.parse(raw);
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

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr} | Sports: ${inSeasonSports.join(', ')}`);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`\n── ${sport}`);
    try {
      const games = await getTodaysGames(sport);
      console.log(`  ESPN games found: ${games.length} (${games.map(g => g.game).join(' | ') || 'none'})`);

      if (games.length === 0 && ESPN_KEYS[sport]) {
        console.log(`  No ESPN games — skipping`);
        continue;
      }

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
