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

const MAX_SPORTS = 5;

function getInSeasonSports(month) {
  return Object.entries(SEASON_MONTHS)
    .filter(([, months]) => months.includes(month))
    .map(([sport]) => sport)
    .slice(0, MAX_SPORTS);
}

// ─── Diagnostic: test free-text output with google_search ─────────────────
async function diagnoseFreeText() {
  console.log('\n=== DIAGNOSTIC: free-text + google_search ===');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'What NBA games are scheduled for today? Just list them briefly.' }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.4 },
      }),
    }
  );
  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  console.log(`  Parts count: ${parts.length}`);
  console.log(`  Parts structure: ${JSON.stringify(parts.map(p => ({ keys: Object.keys(p), textLen: p.text?.length ?? 0, thought: p.thought ?? false })))}`);
  console.log(`  Full response text: ${parts.map(p => p.text ?? '').join('').slice(0, 500)}`);
  console.log('=== END DIAGNOSTIC ===\n');
}

// ─── Gemini call ──────────────────────────────────────────────────────────
async function getPicksForSport(sport, dateStr) {
  const prompt = `You are generating the top 5 ${sport} betting picks for today, ${dateStr}.

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
- Reference specific stats or facts you found (e.g. "Boston is 9-1 ATS in back-to-backs this season", "Lillard is OUT, removing 28 PPG from Milwaukee's offense", "Line moved from -2.5 to -4 indicating sharp money on the favorite")
- Explain what the edge is and why the line is beatable
- Be 2-3 sentences — enough detail to justify the pick

If ${sport} has no games scheduled today, return: {"picks": []}

Return ONLY valid JSON, no markdown, no explanation:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "specific bet description e.g. 'Celtics -5.5' or 'Over 224.5' or 'LeBron James Over 25.5 Points'",
      "odds": "+150",
      "confidence": "high|medium",
      "rationale": "2-3 sentences referencing specific stats, injury news, or line movement that justify this pick"
    }
  ]
}`;

  const body = {
    system_instruction: {
      parts: [{ text: 'You are a sharp sports betting analyst. You always use Google Search to look up current injury reports, recent team form, head-to-head history, and line movement before making picks. Your rationales cite specific data points, not vague generalities. Return only valid JSON.' }],
    },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.4,
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
  console.log(`  Raw (first 300): ${raw.slice(0, 300)}`);

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

  await diagnoseFreeText();

  const inSeasonSports = getInSeasonSports(month);
  console.log(`In-season sports for month ${month}:`, inSeasonSports);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`\nFetching picks for ${sport}…`);
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

  writeFileSync('daily-picks.json', JSON.stringify({ date: dateStr, generatedAt: now.toISOString(), sports }, null, 2));
  console.log(`\nWrote ${sports.length} sport(s) to daily-picks.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
