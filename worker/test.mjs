// Run with: npm test   (needs Node 22.5+, uses the built-in sqlite module as a stand-in for D1)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['sync-game.js'], { stdio: 'inherit' });
const { default: worker, cleanName, weekStart } = await import('./src/index.js');
const { scoreRun, NODES, PROBLEMS } = await import('./src/game.js');

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => db.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...args) }),
            run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }),
          };
        },
      };
    },
  };
}

const rnd = (n) => Math.floor(Math.random() * n);
function randomRun() {
  const picks = NODES.map((n) => rnd(n.pool.length));
  const noise = NODES[NODES.length - 1].pool[picks[picks.length - 1]].noise;
  const luck = { r: 0, v: 0, t: 0 };
  return { prob: rnd(PROBLEMS.length), picks, luck, noise };
}
async function post(env, body, { ip = '1.1.1.1', origin = 'https://pmdispatch.com' } = {}) {
  const res = await worker.fetch(
    new Request('https://x.test/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, Origin: origin },
      body: JSON.stringify(body),
    }),
    env
  );
  return { status: res.status, body: await res.json(), headers: res.headers };
}
async function get(env, qs) {
  const res = await worker.fetch(new Request('https://x.test/api/leaderboard?' + qs, { headers: { Origin: 'https://pmdispatch.com' } }), env);
  return { status: res.status, body: await res.json() };
}
const valid = (device, name = 'Tester', run = randomRun()) => ({ name, device, prob: run.prob, picks: run.picks, luck: run.luck, dur: 30000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('FAIL  ' + name + '\n' + (e.stack || e));
    process.exitCode = 1;
  }
}

await t('cleanName strips markup and enforces length', () => {
  assert.equal(cleanName('<img src=x onerror=1>'), 'img srcx onerror1');
  assert.equal(cleanName('  Ana  Maria '), 'Ana Maria');
  assert.equal(cleanName('a'), null);
  assert.equal(cleanName('x'.repeat(21)), null);
  assert.equal(cleanName(42), null);
  assert.equal(cleanName("O'Brien-Smith"), "O'Brien-Smith");
});

await t('weekStart is the Monday of that week (UTC)', () => {
  assert.equal(weekStart(Date.parse('2026-10-14T12:00:00Z')), '2026-10-12'); // Wednesday
  assert.equal(weekStart(Date.parse('2026-10-18T23:59:00Z')), '2026-10-12'); // Sunday
  assert.equal(weekStart(Date.parse('2026-10-19T00:00:00Z')), '2026-10-19'); // Monday
});

await t('scoreRun rejects illegal runs and is deterministic', () => {
  const r = randomRun();
  assert.deepEqual(scoreRun(r.prob, r.picks, r.luck), scoreRun(r.prob, r.picks, r.luck));
  assert.equal(scoreRun(99, r.picks, r.luck), null);
  assert.equal(scoreRun(r.prob, r.picks.slice(1), r.luck), null);
  assert.equal(scoreRun(r.prob, r.picks.map(() => 999), r.luck), null);
  assert.equal(scoreRun(r.prob, r.picks.map(() => 1.5), r.luck), null);
  assert.equal(scoreRun(r.prob, r.picks, { r: r.noise + 1, v: 0, t: 0 }), null);
  assert.equal(scoreRun(r.prob, r.picks, null), null);
});

await t('valid run is stored, score comes from the server, and ranks are returned', async () => {
  const env = { DB: fakeD1(), IP_SALT: 's' };
  const run = randomRun();
  const body = { ...valid('device-aaaaaaaa', 'Arturo', run), score: 100, grade: 'S' }; // client-claimed score must be ignored
  const res = await post(env, body);
  assert.equal(res.status, 201);
  assert.equal(res.body.score, scoreRun(run.prob, run.picks, run.luck).score);
  assert.equal(res.body.rank_all, 1);
  assert.equal(res.body.rank_week, 1);
});

