# edgeai-picks — Decisions & Proven Patterns

This file documents what is **known to work**, what is **known to fail**, and **why**.
Read this before touching any code. Treat every entry as a hard constraint until explicitly invalidated.

---

## generate-picks.mjs

### Gemini API call
- **Do NOT use `google_search` tool with `gemini-2.5-flash`** — as of April 2026, `google_search` causes `gemini-2.5-flash` to search but return empty parts (the `content` object has no `parts` array). This is a confirmed Gemini API regression. All variations tested: `generateContent`, `streamGenerateContent`, `thinkingBudget: 0` — all produce no usable text when search is triggered. `gemini-flash-latest` and `gemini-3-flash-preview` do return text but don't actually search (empty `webSearchQueries`).
- **ESPN data injection replaces `google_search`** — fetch real-time schedules, records, and injuries from ESPN APIs and inject them directly into the Gemini prompt. `gemini-2.5-flash` without `google_search` produces correct output and uses the injected data for its analysis.
- **Do not use `responseMimeType: 'application/json'`** — causes silent tool drops (kept as rule even though google_search is no longer used).
- **Parse response with `parts[0].text`**, not `parts.find(p => p.text)`. Strip markdown fences before JSON.parse: `raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()`
- **Temperature 0.4** has been stable. Do not raise it.
- **Model: `gemini-2.5-flash`** via `generateContent` (not `streamGenerateContent`).

### ESPN scoreboard
- **Use `?dates=YYYYMMDD`** on the scoreboard endpoint. The default endpoint returns "current" games which are yesterday's Finals in the morning — not tonight's schedule.
- **Do not filter by `status !== 'Final'`** alone — yesterday's completed games appear in the default scoreboard and all have Final status. With `?dates=`, today's games appear as Scheduled and the filter is safe.
- **If ESPN returns 0 games**, Gemini will fall back to reasoning from its training data for that sport (no strict skip — it may still produce picks or return empty).
- **Team abbreviations** come from `competitor.team.abbreviation` in the scoreboard response.

### ESPN injury endpoint
- **Use the global injuries endpoint**, NOT the per-team endpoint. Per-team returns `code: 1008` errors.
- Global format: `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/injuries`
- Response body: `data.injuries ?? data.items ?? []` — each entry is `{id, displayName, injuries: [{athlete, type, status, longComment}]}`
- Status field: `inj.status` (e.g. "Out", "Day-To-Day") — also available as `inj.type.description` (lowercase)
- Team abbreviation: `inj.athlete.team.abbreviation` — matches scoreboard abbreviations
- Always wrap in try/catch and return `{}` on failure — ESPN is unofficial with no SLA.

### Caching (client-side in app)
- Cache must be invalidated if **date doesn't match today ET** OR **sports array is empty**. Date-only invalidation caused stale empty picks to be served all day.
- Force refresh: fetch with `?t=${Date.now()}` and `cache: 'no-store'`.

### GitHub Actions workflow
- Use `git pull --rebase` before `git push` to avoid push rejections when the remote has diverged from a previous run's commit.
- Commit message must include `[skip ci]` to prevent the push from triggering another workflow run.

---

## What worked on April 6–7 (baseline to restore to if broken)

The commit SHA of the last known-good script before any modifications: `8426afed`

Key properties of that version:
- No ESPN dependency — Gemini searched for today's games itself
- `google_search: {}` (snake_case)
- No `responseMimeType`
- `parts[0].text` for response parsing
- Markdown fence stripping before JSON.parse
- Rationale: 2-3 sentences (later extended to 5-6)

---

## Rules for modifying this script

1. **Read this file first.**
2. **Read the current script from git before editing** — never rely on memory of what it contains.
3. **Change only what is necessary** for the task. Do not refactor surrounding code.
4. **After any change that produces `sports: []`**, check git history and diff against the last working commit before making further changes.
5. **Test by triggering the workflow manually** before declaring a fix complete.
