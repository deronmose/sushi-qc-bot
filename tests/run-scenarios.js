#!/usr/bin/env node
// Offline scenario tests for the bot's decision logic.
// Runs the Code node sources (src/*.js) against data/techcards.csv, with Telegram and OpenAI Vision replaced
// by fixtures. No n8n, network or API keys needed.
//   node tests/run-scenarios.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const MATCH = src('match-caption.js');
const VERDICT = src('verdict.js');
const STATS = src('stats.js');

// Recipe cards as the Google Sheets node returns them (numbers as numbers, active as boolean).
const [head, ...lines] = fs.readFileSync(path.join(root, 'data', 'techcards.csv'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
const cols = head.split(',');
const NUM = ['pieces', 'norm_grams', 'tolerance_pct', 'pack_grams'];
const sheetRows = lines.map((l) => {
  const v = l.split(',');
  if (v.length !== cols.length) throw new Error('techcards.csv: wrong column count in ' + l.slice(0, 40));
  const o = {};
  cols.forEach((c, i) => { o[c] = NUM.includes(c) ? Number(v[i]) : c === 'active' ? v[i] === 'TRUE' : v[i]; });
  return o;
});

// Minimal stand-ins for the n8n Code node globals used by the workflow.
let staticData = {};
function run(code, { input, nodes }) {
  const item = (j) => ({ json: j });
  const $input = { all: () => input.map(item), first: () => item(input[0]) };
  const $ = (name) => ({ first: () => nodes[name], all: () => [nodes[name]], item: nodes[name] });
  const $getWorkflowStaticData = () => staticData;
  return new Function('$input', '$', '$getWorkflowStaticData', `return (function(){ ${code} })();`)($input, $, $getWorkflowStaticData);
}
let uidSeq = 0;
const trigger = (caption, uid) => ({ json: { message: { message_id: 1, caption, chat: { id: 42 }, from: { first_name: 'Test' }, date: 1, photo: [{ file_unique_id: uid || 'p' + (++uidSeq) }] } }, binary: { data: {} } });
const vision = (o) => (o === null ? { content: null } : { content: JSON.stringify(o) });
// Vision answer: weight on the display, what the dish looks like, visual verdict, extras.
const V = (value, looks, match = null, extra = {}) => ({ display_text: String(value), display_value: value, unit: 'g', digits_confidence: 0.95, readable: value !== null, in_container: false, looks_like: looks, visual_match: match, visual_confidence: 0.9, visual_reason: '', ...extra });

function check(caption, vis, uid) {
  const trig = trigger(caption, uid);
  const pre = run(MATCH, { input: sheetRows, nodes: { 'Telegram Trigger': trig } })[0];
  if (pre.json.duplicate_of) return { verdict: 'DUPLICATE', pre: pre.json };
  const out = run(VERDICT, { input: [vision(vis)], nodes: { 'Telegram Trigger': trig, 'Підпис → кандидат': pre } })[0].json;
  return { ...out, pre: pre.json };
}

// [name, caption, vision answer, expected verdict, expected match_source, expected dish_id, extra check]
const SCENARIOS = [
  // — basics —
  ['norm in caption, weight within tolerance', 'Тех карта 410', V(410, 'рол'), 'OK', 'norm'],
  ['norm in caption, overweight', 'Тех карта 380 г', V(410, 'рол'), 'BRAK', 'norm'],
  ['dish code, within tolerance, looks right', 'R07', V(262, 'рол у кунжуті', true), 'OK', 'caption', 'R07'],
  ['Cyrillic code without zero, overweight', 'р2', V(330, 'рол з вугрем'), 'BRAK', 'caption', 'R02'],
  ['alias, exact', 'філа вугор', V(308, 'рол з вугрем', true), 'OK', 'caption', 'R02'],
  ['free text, token match', 'запечений з креветкою 8шт', V(318, 'запечений рол', true), 'OK', 'caption', 'R12'],
  ['no caption, only one roll fits the weight', '', V(250, 'рол у помаранчевій ікрі'), 'OK', 'weight', 'R06'],
  ['no caption, several rolls weigh the same', '', V(300, 'рол з лососем'), 'LOWCONF', ''],
  ['no caption, a roll is never auto-matched to a poke', '', V(380, 'рол'), 'LOWCONF', ''],
  ['no caption, two pokes weigh the same', '', V(381, 'поке в мисці'), 'LOWCONF', ''],
  ['caption not in the recipe cards', 'борщ', V(300, 'рол'), 'LOWCONF', ''],
  ['decimal point lost on the display (3008 -> 300.8)', 'R05', V(3008, 'рол з лососем', true), 'OK', 'caption', 'R05'],
  ['display not readable', 'R01', V(null, 'рол'), 'UNREADABLE', 'caption'],
  ['Vision returned an empty answer', 'R01', null, 'UNREADABLE', 'caption'],
  ['ambiguous caption resolved by weight', 'філадельфія з', V(261, 'рол'), 'OK', 'caption', 'R04'],
  // — caption language and generic words —
  ['Russian spelling', 'Филадельфия угорь', V(310, 'рол з вугрем', true), 'OK', 'caption', 'R02'],
  ['Russian spelling, other letters', 'Зеленый дракон', V(330, 'рол з авокадо', true), 'OK', 'caption', 'R08'],
  ['generic word, weight picks exactly (340 is 2.94% off, not 2.9%)', 'Дракон', V(330, 'рол'), 'OK', 'caption', 'R08'],
  ['generic word, two dishes of equal weight → ask', 'Темпура', V(300, 'рол у клярі'), 'LOWCONF', '', null, (o) => /R13/.test(o.reply) && /R14/.test(o.reply)],
  ['generic word, weight separates', 'Каліфорнія', V(250, 'рол у ікрі'), 'OK', 'caption', 'R06'],
  // — units, portions, container —
  ['scale shows kilograms (unit given)', 'R06', V(0.25, 'рол у ікрі', true, { display_text: '0.250', unit: 'kg' }), 'OK', 'caption', 'R06'],
  ['scale shows kilograms (no unit)', 'R06', V(0.25, 'рол у ікрі', true, { display_text: '0.250', unit: '' }), 'OK', 'caption', 'R06'],
  ['two portions marked «х2»', 'R06 х2', V(500, 'рол у ікрі', true), 'OK', 'caption', 'R06', (o) => o.norm_grams === 500 && o.portions === 2],
  ['two portions marked «2 порції»', '2 порції Каліфорнія з крабом', V(500, 'рол у ікрі', true), 'OK', 'caption', 'R06'],
  ['in a container: packaging subtracted', 'R06', V(265, 'рол у ікрі', true, { in_container: true }), 'OK', 'caption', 'R06', (o) => o.tare_grams === 15 && o.net_grams === 250],
  ['no container seen: nothing subtracted', 'R06', V(265, 'рол у ікрі', true), 'BRAK', 'caption', 'R06', (o) => o.tare_grams === 0],
  ['implausible deviation → recheck, not BRAK', 'R06', V(410, 'рол у ікрі', true, { in_container: true }), 'RECHECK', 'caption', 'R06'],
  ['digits unclear → recheck, not a confident BRAK', 'R06', V(710, 'рол у ікрі', true, { digits_confidence: 0.3 }), 'RECHECK', 'caption', 'R06'],
  ['tolerance edge: +2.94% is outside 2.9%', 'R06', V(257.35, 'рол у ікрі', true), 'BRAK', 'caption', 'R06'],
  // — visual check —
  ['caption clearly does not match the photo', 'Філадельфія з вугрем', V(300, 'рол з лососем', false, { visual_reason: 'зверху лосось, не вугор' }), 'MISMATCH', 'caption', 'R02'],
  ['unsure mismatch → weight verdict + warning, not 🚫', 'Філадельфія з вугрем', V(310, 'рол з лососем', false, { visual_confidence: 0.5, visual_reason: 'схоже на лосось' }), 'OK', 'caption', 'R02', (o) => o.visual_check === 'doubt' && /Можлива невідповідність/.test(o.reply)],
  ['unreadable display still reports a clear mismatch', 'R02', V(null, 'рол з лососем', false, { readable: false, visual_reason: 'немає вугра' }), 'UNREADABLE', 'caption', null, (o) => /Також фото не схоже/.test(o.reply)],
];

let failed = 0;
staticData = {};
for (const [name, caption, vis, expVerdict, expSource, expId, extra] of SCENARIOS) {
  const out = check(caption, vis);
  const ok = out.verdict === expVerdict && out.match_source === expSource && (!expId || out.dish_id === expId) && (!extra || extra(out));
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${out.verdict}${out.dish_id ? ' ' + out.dish_id : ''}${out.deviation_pct != null ? ' (' + out.deviation_pct + '%)' : ''}`);
  if (!ok) console.log(`      expected ${expVerdict}/${expSource}/${expId || '-'}; got ${out.verdict}/${out.match_source}/${out.dish_id}; reply: ${String(out.reply).replace(/\n/g, ' | ')}`);
}

// Re-sent photo: the second check of the same file is stopped before Vision.
staticData = {};
const first = check('R06', V(250, 'рол у ікрі', true), 'same-photo');
const second = check('R06', V(250, 'рол у ікрі', true), 'same-photo');
const dupOk = first.verdict === 'OK' && second.verdict === 'DUPLICATE';
console.log(`${dupOk ? 'PASS' : 'FAIL'}  the same photo sent twice is flagged as a repeat`);
if (!dupOk) failed++;
staticData = {};
check('R01', null, 'empty-answer');
const retry = check('R01', V(300, 'рол з лососем', true), 'empty-answer');
const retryOk = retry.verdict !== 'DUPLICATE';
console.log(`${retryOk ? 'PASS' : 'FAIL'}  a photo whose check failed (empty Vision answer) can be sent again`);
if (!retryOk) failed++;

// /stats: counts and the "sheet missing" error path.
const rows = [
  { ts: '2026-11-04 10:05:00', date: '2026-11-04', dish_name: 'рол', verdict: 'LOWCONF' },
  { ts: '2026-11-05 10:00:00', date: '2026-11-05', dish_id: 'R01', net_grams: 301, deviation_pct: 0.3, verdict: 'OK' },
  { ts: '2026-11-05 10:05:00', date: '2026-11-05', dish_id: 'R02', net_grams: 330, deviation_pct: 6.5, verdict: 'BRAK' },
  { ts: '2026-11-05 10:07:00', date: '2026-11-05', dish_id: 'R06', scale_grams: 410, deviation_pct: 58, verdict: 'RECHECK' },
];
const stats = run(STATS, { input: rows, nodes: { 'Telegram Trigger': { json: { message: { text: '/stats all', chat: { id: 42 } } } } } })[0].json.reply;
const statsOk = /перевірок: 4/.test(stats) && /У нормі: 1/.test(stats) && /Брак: 1/.test(stats) && /Перевірити: 1/.test(stats);
console.log(`${statsOk ? 'PASS' : 'FAIL'}  /stats all counts verdicts`);
if (!statsOk) { failed++; console.log(stats); }
let thrown = false;
try { run(STATS, { input: [{ error: 'Sheet with name Журнал not found' }], nodes: { 'Telegram Trigger': { json: { message: { text: '/stats' } } } } }); } catch (e) { thrown = /Журнал/.test(e.message); }
console.log(`${thrown ? 'PASS' : 'FAIL'}  /stats reports a missing journal sheet as an error`);
if (!thrown) failed++;

const total = SCENARIOS.length + 4;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