await t('tampered submissions are rejected', async () => {
  const env = { DB: fakeD1(), IP_SALT: 's' };
  const base = valid('device-bbbbbbbb');
  assert.equal((await post(env, { ...base, picks: base.picks.map(() => 99) })).status, 400);
  assert.equal((await post(env, { ...base, luck: { r: 50, v: 0, t: 0 } })).status, 400);
  assert.equal((await post(env, { ...base, dur: 500 })).status, 400);
  assert.equal((await post(env, { ...base, name: '!' })).status, 400);
  assert.equal((await post(env, { ...base, device: 'short' })).status, 400);
  assert.equal((await post(env, { ...base, prob: 77 })).status, 400);
  const res = await worker.fetch(new Request('https://x.test/api/runs', { method: 'POST', body: 'not json' }), env);
  assert.equal(res.status, 400);
});

await t('leaderboard keeps one best run per player, ordered by score, with the me flag', async () => {
  const env = { DB: fakeD1(), IP_SALT: 's' };
  const runs = [];
  while (runs.length < 12) {
    const r = randomRun();
    const s = scoreRun(r.prob, r.picks, r.luck).score;
    if (!runs.some((x) => x.s === s)) runs.push({ r, s });
  }
  runs.sort((a, b) => a.s - b.s);
  const low = runs[0], mid = runs[5], high = runs[11];
  await post(env, valid('device-low00001', 'Lowly', low.r), { ip: '2.0.0.1' });
  await wait(3);
  await post(env, valid('device-high0001', 'Highly', high.r), { ip: '2.0.0.2' });
  await wait(3);
  await post(env, valid('device-low00001', 'Lowly', mid.r), { ip: '2.0.0.1' }); // same player improves
  const all = await get(env, 'scope=all&limit=10&d=device-high0001');
  assert.equal(all.body.rows.length, 2);
  assert.equal(all.body.rows[0].name, 'Highly');
  assert.equal(all.body.rows[0].me, true);
  assert.equal(all.body.rows[1].score, mid.s);
  assert.equal(all.body.rows[1].me, false);
  assert.ok(!('device' in all.body.rows[0]), 'device ids must not leak');
  const wk = await get(env, 'scope=week&limit=1');
  assert.equal(wk.body.rows.length, 1);
});

await t('ties go to the player who got there first', async () => {
  const env = { DB: fakeD1(), IP_SALT: 's' };
  const r = randomRun();
  const first = await post(env, valid('device-first001', 'First', r), { ip: '3.0.0.1' });
  await wait(3);
  const second = await post(env, valid('device-second01', 'Second', r), { ip: '3.0.0.2' });
  assert.equal(first.body.rank_all, 1);
  assert.equal(second.body.rank_all, 2);
  const all = await get(env, 'scope=all');
  assert.deepEqual(all.body.rows.map((x) => x.name), ['First', 'Second']);
});

await t('rate limits per device and per IP', async () => {
  const env = { DB: fakeD1(), IP_SALT: 's' };
  let last;
  for (let i = 0; i < 9; i++) last = await post(env, valid('device-spam0001'), { ip: '4.0.0.' + i });
  assert.equal(last.status, 429);
  const env2 = { DB: fakeD1(), IP_SALT: 's' };
  for (let i = 0; i < 16; i++) last = await post(env2, valid('device-ipspam' + String(i).padStart(2, '0')), { ip: '5.5.5.5' });
  assert.equal(last.status, 429);
});

await t('CORS allows the site and localhost, and falls back for strangers', async () => {
  const env = { DB: fakeD1() };
  const pre = await worker.fetch(new Request('https://x.test/api/runs', { method: 'OPTIONS', headers: { Origin: 'https://pmdispatch.com' } }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://pmdispatch.com');
  const local = await worker.fetch(new Request('https://x.test/api/health', { headers: { Origin: 'http://127.0.0.1:5190' } }), env);
  assert.equal(local.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5190');
  const evil = await worker.fetch(new Request('https://x.test/api/health', { headers: { Origin: 'https://evil.example' } }), env);
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), 'https://pmdispatch.com');
});

await t('unknown routes return 404', async () => {
  const res = await worker.fetch(new Request('https://x.test/nope'), { DB: fakeD1() });
  assert.equal(res.status, 404);
});

console.log(process.exitCode ? '\nSome tests failed.' : '\nAll ' + passed + ' tests passed.');
