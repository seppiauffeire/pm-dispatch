# PM Dispatch leaderboard Worker

A Cloudflare Worker plus a D1 (SQLite) database that stores the "Build a Feature" game scores and serves the global leaderboard. Free tier is plenty for this.

The browser sends the **picks** that produced a run, not a score. The Worker re-scores the run with the same code the game uses (`src/game.js`, generated from `../index.html`), so scores cannot simply be typed in.

## One-time setup

Run these from this folder (`worker/`). You need a Cloudflare account (the one that already hosts the newsletter Worker is fine).

```bash
npm install --ignore-scripts
npx wrangler login
npx wrangler d1 create pmdispatch-leaderboard
```

The last command prints a `database_id`. Paste it into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

```bash
npx wrangler d1 execute pmdispatch-leaderboard --remote --file=schema.sql
npm run deploy
```

`npm run deploy` syncs the game data from `index.html` and deploys. It prints the Worker URL. The site expects:

```
https://pmdispatch-leaderboard.arturoruizvaldes.workers.dev
```

If yours differs, update `LB_API` in `index.html` (search for `LB_API`).

Check it works:

```bash
curl https://pmdispatch-leaderboard.arturoruizvaldes.workers.dev/api/health
```

## Optional hardening

Set a secret salt so stored IP hashes cannot be reversed by brute force:

```bash
npx wrangler secret put IP_SALT
```

## When you change the game

Anything in `index.html` between `//DATA-START` and `//ENGINE-END` (problems, cards, combos, scoring) must be re-synced and redeployed, or the server will reject or mis-score runs:

```bash
npm run deploy
```

## API

| Route | What it does |
|---|---|
| `POST /api/runs` | Body `{name, device, prob, picks, luck, dur}`. Validates, re-scores, stores, returns `{score, grade, arch, rank_all, rank_week}` |
| `GET /api/leaderboard?scope=all\|week&limit=10&d=<device>` | Best run per player. Rows include `me: true` for the caller's own device |
| `GET /api/health` | Liveness check |

Limits: 8 submissions per device and 15 per IP per hour. Names are 2 to 20 characters of letters, numbers, spaces and `_ . ' -`.

## Moderating

Remove a score or a player (run these with `--remote`):

```bash
npx wrangler d1 execute pmdispatch-leaderboard --remote --command "DELETE FROM runs WHERE name = 'Some Name'"
npx wrangler d1 execute pmdispatch-leaderboard --remote --command "SELECT id, name, score, created_at FROM runs ORDER BY score DESC LIMIT 20"
```

## Known limits

The Worker can prove a run is **legal** (valid picks, luck within range, plausible duration), not that a **human** played it. A script could submit the best possible picks. If that becomes a problem, add Cloudflare Turnstile to the submit step.

## Tests

```bash
npm test
```

Runs against Node's built-in SQLite as a stand-in for D1. It checks scoring, validation, tampering, ranking, tie-breaks, rate limits and CORS.
