#!/usr/bin/env node
// Offline scenario tests for the bot's decision logic.
// Runs the Code nodes straight from workflows/sushi-qc-bot.json against data/techcards.csv,
// with Telegram and OpenAI Vision replaced by fixtures. No n8n, network or API keys needed.
//   node tests/run-scenarios.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wf = JSON.parse(fs.readFileSync(path.join(root, 'workflows', 'sushi-qc-bot.json'), 'utf8'));
const code = (name) => {
  const node = wf.nodes.find((n) => n.name === name);
  if (!node) throw new Error(`node "${name}" not found in workflow`);
  return node.parameters.jsCode;
};
const MATCH = code('Підпис → кандидат');
const VERDICT = code('Вердикт');
const STATS = code('Зведення');

// Techcards as the Google Sheets node returns them (numbers as numbers, active as boolean).
const [head, ...lines] = fs.readFileSync(path.join(root, 'data', 'techcards.csv'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
const cols = head.split(',');
const NUM = ['pieces', 'norm_grams', 'tolerance_pct'];
const sheetRows = lines.map((l) => {
  const v = l.split(',');
  const o = {};
  cols.forEach((c, i) => { o[c] = NUM.includes(c) ? Number(v[i]) : c === 'active' ? v[i] === 'TRUE' : v[i]; });
  return o;
});

// Minimal stand-ins for the n8n Code node globals used by the workflow.
function run(src, { input, nodes }) {
  const item = (j) => ({ json: j });
  const $input = { all: () => input.map(item), first: () => item(input[0]) };
  const $ = (name) => ({ first: () => nodes[name], all: () => [nodes[name]], item: nodes[name] });
  return new Function('$input', '$', `return (function(){ ${src} })();`)($input, $);
}
const trigger = (caption) => ({ json: { message: { message_id: 1, caption, chat: { id: 42 }, from: { first_name: 'Test', username: 'tester' }, date: 1 } }, binary: { data: {} } });
const vision = (o) => (o === null ? { content: null } : { content: JSON.stringify(o) });
const V = (scale, looks, match = null, reason = '') => ({ scale_grams: scale, readable: scale !== null, looks_like: looks, visual_match: match, visual_reason: reason });

// [name, caption, vision answer, expected verdict, expected match_source, expected dish_id]
const SCENARIOS = [
  ['norm in caption, weight within tolerance', 'Тех карта 410', V(410, 'рол'), 'OK', 'norm'],
  ['norm in caption, overweight', 'Тех карта 380 г', V(410, 'рол'), 'BRAK', 'norm'],
  ['dish code, within tolerance, looks right', 'R07', V(262, 'рол у кунжуті', true), 'OK', 'caption', 'R07'],
  ['Cyrillic code without zero, overweight', 'р2', V(330, 'рол з вугрем'), 'BRAK', 'caption', 'R02'],
  ['alias, exact', 'філа вугор', V(308, 'рол з вугрем', true), 'OK', 'caption', 'R02'],
  ['free text, token match', 'запечений з креветкою 8шт', V(318, 'запечений рол', true), 'OK', 'caption', 'R12'],
  ['caption does not match the photo', 'Філадельфія з вугрем', V(300, 'рол з лососем', false, 'зверху лосось, не вугор'), 'MISMATCH', 'caption', 'R02'],
  ['no caption, only one roll fits the weight', '', V(250, 'рол у помаранчевій ікрі'), 'OK', 'weight', 'R06'],
  ['no caption, several rolls weigh the same', '', V(300, 'рол з лососем'), 'LOWCONF', ''],
  ['no caption, a roll is never auto-matched to a poke', '', V(380, 'рол'), 'LOWCONF', ''],
  ['no caption, two pokes weigh the same', '', V(381, 'поке в мисці'), 'LOWCONF', ''],
  ['caption not in the recipe cards', 'борщ', V(300, 'рол'), 'LOWCONF', ''],
  ['decimal point lost on the display (3008 -> 300.8)', 'R05', V(3008, 'рол з лососем', true), 'OK', 'caption', 'R05'],
  ['display not readable', 'R01', V(null, 'рол'), 'UNREADABLE', 'caption'],
  ['Vision returned an empty answer', 'R01', null, 'UNREADABLE', 'caption'],
  ['ambiguous caption resolved by weight', 'філадельфія з', V(261, 'рол'), 'OK', 'caption', 'R04'],
];

let failed = 0;
for (const [name, caption, vis, expVerdict, expSource, expId] of SCENARIOS) {
  const pre = run(MATCH, { input: sheetRows, nodes: { 'Telegram Trigger': trigger(caption) } })[0];
  const out = run(VERDICT, { input: [vision(vis)], nodes: { 'Telegram Trigger': trigger(caption), 'Підпис → кандидат': pre } })[0].json;
  const ok = out.verdict === expVerdict && out.match_source === expSource && (!expId || out.dish_id === expId);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${out.verdict}${out.dish_id ? ' ' + out.dish_id : ''}${out.deviation_pct != null ? ' (' + out.deviation_pct + '%)' : ''}`);
  if (!ok) console.log(`      expected ${expVerdict}/${expSource}/${expId || '-'}; reply: ${out.reply.replace(/\n/g, ' | ')}`);
}

// /stats: counts and the "sheet missing" error path.
const rows = [
  { ts: '2026-11-04 10:05:00', date: '2026-11-04', dish_name: 'рол', verdict: 'LOWCONF' },
  { ts: '2026-11-05 10:00:00', date: '2026-11-05', dish_id: 'R01', deviation_pct: 0.3, verdict: 'OK' },
  { ts: '2026-11-05 10:05:00', date: '2026-11-05', dish_id: 'R02', actual_grams: 330, deviation_pct: 6.5, verdict: 'BRAK' },
];
const stats = run(STATS, { input: rows, nodes: { 'Telegram Trigger': { json: { message: { text: '/stats all', chat: { id: 42 } } } } } })[0].json.reply;
const statsOk = /перевірок: 3/.test(stats) && /У нормі: 1/.test(stats) && /Брак: 1/.test(stats);
console.log(`${statsOk ? 'PASS' : 'FAIL'}  /stats all counts verdicts`);
if (!statsOk) failed++;
let thrown = false;
try { run(STATS, { input: [{ error: 'Sheet with name Журнал not found' }], nodes: { 'Telegram Trigger': { json: { message: { text: '/stats' } } } } }); } catch (e) { thrown = /Журнал/.test(e.message); }
console.log(`${thrown ? 'PASS' : 'FAIL'}  /stats reports a missing journal sheet as an error`);
if (!thrown) failed++;

console.log(`\n${SCENARIOS.length + 2 - failed}/${SCENARIOS.length + 2} passed`);
process.exit(failed ? 1 : 0);
