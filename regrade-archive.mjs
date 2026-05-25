// One-shot: re-grade every entry in picks-archive.json using the current
// generate-picks.mjs logic, bypassing the 3-day re-grade window. Also drops
// entries that have zero picks (dead days from the old 11 AM ET cron).
//
// Usage: node regrade-archive.mjs
//   Optional: DRY_RUN=1 node regrade-archive.mjs   (prints diff, no write)

import { readFileSync, writeFileSync } from 'fs';
import { gradePicksForDate } from './generate-picks.mjs';

const DRY_RUN = process.env.DRY_RUN === '1';

function countResults(entry) {
  const picks = (entry.sports ?? []).flatMap(s => s.picks ?? []);
  const props = entry.playerProps ?? [];
  const all = [...picks, ...props];
  const r = { W: 0, L: 0, P: 0, '?': 0 };
  for (const p of all) r[p.result === '?' || !p.result ? '?' : p.result]++;
  return { total: all.length, ...r };
}

const archive = JSON.parse(readFileSync('picks-archive.json', 'utf8'));
const sorted = [...archive].sort((a, b) => (a.date < b.date ? -1 : 1));

console.log(`Loaded ${sorted.length} archive entries (${sorted[0].date} → ${sorted.at(-1).date})\n`);

const beforeTotals = { W: 0, L: 0, P: 0, '?': 0 };
for (const e of sorted) {
  const c = countResults(e);
  beforeTotals.W += c.W; beforeTotals.L += c.L; beforeTotals.P += c.P; beforeTotals['?'] += c['?'];
}

const updated = [];
const dropped = [];

for (const entry of sorted) {
  const picks = (entry.sports ?? []).flatMap(s => s.picks ?? []);
  if (picks.length === 0) {
    dropped.push(entry.date);
    continue;
  }
  const before = countResults(entry);
  console.log(`\n[${entry.date}] before: ${before.W}-${before.L}-${before.P}, ${before['?']} unresolved`);
  try {
    const graded = await gradePicksForDate(entry);
    const after = countResults(graded);
    const delta = after['?'] < before['?'] ? `recovered ${before['?'] - after['?']}` : 'no change';
    console.log(`[${entry.date}]  after: ${after.W}-${after.L}-${after.P}, ${after['?']} unresolved (${delta})`);
    updated.push(graded);
  } catch (e) {
    console.error(`[${entry.date}] re-grade failed: ${e.message}`);
    updated.push(entry);
  }
}

const afterTotals = { W: 0, L: 0, P: 0, '?': 0 };
for (const e of updated) {
  const c = countResults(e);
  afterTotals.W += c.W; afterTotals.L += c.L; afterTotals.P += c.P; afterTotals['?'] += c['?'];
}

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log(`Dead days dropped: ${dropped.length}${dropped.length ? ' → ' + dropped.join(', ') : ''}`);
console.log(`\nTotals BEFORE: ${beforeTotals.W}-${beforeTotals.L}-${beforeTotals.P}, ${beforeTotals['?']} unresolved`);
console.log(`Totals AFTER:  ${afterTotals.W}-${afterTotals.L}-${afterTotals.P}, ${afterTotals['?']} unresolved`);
const recovered = beforeTotals['?'] - afterTotals['?'];
console.log(`Recovered: ${recovered} picks newly graded\n`);

// Reverse to match repo convention (newest first)
const finalArchive = [...updated].sort((a, b) => (a.date > b.date ? -1 : 1));

if (DRY_RUN) {
  console.log('DRY_RUN=1 — not writing.');
} else {
  writeFileSync('picks-archive.json', JSON.stringify(finalArchive, null, 2));
  console.log(`Wrote ${finalArchive.length} entries to picks-archive.json`);
}
