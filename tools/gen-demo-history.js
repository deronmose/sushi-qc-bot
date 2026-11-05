#!/usr/bin/env node
// Generates a deterministic two-week demo journal for the 4 kitchens → data/demo_journal.csv (demo = TRUE).
// Each kitchen has its own "character", so the per-kitchen pages and the network report have something to show:
//   V1 — the reference kitchen; V2 — systematic underweight (worse on Philadelphias and sets, one weak cook);
//   V3 — overweight, mostly on salmon dishes; V4 — sloppy photos (more RECHECK / MISMATCH / unreadable).
// Verdicts use the same rule as src/verdict.js: −tol_under_pct … +tol_over_pct is OK, beyond ±30% is RECHECK.
//   node tools/gen-demo-history.js [--end 2026-11-05] [--now-hour 15] [--days 14]
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const kyiv = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'short' }).format(d);
const nowKyiv = kyiv(new Date());
const END = arg('end', nowKyiv.slice(0, 10));
const NOW_HOUR = Number(arg('now-hour', nowKyiv.slice(11, 13)));
const DAYS = Number(arg('days', 14));

// --- deterministic randomness ---
let seed = 20261105;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pick = (arr, w = arr.map(() => 1)) => { const s = w.reduce((a, b) => a + b, 0); let r = rnd() * s; for (let i = 0; i < arr.length; i++) { r -= w[i]; if (r <= 0) return arr[i]; } return arr[arr.length - 1]; };
const round1 = (x) => Math.round(x * 10) / 10;

// --- data ---
const csv = (f) => { const [h, ...l] = fs.readFileSync(path.join(root, 'data', f), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/); const c = h.split(','); return l.map((r) => { const v = r.split(','); const o = {}; c.forEach((k, i) => { o[k] = v[i]; }); return o; }); };
const cards = csv('techcards.csv').map((c) => ({ ...c, norm: Number(c.norm_grams), tu: Number(c.tol_under_pct), to: Number(c.tol_over_pct), pack: Number(c.pack_grams) }));
const venues = csv('venues.csv');
const CAT_WEIGHT = { 'роли': 3, 'запечені роли': 2, 'темпура роли': 1.5, 'макі': 1, 'нігірі': 0.5, 'гункани': 0.5, 'сети': 1.5, 'поке': 1, 'футомакі': 0.5 };
const isPhila = (c) => c.dish_name.startsWith('Філадельфія') || c.category === 'сети';
const isSalmon = (c) => /лосось/.test(c.composition);

const PROFILES = {
  V1: { bias: 0.3, sd: 1.4, p: { unreadable: 0.01, lowconf: 0.01, recheck: 0.015, mismatch: 0.01 }, dish: () => 0,
    cooks: [['Олена Коваль', 0], ['Максим Бондар', 0]] },
  V2: { bias: -1.3, sd: 1.6, p: { unreadable: 0.015, lowconf: 0.015, recheck: 0.02, mismatch: 0.02 }, dish: (c) => (isPhila(c) ? -1.7 : 0),
    cooks: [['Ірина Ткач', 0], ['Денис Мороз', -1.0], ['Оксана Лисенко', 0.2]] },
  V3: { bias: 2.5, sd: 1.8, p: { unreadable: 0.015, lowconf: 0.015, recheck: 0.02, mismatch: 0.02 }, dish: (c) => (isSalmon(c) ? 1.5 : 0),
    cooks: [['Артем Савчук', 0.6], ['Юлія Гнатюк', -0.3]] },
  V4: { bias: 0, sd: 2.2, p: { unreadable: 0.04, lowconf: 0.04, recheck: 0.08, mismatch: 0.06 }, dish: () => 0,
    cooks: [['Сергій Павлюк', 0], ['Марина Олійник', 0]] },
};
const MISMATCH_REASONS = ['зверху лосось, а не вугор', 'покриття з ікри масаго, а не з кунжуту', 'запечена шапка замість сирої риби', 'зверху не видно креветок', 'це макі, а не урамакі'];
const LOOKS = ['рол з лососем зверху', 'рол у кунжуті', 'запечений рол', 'рол у помаранчевій ікрі', 'макі в норі'];
const HOURS = [11, 12, 13, 13, 14, 14, 15, 16, 17, 18, 18, 19, 19, 20, 20, 21, 22];

