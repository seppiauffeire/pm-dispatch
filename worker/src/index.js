import { scoreRun, PROBLEMS } from './game.js';

const ALLOWED_ORIGINS = new Set(['https://pmdispatch.com', 'https://www.pmdispatch.com']);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const MAX_BODY_BYTES = 4096;
const MIN_RUN_MS = 9000; // eight steps with a one second animation each, so a real run cannot be faster
const MAX_RUN_MS = 6 * 60 * 60 * 1000;
const IP_LIMIT_PER_HOUR = 15;
const DEVICE_LIMIT_PER_HOUR = 8;

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const ok = ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://pmdispatch.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request, data, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...corsHeaders(request) },
  });
}

// Monday 00:00 UTC of the week containing ts, as YYYY-MM-DD.
export function weekStart(ts) {
  const d = new Date(ts);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/[^\p{L}\p{N} _.'\-]/gu, '').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 20 ? name : null;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Rank = number of players with a better best score (ties go to whoever got there first) plus one.
async function rankFor(db, week, score, at) {
  const row = await db
    .prepare(
      `WITH best AS (
         SELECT device, MAX(score) AS score FROM runs WHERE (?1 IS NULL OR week = ?1) GROUP BY device
       ), firsts AS (
         SELECT b.device, b.score,
                (SELECT MIN(created_at) FROM runs r WHERE r.device = b.device AND r.score = b.score AND (?1 IS NULL OR r.week = ?1)) AS at
         FROM best b
       )
       SELECT COUNT(*) AS n FROM firsts WHERE score > ?2 OR (score = ?2 AND at < ?3)`
    )
    .bind(week, score, at)
    .first();
  return (row ? row.n : 0) + 1;
}

async function submitRun(request, env) {
  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > MAX_BODY_BYTES) return json(request, { error: 'Request too large.' }, 413);
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json(request, { error: 'Invalid JSON.' }, 400);
  }
  if (!body || typeof body !== 'object') return json(request, { error: 'Invalid request.' }, 400);

  const name = cleanName(body.name);
  if (!name) return json(request, { error: 'Pick a name between 2 and 20 characters (letters, numbers, spaces).' }, 400);
  const device = body.device;
  if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(device)) return json(request, { error: 'Invalid device id.' }, 400);
  const dur = body.dur;
  if (!Number.isFinite(dur) || dur < MIN_RUN_MS || dur > MAX_RUN_MS) return json(request, { error: 'That run looks too fast to be real.' }, 400);

  const result = scoreRun(body.prob, body.picks, body.luck);
  if (!result) return json(request, { error: 'That run is not valid.' }, 400);

  const now = Date.now();
  const hourAgo = now - 3600 * 1000;
  const ip = await sha256Hex((request.headers.get('CF-Connecting-IP') || 'unknown') + (env.IP_SALT || ''));
  const [ipCount, devCount] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE ip = ? AND created_at > ?').bind(ip, hourAgo).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE device = ? AND created_at > ?').bind(device, hourAgo).first(),
  ]);
  if ((ipCount && ipCount.n >= IP_LIMIT_PER_HOUR) || (devCount && devCount.n >= DEVICE_LIMIT_PER_HOUR)) {
    return json(request, { error: 'Slow down. Try again in a bit.' }, 429);
  }

  const week = weekStart(now);
  await env.DB.prepare(
    'INSERT INTO runs (device, name, score, grade, arch, prob, combos, picks, luck, week, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  )
    .bind(device, name, result.score, result.grade, result.arch, body.prob, result.combos, JSON.stringify(body.picks), JSON.stringify(body.luck), week, ip, now)
    .run();

  const mine = await env.DB.prepare('SELECT MAX(score) AS s FROM runs WHERE device = ?').bind(device).first();
  const myBest = mine ? mine.s : result.score;
  const [first, firstWeek] = await Promise.all([
    env.DB.prepare('SELECT MIN(created_at) AS at FROM runs WHERE device = ? AND score = ?').bind(device, myBest).first(),
    env.DB.prepare('SELECT MAX(score) AS s, MIN(created_at) AS at FROM runs WHERE device = ? AND week = ?').bind(device, week).first(),
  ]);
  const [rankAll, rankWeek] = await Promise.all([
    rankFor(env.DB, null, myBest, first.at),
    rankFor(env.DB, week, firstWeek.s, (await env.DB.prepare('SELECT MIN(created_at) AS at FROM runs WHERE device = ? AND week = ? AND score = ?').bind(device, week, firstWeek.s).first()).at),
  ]);

  return json(request, { ok: true, score: result.score, grade: result.grade, arch: result.arch, rank_all: rankAll, rank_week: rankWeek }, 201);
}

async function leaderboard(request, env, url) {
  const scope = url.searchParams.get('scope') === 'week' ? 'week' : 'all';
  const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
  const me = url.searchParams.get('d') || '';
  const week = scope === 'week' ? weekStart(Date.now()) : null;
  const { results } = await env.DB.prepare(
    `WITH ranked AS (
       SELECT name, grade, arch, score, combos, device, created_at,
              ROW_NUMBER() OVER (PARTITION BY device ORDER BY score DESC, created_at ASC) AS rn
       FROM runs WHERE (?1 IS NULL OR week = ?1)
     )
     SELECT name, grade, arch, score, combos, device, created_at FROM ranked WHERE rn = 1
     ORDER BY score DESC, created_at ASC LIMIT ?2`
  )
    .bind(week, limit)
    .all();
  const rows = results.map((r) => ({ name: r.name, grade: r.grade, arch: r.arch, score: r.score, combos: r.combos, me: !!me && r.device === me }));
  return json(request, { scope, rows }, 200, 'public, max-age=15');
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/runs' && request.method === 'POST') return await submitRun(request, env);
      if (url.pathname === '/api/leaderboard' && request.method === 'GET') return await leaderboard(request, env, url);
      if (url.pathname === '/api/health') return json(request, { ok: true, problems: PROBLEMS.length });
      return json(request, { error: 'Not found.' }, 404);
    } catch (e) {
      return json(request, { error: 'Server error.' }, 500);
    }
  },
};
