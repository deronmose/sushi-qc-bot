#!/usr/bin/env node
// Offline scenario tests for the bot's decision logic and reports.
// Runs the Code node sources (src/*.js) against data/*.csv, with Telegram and OpenAI Vision replaced by fixtures.
// No n8n, network or API keys needed.
//   node tests/run-scenarios.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const withLib = (f) => src('report-lib.js') + '\n' + src(f);
const MATCH = src('match-caption.js');
const VERDICT = src('verdict.js');
const COOK = src('cook.js');
const STATS = withLib('stats.js');
const REPORT_NOW = withLib('report-now.js');
const DAILY = withLib('daily.js');

// CSV with quoted fields → objects
function readCsv(file) {
  const text = fs.readFileSync(path.join(root, 'data', file), 'utf8').replace(/^﻿/, '').trim();
  const lines = []; let cur = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { cur.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; cur.push(cell); lines.push(cur); cur = []; cell = ''; }
    else cell += ch;
  }
  cur.push(cell); lines.push(cur);
  const [h, ...rows] = lines;
  return rows.map((v) => { if (v.length !== h.length) throw new Error(`${file}: wrong column count`); const o = {}; h.forEach((k, i) => { o[k] = v[i]; }); return o; });
}
const NUM = ['pieces', 'norm_grams', 'tol_under_pct', 'tol_over_pct', 'pack_grams'];
const sheetRows = readCsv('techcards.csv').map((r) => { const o = { ...r }; for (const k of NUM) o[k] = Number(r[k]); o.active = r.active === 'TRUE'; return o; });

// Minimal stand-ins for the n8n Code node globals used by the workflow.
let staticData = {};
function run(code, { input, nodes }) {
  const $input = { all: () => input.map((j) => ({ json: j })), first: () => ({ json: input[0] }) };
  const $ = (name) => { const v = nodes[name]; if (v === undefined) throw new Error(`node "${name}" did not run`); const arr = Array.isArray(v) ? v : [v]; return { first: () => arr[0], all: () => arr, item: arr[0] }; };
  return new Function('$input', '$', '$getWorkflowStaticData', `return (function(){ ${code} })();`)($input, $, () => staticData);
}
const VENUE_LIST = readCsv('venues.csv').filter((v) => v.active === 'TRUE').map((v) => ({ id: v.venue_id, name: v.name }));
const OWNER = { found: true, cook: { chat_id: '42', name: 'Owner', venue_id: 'V1', venue: 'Nori Lab Поділ', venue_ok: true, venues: VENUE_LIST, role: 'owner', allowed: [], can_switch: true } };
const COOK_V2 = { found: true, cook: { chat_id: '43', name: 'Cook', venue_id: 'V2', venue: 'Nori Lab Лівобережна', venue_ok: true, venues: VENUE_LIST, role: 'cook', allowed: [], can_switch: false } };
const FLOATER = { found: true, cook: { chat_id: '45', name: 'Floater', venue_id: 'V3', venue: 'Nori Lab Печерськ', venue_ok: true, venues: VENUE_LIST, role: 'cook', allowed: ['V3', 'V4'], can_switch: true } };
const POINT = src('point.js');
let uidSeq = 0;
const trigger = (caption, uid, text) => ({ json: { message: { message_id: 1, caption, text, chat: { id: 42 }, from: { first_name: 'Test' }, date: 1, photo: [{ file_unique_id: uid || 'p' + (++uidSeq) }] } }, binary: { data: {} } });
const vision = (o) => (o === null ? { content: null } : { content: JSON.stringify(o) });
const V = (value, looks, match = null, extra = {}) => ({ display_text: String(value), display_value: value, unit: 'g', digits_confidence: 0.95, readable: value !== null, in_container: false, looks_like: looks, visual_match: match, visual_confidence: 0.9, visual_reason: '', ...extra });

function check(caption, vis, uid, who = OWNER) {
  const trig = trigger(caption, uid);
  const pre = run(MATCH, { input: sheetRows, nodes: { 'Telegram Trigger': trig, 'Кухар': { json: who } } })[0];
  if (pre.json.stop_reply) return { verdict: pre.json.duplicate_of ? 'DUPLICATE' : 'NOT_LOGGED', reply: pre.json.stop_reply, pre: pre.json };
  const out = run(VERDICT, { input: [vision(vis)], nodes: { 'Telegram Trigger': trig, 'Підпис → кандидат': pre, 'Кухар': { json: who } } })[0].json;
  return { ...out, pre: pre.json };
}