const COLS = ['venue_id', 'venue', 'ts', 'date', 'chef', 'chat_id', 'dish_id', 'dish_name', 'match_source', 'portions', 'norm_grams', 'scale_grams', 'tare_grams', 'net_grams', 'deviation_pct', 'tol_under_pct', 'tol_over_pct', 'verdict', 'visual_check', 'visual_reason', 'digits_confidence', 'photo_uid', 'tg_message_id', 'demo'];
const rows = [];
let seq = 0;
const endDate = new Date(END + 'T12:00:00Z');
for (let d = DAYS - 1; d >= 0; d--) {
  const day = new Date(endDate.getTime() - d * 86400000).toISOString().slice(0, 10);
  const weekend = [0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay());
  venues.forEach((v, vi) => {
    const P = PROFILES[v.venue_id];
    const n = 25 + Math.floor(rnd() * 11) + (weekend ? 5 : 0);
    for (let k = 0; k < n; k++) {
      const hour = pick(HOURS);
      if (d === 0 && hour >= NOW_HOUR) continue; // no checks from the future today
      const ts = `${day} ${String(hour).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;
      const [chef, cookBias] = pick(P.cooks);
      const chatId = String(900000000 + vi * 10 + P.cooks.findIndex((c) => c[0] === chef) + 1);
      const card = pick(cards, cards.map((c) => CAT_WEIGHT[c.category] || 1));
      const portions = rnd() < 0.06 ? 2 : 1;
      const normTotal = card.norm * portions;
      const inBox = rnd() < 0.55;
      const r = { venue_id: v.venue_id, venue: v.name, ts, date: day, chef: chef + ' (демо)', chat_id: chatId, dish_id: card.dish_id, dish_name: card.dish_name,
        match_source: 'caption', portions, norm_grams: normTotal, scale_grams: '', tare_grams: '', net_grams: '', deviation_pct: '', tol_under_pct: card.tu, tol_over_pct: card.to,
        verdict: '', visual_check: 'match', visual_reason: '', digits_confidence: round1(0.9 + rnd() * 0.1), photo_uid: 'demo-' + (++seq), tg_message_id: '', demo: true };
      const roll = rnd();
      const pr = P.p;
      const dev = P.bias + P.dish(card) + cookBias + gauss() * P.sd;
      const net = Math.round(normTotal * (1 + dev / 100));
      const tare = inBox ? card.pack : 0;
      if (roll < pr.unreadable) {
        Object.assign(r, { verdict: 'UNREADABLE', digits_confidence: '', visual_check: 'unsure', visual_reason: 'дисплей ваг не видно' });
      } else if (roll < pr.unreadable + pr.lowconf) {
        Object.assign(r, { verdict: 'LOWCONF', dish_id: '', dish_name: pick(LOOKS), match_source: '', norm_grams: '', tol_under_pct: '', tol_over_pct: '', scale_grams: net + tare, visual_check: 'n/a' });
      } else if (roll < pr.unreadable + pr.lowconf + pr.recheck) {
        const mis = rnd() < 0.5 ? net + 300 : Math.round(net * 0.55);
        const devMis = round1((mis - tare - normTotal) / normTotal * 100);
        Object.assign(r, { verdict: 'RECHECK', scale_grams: mis, tare_grams: tare, net_grams: mis - tare, deviation_pct: devMis, digits_confidence: round1(0.4 + rnd() * 0.5) });
      } else {
        const realDev = (net - normTotal) / normTotal * 100;
        Object.assign(r, { scale_grams: net + tare, tare_grams: tare, net_grams: net, deviation_pct: round1(realDev) });
        if (roll < pr.unreadable + pr.lowconf + pr.recheck + pr.mismatch) Object.assign(r, { verdict: 'MISMATCH', visual_check: 'mismatch', visual_reason: pick(MISMATCH_REASONS) });
        else {
          r.verdict = realDev < -card.tu ? 'UNDER' : realDev > card.to ? 'OVER' : 'OK';
          if (r.verdict === 'OK' && portions === 1 && rnd() < 0.08) { r.match_source = 'weight'; r.visual_check = 'n/a'; }
          else if (rnd() < 0.15) r.visual_check = 'unsure';
        }
      }
      rows.push(r);
    }
  });
}
rows.sort((a, b) => a.ts.localeCompare(b.ts));
const cell = (x) => { const s = x === true ? 'TRUE' : x === false ? 'FALSE' : String(x ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const out = path.join(root, 'data', 'demo_journal.csv');
fs.writeFileSync(out, [COLS.join(','), ...rows.map((r) => COLS.map((c) => cell(r[c])).join(','))].join('\n') + '\n');
const by = {};
for (const r of rows) { by[r.venue_id] = by[r.venue_id] || {}; by[r.venue_id][r.verdict] = (by[r.venue_id][r.verdict] || 0) + 1; }
console.log(`${rows.length} demo rows, ${DAYS} days to ${END} (today until ${NOW_HOUR}:00) -> ${path.relative(root, out)}`);
for (const [v, c] of Object.entries(by)) { const t = Object.values(c).reduce((a, b) => a + b, 0); console.log(`  ${v}: ${t} · OK ${Math.round((c.OK || 0) / t * 100)}% · UNDER ${c.UNDER || 0} · OVER ${c.OVER || 0} · MISMATCH ${c.MISMATCH || 0} · RECHECK ${c.RECHECK || 0} · LOWCONF ${c.LOWCONF || 0} · UNREADABLE ${c.UNREADABLE || 0}`); }
