import { writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}

// ─── Season calendar ───────────────────────────────────────────────────────
// Maps each sport to the months (1-indexed) when it is in season.
// Picks are only requested for sports whose month array includes today's month.
const SEASON_MONTHS = {
  NBA:   [10, 11, 12, 1, 2, 3, 4, 5, 6],  // Oct – Jun
  NHL:   [10, 11, 12, 1, 2, 3, 4, 5, 6],  // Oct – Jun
  MLB:   [4, 5, 6, 7, 8, 9, 10],          // Apr – Oct
  NFL:   [9, 10, 11, 12, 1, 2],           // Sep – Feb
  NCAAB: [11, 12, 1, 2, 3, 4],            // Nov – Apr
  MLS:   [3, 4, 5, 6, 7, 8, 9, 10, 11],   // Mar – Nov
  UFC:   [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], // Year-round
};

// Max sports to include per day
const MAX_SPORTS = 5;

function getInSeasonSports(month) {
  return Object.entries(SEASON_MONTHS)
    .filter(([, months]) => months.includes(month))
    .map(([sport]) => sport)
    .slice(0, MAX_SPORTS);
}

// ─── Gemini call ──────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr) {
  const prompt = `Generate exactly 5 sharp sports betting picks for ${sport} games today (${dateStr}).

Requirements:
- Only include picks for games actually scheduled today. If ${sport} has no games today, return {"picks": []}.
- DO NOT suggest any moneyline bet with odds shorter than -400 (e.g. -500, -800 are banned).
- Prioritize spreads, totals (over/under), and player props over moneylines.
- Focus on genuine +EV angles with real edge — avoid obvious chalk.
- Include at least 1 underdog or contrarian pick (positive odds preferred on at least one pick).
- Each pick must have a real, specific line/odds value.
- Confidence: "high" means strong data-backed edge; "medium" means lean with a reasonable case.

Return ONLY valid JSON, no markdown, no explanation:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "specific bet description e.g. 'Celtics -5.5' or 'Over 224.5' or 'LeBron James Over 25.5 Points'",
      "odds": "+150",
      "confidence": "high|medium",
      "rationale": "1-2 sentence explanation of the edge, citing a specific data point"
    }
  ]
}`;

  const body = {
    system_instruction: {
      parts: [{ text: 'You are a professional sports betting analyst. Return only valid JSON.' }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
    },
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

  try {
    const parsed = JSON.parse(raw);
    // Filter out any moneyline picks shorter than -400
    parsed.picks = (parsed.picks ?? []).filter((p) => {
      if (p.betType === 'moneyline') {
        const n = parseInt(p.odds ?? '0');
        return n > 0 || n <= -400 ? n > -401 : true;
      }
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
  const month = now.getMonth() + 1; // 1-indexed
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  const inSeasonSports = getInSeasonSports(month);
  console.log(`In-season sports for month ${month}:`, inSeasonSports);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`Fetching picks for ${sport}…`);
    try {
      const picks = await getPicksForSport(sport, dateStr);
      if (picks.length > 0) {
        sports.push({ sport, picks });
        console.log(`  ✓ ${picks.length} picks`);
      } else {
        console.log(`  — No games today, skipping`);
      }
    } catch (err) {
      console.error(`  ✗ Error:`, err.message);
    }
  }

  const output = {
    date: dateStr,
    generatedAt: now.toISOString(),
    sports,
  };

  writeFileSync('daily-picks.json', JSON.stringify(output, null, 2));
  console.log(`\nWrote ${sports.length} sport(s) to daily-picks.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