let passed = 0, failed = 0;
const expect = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '\n      ' + detail : ''}`); };

// [name, caption, vision answer, expected verdict, expected match_source, expected dish_id, extra check]
const SCENARIOS = [
  // — weight vs the recipe card: underweight is strict (−2.9%), overweight softer (+5%) —
  ['norm in caption, weight within tolerance', 'Тех карта 410', V(410, 'рол'), 'OK', 'norm'],
  ['norm in caption, +7.9% → overweight', 'Тех карта 380 г', V(410, 'рол'), 'OVER', 'norm'],
  ['dish code, within tolerance, looks right', 'R07', V(262, 'рол у кунжуті', true), 'OK', 'caption', 'R07'],
  ['Cyrillic code, +6.5% → overweight', 'р2', V(330, 'рол з вугрем'), 'OVER', 'caption', 'R02'],
  ['+4% is still OK (overweight allows +5%)', 'R06', V(260, 'рол у ікрі', true), 'OK', 'caption', 'R06'],
  ['−3.2% → underweight (underweight allows −2.9%)', 'R06', V(242, 'рол у ікрі', true), 'UNDER', 'caption', 'R06'],
  ['underweight edge: −2.94% is outside −2.9%', 'R06', V(242.65, 'рол у ікрі', true), 'UNDER', 'caption', 'R06', (o) => o.deviation_pct === -2.94],
  ['journal row carries the kitchen and both tolerances', 'R06', V(250, 'рол у ікрі', true), 'OK', 'caption', 'R06', (o) => o.venue_id === 'V1' && o.venue === 'Nori Lab Поділ' && o.tol_under_pct === 2.9 && o.tol_over_pct === 5 && o.demo === false],
  ['reply says НЕДОВАГА', 'R06', V(240, 'рол у ікрі', true), 'UNDER', 'caption', 'R06', (o) => /НЕДОВАГА/.test(o.reply) && /допуск −2.9% \/ \+5%/.test(o.reply)],
  ['reply says ПЕРЕВАГА', 'R06', V(270, 'рол у ікрі', true), 'OVER', 'caption', 'R06', (o) => /ПЕРЕВАГА/.test(o.reply)],
  // — captions —
  ['alias, exact', 'філа вугор', V(308, 'рол з вугрем', true), 'OK', 'caption', 'R02'],
  ['free text, token match', 'запечений з креветкою 8шт', V(318, 'запечений рол', true), 'OK', 'caption', 'R12'],
  ['Russian spelling', 'Филадельфия угорь', V(310, 'рол з вугрем', true), 'OK', 'caption', 'R02'],
  ['Russian spelling, other letters', 'Зеленый дракон', V(330, 'рол з авокадо', true), 'OK', 'caption', 'R08'],
  ['generic word, weight picks (340 is −2.94% off)', 'Дракон', V(330, 'рол'), 'OK', 'caption', 'R08'],
  ['generic word, two dishes of equal weight → ask', 'Темпура', V(300, 'рол у клярі'), 'LOWCONF', '', null, (o) => /R13/.test(o.reply) && /R14/.test(o.reply)],
  ['generic word, weight separates', 'Каліфорнія', V(250, 'рол у ікрі'), 'OK', 'caption', 'R06'],
  ['ambiguous caption resolved by weight', 'філадельфія з', V(261, 'рол'), 'OK', 'caption', 'R04'],
  ['caption not in the recipe cards', 'борщ', V(300, 'рол'), 'LOWCONF', ''],
  // — no caption —
  ['no caption, only one roll fits the weight', '', V(250, 'рол у помаранчевій ікрі'), 'OK', 'weight', 'R06'],
  ['no caption, several rolls weigh the same', '', V(300, 'рол з лососем'), 'LOWCONF', ''],
  ['no caption, a roll is never auto-matched to a poke', '', V(380, 'рол'), 'LOWCONF', ''],
  ['no caption, two pokes weigh the same', '', V(381, 'поке в мисці'), 'LOWCONF', ''],
  // — units, portions, container, misreads —
  ['scale shows kilograms (unit given)', 'R06', V(0.25, 'рол у ікрі', true, { display_text: '0.250', unit: 'kg' }), 'OK', 'caption', 'R06'],
  ['scale shows kilograms (no unit)', 'R06', V(0.25, 'рол у ікрі', true, { display_text: '0.250', unit: '' }), 'OK', 'caption', 'R06'],
  ['decimal point lost on the display (3008 -> 300.8)', 'R05', V(3008, 'рол з лососем', true), 'OK', 'caption', 'R05'],
  ['two portions marked «х2»', 'R06 х2', V(500, 'рол у ікрі', true), 'OK', 'caption', 'R06', (o) => o.norm_grams === 500 && o.portions === 2],
  ['two portions marked «2 порції»', '2 порції Каліфорнія з крабом', V(500, 'рол у ікрі', true), 'OK', 'caption', 'R06'],
  ['in a container: packaging subtracted', 'R06', V(265, 'рол у ікрі', true, { in_container: true }), 'OK', 'caption', 'R06', (o) => o.tare_grams === 15 && o.net_grams === 250],
  ['no container seen: nothing subtracted (+6%)', 'R06', V(265, 'рол у ікрі', true), 'OVER', 'caption', 'R06', (o) => o.tare_grams === 0],
  ['implausible deviation → recheck', 'R06', V(410, 'рол у ікрі', true, { in_container: true }), 'RECHECK', 'caption', 'R06'],
  ['digits unclear → recheck', 'R06', V(710, 'рол у ікрі', true, { digits_confidence: 0.3 }), 'RECHECK', 'caption', 'R06'],
  ['display not readable', 'R01', V(null, 'рол'), 'UNREADABLE', 'caption'],
  ['Vision returned an empty answer', 'R01', null, 'UNREADABLE', 'caption'],
  // — visual check —
  ['caption clearly does not match the photo', 'Філадельфія з вугрем', V(300, 'рол з лососем', false, { visual_reason: 'зверху лосось, не вугор' }), 'MISMATCH', 'caption', 'R02'],
  ['unsure mismatch → weight verdict + warning', 'Філадельфія з вугрем', V(310, 'рол з лососем', false, { visual_confidence: 0.5, visual_reason: 'схоже на лосось' }), 'OK', 'caption', 'R02', (o) => o.visual_check === 'doubt' && /Можлива невідповідність/.test(o.reply)],
  ['unreadable display still reports a clear mismatch', 'R02', V(null, 'рол з лососем', false, { readable: false, visual_reason: 'немає вугра' }), 'UNREADABLE', 'caption', null, (o) => /Також фото не схоже/.test(o.reply)],
];
staticData = {};
for (const [name, caption, vis, expVerdict, expSource, expId, extra] of SCENARIOS) {
  const o = check(caption, vis);
  const ok = o.verdict === expVerdict && o.match_source === expSource && (!expId || o.dish_id === expId) && (!extra || extra(o));
  expect(`${name}  →  ${o.verdict}${o.dish_id ? ' ' + o.dish_id : ''}${o.deviation_pct != null ? ' (' + o.deviation_pct + '%)' : ''}`, ok,
    `expected ${expVerdict}/${expSource}/${expId || '-'}; got ${o.verdict}/${o.match_source}/${o.dish_id}; reply: ${String(o.reply).replace(/\n/g, ' | ')}`);
}

// — repeat photo —
staticData = {};
const first = check('R06', V(250, 'рол у ікрі', true), 'same-photo');
const second = check('R06', V(250, 'рол у ікрі', true), 'same-photo');
expect('the same photo sent twice is flagged as a repeat', first.verdict === 'OK' && second.verdict === 'DUPLICATE');
staticData = {};
check('R01', null, 'empty-answer');
expect('a photo whose check failed (empty Vision answer) can be sent again', check('R01', V(300, 'рол з лососем', true), 'empty-answer').verdict !== 'DUPLICATE');
staticData = {};
check('', V(410, 'рол'), 'forgot-caption');
const fixed = check('R25', V(475, 'сет макі', true), 'forgot-caption');
expect('forgot the caption → the same photo with a caption is checked again (🔁)', fixed.verdict === 'OK' && fixed.dish_id === 'R25' && /Повторна перевірка/.test(fixed.reply));
staticData = {};
check('R06', V(250, 'рол у ікрі', true), 'wrong-caption');
const corrected = check('R07', V(250, 'рол у ікрі', false), 'wrong-caption');
expect('a final verdict with a wrong caption can be corrected by re-sending with another caption', corrected.verdict !== 'DUPLICATE' && corrected.dish_id === 'R07');
staticData = { seen: { 'legacy-photo': '2026-11-05 10:00:00' } };
const legacy3 = check('R06', V(250, 'рол у ікрі', true), 'legacy-photo');
expect('older repeat records (bare timestamp) allow one re-check, then the new rule applies', legacy3.verdict === 'OK' && check('R06', V(250, 'рол у ікрі', true), 'legacy-photo').verdict === 'DUPLICATE');
staticData = {};
expect('people who can switch kitchens see where the check is logged', /📍 V1 · Nori Lab Поділ/.test(check('R06', V(250, 'рол у ікрі', true)).reply));

// — kitchen lock: the kitchen comes from the Telegram ID; a locked cook cannot log into another kitchen —
staticData = {};
const wrong = check('R06 V3', V(250, 'рол у ікрі', true), 'locked-photo', COOK_V2);
expect('locked cook writes another kitchen\'s code → not logged, warned', wrong.verdict === 'NOT_LOGGED' && /закріплені за точкою V2/.test(wrong.reply) && /V3 · Nori Lab Печерськ/.test(wrong.reply), wrong.reply);
expect('…and nothing is remembered, so the same photo without the code is checked normally', !(staticData.seen || {})['locked-photo']
  && check('R06', V(250, 'рол у ікрі', true), 'locked-photo', COOK_V2).venue_id === 'V2');
const ownCode = check('R06 V2', V(250, 'рол у ікрі', true), undefined, COOK_V2);
expect('locked cook with the own kitchen code → logged to it, the code does not confuse the dish', ownCode.verdict === 'OK' && ownCode.venue_id === 'V2' && ownCode.dish_id === 'R06');
expect('locked cook without a code → own kitchen, no 📍 line', (() => { const o = check('R06', V(250, 'рол у ікрі', true), undefined, COOK_V2); return o.venue_id === 'V2' && !/📍/.test(o.reply); })());
const floatV4 = check('R06 V4', V(250, 'рол у ікрі', true), undefined, FLOATER);
expect('cook with allowed_venues codes V4 → this check goes to V4 and says so', floatV4.venue_id === 'V4' && floatV4.venue === 'Nori Lab Оболонь' && /📍 V4 · Nori Lab Оболонь/.test(floatV4.reply));
const ownerV2 = check('Каліфорнія в2', V(250, 'рол у ікрі', true), undefined, OWNER);
expect('owner may code any kitchen (Cyrillic «в2»)', ownerV2.venue_id === 'V2' && ownerV2.dish_id === 'R06');
expect('unknown kitchen code → not logged', /немає серед активних/.test(check('R06 V9', V(250, 'рол', true), undefined, COOK_V2).reply));
const orphan = { found: true, cook: { ...COOK_V2.cook, venue_id: 'V7', venue: 'V7', venue_ok: false } };
expect('profile kitchen is not an active kitchen → not logged', /не прив'язано до активної точки/.test(check('R06', V(250, 'рол', true), undefined, orphan).reply));
// cook lookup by the Telegram user ID, kitchen checked against «Точки»
staticData = {};
const venueSheet = VENUE_LIST.map((v) => ({ json: { venue_id: v.id, name: v.name, active: 'TRUE' } }));
const byId = trigger('', '', '/stats'); byId.json.message.from = { id: 43 };
const lookRows = [{ chat_id: 43, name: 'Cook', venue_id: 'v2', role: 'cook', active: true }, { chat_id: 46, name: 'Lost', venue_id: 'V7', role: 'cook', active: true }];
const c43 = run(COOK, { input: lookRows, nodes: { 'Telegram Trigger': byId, 'Точки — для кешу': venueSheet } })[0].json;
expect('sender is found by Telegram user ID (from.id), kitchen name taken from «Точки»', c43.found && c43.cook.chat_id === '43' && c43.cook.venue_ok && c43.cook.venue === 'Nori Lab Лівобережна' && c43.cook.venues.length === 4);
const COOKS_CACHE = src('cooks-cache.js');
const cacheFor = (fromId) => { const t = trigger('', '', '/start'); t.json.message.from = { id: fromId }; return run(COOKS_CACHE, { input: [{}], nodes: { 'Telegram Trigger': t } })[0].json.fresh; };
expect('cook cache: a known sender uses the cache, a sender missing from it re-reads the sheet at once', cacheFor(43) === true && cacheFor(900000099) === false);
const lost = trigger('', '', '/stats'); lost.json.message.from = { id: 46 };
expect('a kitchen missing from «Точки» is flagged (also when served from the cache)', run(COOK, { input: [{ fresh: true }], nodes: { 'Telegram Trigger': lost } })[0].json.cook.venue_ok === false);

// — «📍 Точка» —
const venueRows = readCsv('venues.csv').map((v) => ({ ...v, active: v.active === 'TRUE' }));
const point = (who, text) => run(POINT, { input: venueRows, nodes: { 'Telegram Trigger': trigger('', '', text), 'Кухар': { json: who } } })[0].json;
const menu = point(OWNER, '📍 Точка');
expect('owner «📍 Точка» → menu of all kitchens', menu.action === 'menu' && /V4 · Nori Lab Оболонь/.test(menu.reply));
staticData = { cooks: { at: Date.now(), rows: [] } };
const sw = point(OWNER, '📍 V2 · Лівобережна');
expect('owner taps «📍 V2» → switch, cook cache cleared', sw.action === 'set' && sw.venue_id === 'V2' && sw.venue === 'Nori Lab Лівобережна' && !staticData.cooks);
expect('switching to the current kitchen changes nothing', point(OWNER, '/point V1').action === 'deny');
expect('a regular cook cannot switch', point(COOK_V2, '/point V3').action === 'deny' && point(COOK_V2, '📍 Точка').action === 'deny');
expect('a floating cook switches only within allowed_venues', point(FLOATER, '📍 V4 · Оболонь').action === 'set' && point(FLOATER, '/point V1').action === 'deny');
expect('an unknown kitchen is refused', /немає серед активних/.test(point(OWNER, '/point V9').reply));
const tg45 = trigger('', '', '📍 Точка'); tg45.json.message.chat.id = 45;
const fl = run(COOK, { input: [{ chat_id: 45, name: 'Floater', venue_id: 'V3', role: 'cook', active: true, allowed_venues: 'V3; V4' }], nodes: { 'Telegram Trigger': tg45 } })[0].json;
expect('cook list: allowed_venues is parsed and enables switching', fl.cook.can_switch === true && fl.cook.allowed.join() === 'V3,V4');

// — caches —
staticData = {};
run(MATCH, { input: sheetRows, nodes: { 'Telegram Trigger': trigger('R06') } });
const cached = run(MATCH, { input: [{ fresh: true }], nodes: { 'Telegram Trigger': trigger('R06') } })[0].json;
expect('recipe cards come from the cache when the sheet is skipped', cached.card && cached.card.dish_id === 'R06' && cached.cards.length === 30);
staticData = {};
let threw = false; try { run(MATCH, { input: [{ fresh: true }], nodes: { 'Telegram Trigger': trigger('R06') } }); } catch (e) { threw = /немає даних/.test(e.message); }
expect('no cards and no cache → error, not a silent guess', threw);
const COOK_ROWS = [{ chat_id: 42, name: 'Owner', venue_id: 'v1', venue: 'Nori Lab Поділ', role: 'Owner', active: true }, { chat_id: 43, name: 'Cook', venue_id: 'V2', venue: 'Nori Lab Лівобережна', role: 'cook', active: true }, { chat_id: 44, name: 'Gone', venue_id: 'V3', role: 'cook', active: false }];
staticData = {};
const c1 = run(COOK, { input: COOK_ROWS, nodes: { 'Telegram Trigger': trigger('', '', '/stats') } })[0].json;
expect('cook list: the owner is found with role and kitchen', c1.found && c1.cook.role === 'owner' && c1.cook.venue_id === 'V1');
const c2 = run(COOK, { input: [{ fresh: true }], nodes: { 'Telegram Trigger': trigger('', '', '/stats') } })[0].json;
expect('cook list: served from the cache', c2.found && c2.cook.name === 'Owner');
const tg44 = trigger('', '', 'hi'); tg44.json.message.chat.id = 44;
expect('cook list: an inactive cook has no access', run(COOK, { input: COOK_ROWS, nodes: { 'Telegram Trigger': tg44 } })[0].json.found === false);

// — reports —
const journal = readCsv('demo_journal.csv');
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
const statsFor = (who, text) => run(STATS, { input: journal, nodes: { 'Telegram Trigger': trigger('', '', text), 'Кухар': { json: who } } })[0].json.reply;
const net = statsFor(OWNER, '/stats all');
expect('owner /stats all → all four kitchens side by side', ['V1', 'V2', 'V3', 'V4'].every((v) => net.includes(v + ' Nori Lab')) && /Найбільше недоваги: V2/.test(net) && /Найбільше переваги: V3/.test(net), net.split('\n').slice(0, 14).join(' | '));
const v2 = statsFor(OWNER, '/stats V2 all');
expect('owner /stats V2 → one kitchen with its underweight', /V2 Nori Lab Лівобережна/.test(v2) && /Недовага: \d{2,}/.test(v2) && !/V3/.test(v2));
const cookView = statsFor(COOK_V2, '/stats V3 all');
expect('a cook sees only their own kitchen, even when asking for another', /V2 Nori Lab Лівобережна/.test(cookView) && /лише власнику/.test(cookView) && !/Печерськ/.test(cookView));
const legacy = run(STATS, { input: [{ venue_id: 'V1', venue: 'Nori Lab Поділ', date: today, verdict: 'BRAK', deviation_pct: -4 }, { venue_id: 'V1', venue: 'Nori Lab Поділ', date: today, verdict: 'BRAK', deviation_pct: 6 }], nodes: { 'Telegram Trigger': trigger('', '', '/stats V1'), 'Кухар': { json: OWNER } } })[0].json.reply;
expect('old BRAK rows count as underweight / overweight by sign', /Недовага: 1/.test(legacy) && /Перевага: 1/.test(legacy));
const now = run(REPORT_NOW, { input: journal, nodes: { 'Telegram Trigger': trigger('', '', '/report'), 'Кухар': { json: OWNER } } })[0].json.reply;
expect('/report for the owner → today\'s network report', /Щоденний звіт/.test(now) && /Мережа — за сьогодні/.test(now));
const denied = run(REPORT_NOW, { input: journal, nodes: { 'Telegram Trigger': trigger('', '', '/report'), 'Кухар': { json: COOK_V2 } } })[0].json.reply;
expect('/report for a cook → refused', /лише власнику/.test(denied));
const people = [{ chat_id: 1, role: 'owner', venue_id: 'V1', active: true }, { chat_id: 2, role: 'manager', venue_id: 'V2', venue: 'Nori Lab Лівобережна', active: 'TRUE' }, { chat_id: 3, role: 'cook', venue_id: 'V2', active: true }, { chat_id: 4, role: 'manager', venue_id: 'V3', active: false }];
const daily = run(DAILY, { input: people, nodes: { 'Журнал — для звіту': journal.map((j) => ({ json: j })) } }).map((i) => i.json);
expect('daily report: owner gets the network, each active manager their kitchen, cooks nothing', daily.length === 2 && /Мережа/.test(daily.find((d) => d.chat_id === '1').reply) && /V2 Nori Lab Лівобережна/.test(daily.find((d) => d.chat_id === '2').reply));
// UPD 2026-11-05: the 22:00 report of 5 Nov showed 54 checks but its categories summed to 50, and named only V1 of three kitchens at 50%
const VN = { V1: 'Nori Lab Поділ', V2: 'Nori Lab Лівобережна', V3: 'Nori Lab Печерськ', V4: 'Nori Lab Оболонь' };
const rowsOf = (venue, verdict, n, dev = '') => Array.from({ length: n }, () => ({ venue_id: venue, venue: VN[venue], date: today, verdict, deviation_pct: dev, dish_id: 'R09', dish_name: 'Червоний дракон' }));
const netToday = (rows) => run(STATS, { input: rows, nodes: { 'Telegram Trigger': trigger('', '', '/stats'), 'Кухар': { json: OWNER } } })[0].json.reply;
const tie = netToday([...rowsOf('V1', 'OK', 3), ...rowsOf('V1', 'LOWCONF', 2), ...rowsOf('V1', 'UNREADABLE', 1),
  ...rowsOf('V2', 'OK', 3), ...rowsOf('V2', 'UNDER', 3, -4),
  ...rowsOf('V3', 'OK', 8), ...rowsOf('V3', 'OVER', 2, 6)]);
expect('network line: ⚠️ counts undetermined + unreadable, so the categories add up', /V1 Nori Lab Поділ: 6 перевірок\n\s+✅ 50% · ⬇️ 0 · ⬆️ 0 · 🚫 0 · 🔎 0 · ⚠️ 3/.test(tie) && /Разом: 22 · .*⚠️ 3/.test(tie) && /⚠️ не визначено або нечитабельно/.test(tie), tie);
expect('lowest share in norm: a tie names every tied kitchen', /Найнижчий % у нормі \(50%\): V1 Nori Lab Поділ, V2 Nori Lab Лівобережна/.test(tie) && !/Печерськ \(80%\)/.test(tie));
const allTie = netToday([...rowsOf('V1', 'OK', 5), ...rowsOf('V2', 'OK', 5)]);
expect('lowest share in norm: no "lowest" line when every kitchen is equal', !/Найнижчий/.test(allTie) && /Разом: 10/.test(allTie), allTie);

// — demo history agrees with the verdict rule —
const cardsById = Object.fromEntries(sheetRows.map((c) => [c.dish_id, c]));
let bad = 0, weighed = 0;
for (const r of journal) {
  if (!['OK', 'UNDER', 'OVER'].includes(r.verdict)) continue;
  weighed++;
  const c = cardsById[r.dish_id]; const normTotal = Number(r.norm_grams); const dev = (Number(r.net_grams) - normTotal) / normTotal * 100;
  const want = dev < -c.tol_under_pct ? 'UNDER' : dev > c.tol_over_pct ? 'OVER' : 'OK';
  if (want !== r.verdict || normTotal !== c.norm_grams * Number(r.portions)) bad++;
}
expect(`demo history: ${weighed} weighed rows match the under/over rule`, bad === 0, `${bad} rows disagree`);
expect('demo history: every row is marked demo and has a kitchen', journal.every((r) => r.demo === 'TRUE' && /^V[1-4]$/.test(r.venue_id)));

// — Telegram texts go out as HTML with escaping (legacy Markdown rejected a reply with «@night_cook») —
const wf = JSON.parse(fs.readFileSync(path.join(root, 'workflows', 'sushi-qc-bot.json'), 'utf8'));
const sends = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.telegram' && n.parameters.operation === 'sendMessage');
const nasty = 'Cook (@night_cook) <b>R&D</b> *x*';
const fakeItem = { json: { reply: nasty, chat_id: '1', duplicate_of: nasty, message: { chat: { id: 1 } } } };
const render = (t) => (!t.startsWith('=') ? t : t.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (_, e) =>
  new Function('$json', '$', 'return (' + e + ');')(fakeItem.json, () => ({ first: () => fakeItem, item: fakeItem }))));
const rendered = sends.map((n) => ({ name: n.name, html: n.parameters.additionalFields.parse_mode === 'HTML', text: render(n.parameters.text) }));
expect(`Telegram: all ${sends.length} text messages are sent as HTML`, rendered.every((r) => r.html), rendered.filter((r) => !r.html).map((r) => r.name).join(', '));
const unsafe = rendered.filter((r) => /[<>]/.test(r.text) || /&(?!amp;|lt;|gt;)/.test(r.text));
expect('Telegram: _ < > & in names and replies are escaped', !unsafe.length && rendered.find((r) => r.name === 'Відповідь статистики').text === 'Cook (@night_cook) &lt;b&gt;R&amp;D&lt;/b&gt; *x*', unsafe.map((r) => r.name).join(', '));

const helpText = wf.nodes.find((n) => n.name === 'Допомога').parameters.text;
const helpFor = (cook) => helpText.slice(1).replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => new Function('$json', '$', 'return (' + e + ');')({}, () => ({ first: () => ({ json: { cook } }) })));
expect('help depends on the role: owner commands only for the owner, a locked cook sees the own kitchen',
  /\/report/.test(helpFor(OWNER.cook)) && !/\/report/.test(helpFor(COOK_V2.cook)) && /Ваша точка — V2 · Nori Lab Лівобережна/.test(helpFor(COOK_V2.cook))
  && /кількох точках/.test(helpFor(FLOATER.cook)) && !/\/report/.test(helpFor(FLOATER.cook)));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
