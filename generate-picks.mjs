import { writeFileSync } from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set');
  process.exit(1);
}

const GEMINI_URL = (model = 'gemini-2.5-flash') =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

// ─── Season calendar ────────────────────────────────────────────────────────
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

// ─── Phase 1: Research with Google Search ───────────────────────────────────
async function researchSport(sport, dateStr) {
  const res = await fetch(GEMINI_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: 'You are a sharp sports betting analyst. Use Google Search to find current, accurate information.' }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: `Search for today's ${sport} games on ${dateStr} and provide a detailed betting research report. Include:
1. All ${sport} games scheduled today with tip-off/start times
2. Current injury reports for each team (who is OUT, Doubtful, Questionable)
3. Each team's recent form (last 10 games, home/away record, current streak)
4. Head-to-head history for each matchup (last 5 games, who covered)
5. Current betting lines: spread, total (over/under), and moneyline for each game
6. Any line movement since opening and what it signals
7. Key matchup advantages or scheduling edges (back-to-backs, rest days)

If there are no ${sport} games scheduled today, say "NO GAMES TODAY" and nothing else.` }],
      }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3 },
    }),
  });

  if (!res.ok) throw new Error(`Research API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('\n').trim();
  console.log(`  [${sport}] Research (first 200 chars): ${text.slice(0, 200)}`);
  return text;
}

// ─── Phase 2: Generate structured JSON from research ────────────────────────
async function generatePicks(sport, dateStr, research) {
  if (!research || research.includes('NO GAMES TODAY')) {
    console.log(`  [${sport}] No games today — skipping`);
    return [];
  }

  const res = await fetch(GEMINI_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: {
        parts: [{ text: 'You are a sharp sports betting analyst. Output only valid JSON, no markdown, no explanation.' }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: `Based on this ${sport} betting research for ${dateStr}:

${research}

Generate the top 5 betting picks. Rules:
- Only pick from real games listed in the research above
- No moneyline picks with odds shorter than -400
- Prioritize spreads, totals, and props over moneylines
- Include at least 1 underdog or positive-odds pick
- Rationale must cite a specific stat or fact from the research (2-3 sentences)

Return this exact JSON structure:
{
  "picks": [
    {
      "game": "Away Team vs Home Team",
      "betType": "spread|total|moneyline|prop",
      "pick": "e.g. Lakers -4.5 or Over 224.5 or LeBron James Over 25.5 Points",
      "odds": "+150",
      "confidence": "high|medium",
      "rationale": "2-3 sentences citing specific stats/injuries/line movement from the research"
    }
  ]
}` }],
      }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) throw new Error(`Picks API error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{"picks":[]}';
  console.log(`  [${sport}] Picks JSON (first 200 chars): ${raw.slice(0, 200)}`);

  try {
    const parsed = JSON.parse(raw);
    return (parsed.picks ?? []).filter((p) => {
      if (p.betType === 'moneyline') return parseInt(p.odds ?? '0') > -401;
      return true;
    });
  } catch {
    console.error(`  [${sport}] JSON parse failed:`, raw.slice(0, 300));
    return [];
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const dateStr = now.toISOString().slice(0, 10);

  const inSeasonSports = getInSeasonSports(month);
  console.log(`Date: ${dateStr} | In-season sports: ${inSeasonSports.join(', ')}`);

  const sports = [];

  for (const sport of inSeasonSports) {
    console.log(`\n── ${sport} ──`);
    try {
      const research = await researchSport(sport, dateStr);
      const picks = await generatePicks(sport, dateStr, research);
      if (picks.length > 0) {
        sports.push({ sport, picks });
        console.log(`  ✓ ${picks.length} picks added`);
      } else {
        console.log(`  — 0 picks (no games or no edge found)`);
      }
    } catch (err) {
      console.error(`  ✗ Error:`, err.message);
    }
  }

  const output = { date: dateStr, generatedAt: now.toISOString(), sports };
  writeFileSync('daily-picks.json', JSON.stringify(output, null, 2));
  console.log(`\nDone — ${sports.length} sport(s) written to daily-picks.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
