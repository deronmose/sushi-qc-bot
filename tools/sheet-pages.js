// Builds the formula pages of the Google Sheet: «Мережа» (all kitchens side by side) and one page per kitchen.
// Every value is a formula over the «Журнал» tab, so the pages update themselves. Formulas are written with «,»
// and converted to the sheet's argument separator («;» for Ukrainian/Russian locales).
//   const { buildPages } = require('./tools/sheet-pages'); buildPages(venues, ';')  →  [{ title, rows: [{...}] }]
// The first row's keys become the header row when the rows are appended to an empty tab (n8n Google Sheets node,
// cell format USER_ENTERED). Column letters follow data/journal_template.csv.

const J = (c) => `Журнал!$${c}$2:$${c}`;
const COL = { venue: 'A', ts: 'C', date: 'D', chef: 'E', code: 'G', dish: 'H', net: 'N', dev: 'O', verdict: 'R', visual: 'S', demo: 'X' };
const DEMO_TOGGLE = 'Мережа!$B$2';
const demoMask = `((${J(COL.demo)}=FALSE)+(${DEMO_TOGGLE}="ТАК")>0)`;
const demoQuery = `IF(${DEMO_TOGGLE}="ТАК",""," and X = false")`;
const day = (n) => `TEXT(TODAY()-${n},"yyyy-mm-dd")`;
const PERIOD = {
  today: `(${J(COL.date)}=${day(0)})`,
  week: `(${J(COL.date)}>=${day(6)})*(${J(COL.date)}<>"")`,
  all: `(${J(COL.date)}<>"")`,
};
const venueMask = (id) => `(${J(COL.venue)}="${id}")`;
const anyVenue = `(${J(COL.venue)}<>"")`;
const count = (vm, period, verdicts) => `=SUMPRODUCT(${vm}*${PERIOD[period]}*${demoMask}${verdicts ? '*(' + verdicts.map((v) => `(${J(COL.verdict)}="${v}")`).join('+') + ')' : ''})`;
const avgDev = (vm, period, verdict, countCell) => `=IFERROR(ROUND(SUMPRODUCT(${vm}*${PERIOD[period]}*${demoMask}*(${J(COL.verdict)}="${verdict}")*${J(COL.dev)})/${countCell},1),"—")`;
const pctOf = (part, total) => `=IFERROR(ROUND(100*${part}/${total},1),"—")`;
const topN = (where, groupCol, k) => `=IFERROR(TEXTJOIN(" — ",TRUE,INDEX(QUERY(Журнал!$A$2:$X,"select ${groupCol}, count(${groupCol}) where ${where} and D >= '"&${day(6)}&"' and (R = 'UNDER' or R = 'OVER' or R = 'MISMATCH')"&${demoQuery}&" group by ${groupCol} order by count(${groupCol}) desc label count(${groupCol}) ''",0),${k},0)),"—")`;

// «,» → sep, outside of string literals only
function localize(formula, sep) {
  if (sep === ',' || typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  let out = '', q = false;
  for (const ch of formula) { if (ch === '"') q = !q; out += !q && ch === ',' ? sep : ch; }
  return out;
}

function venuePage(v) {
  const H = ['Показник', 'Сьогодні', '7 днів', 'Весь час'];
  const vm = venueMask(v.venue_id);
  const rows = [];
  const add = (label, cells = {}) => { const r = { [H[0]]: label }; for (const [k, val] of Object.entries(cells)) r[k] = val; rows.push(r); return rows.length + 1; }; // sheet row number
  const per = (fn) => ({ [H[1]]: fn('today', 'B'), [H[2]]: fn('week', 'C'), [H[3]]: fn('all', 'D') });
  add(`${v.name} · ${v.address} · ${v.city}`);
  const total = add('Перевірок', per((p) => count(vm, p)));
  const ok = add('✅ У нормі', per((p) => count(vm, p, ['OK'])));
  add('% у нормі', per((p, c) => pctOf(`${c}${ok}`, `${c}${total}`)));
  const under = add('⬇️ Недовага', per((p) => count(vm, p, ['UNDER'])));
  add('⬇️ Середня недовага, %', per((p, c) => avgDev(vm, p, 'UNDER', `${c}${under}`)));
  const over = add('⬆️ Перевага', per((p) => count(vm, p, ['OVER'])));
  add('⬆️ Середня перевага, %', per((p, c) => avgDev(vm, p, 'OVER', `${c}${over}`)));
  add('🚫 Фото ≠ підпис', per((p) => count(vm, p, ['MISMATCH'])));
  add('🔎 Перевірити', per((p) => count(vm, p, ['RECHECK'])));
  add('⚠️ Не визначено / ❓ нечитабельно', per((p) => count(vm, p, ['LOWCONF', 'UNREADABLE'])));
  add('');
  add('Страви з відхиленнями (7 днів):');
  for (let k = 1; k <= 5; k++) add(topN(`A = '${v.venue_id}'`, 'H', k));
  add('');
  add('Кухарі з відхиленнями (7 днів):');
  for (let k = 1; k <= 3; k++) add(topN(`A = '${v.venue_id}'`, 'E', k));
  add('');
  add('Усі перевірки точки — нові зверху:');
  add(`=QUERY(Журнал!$A$1:$X,"select C, E, G, H, N, O, R, S where A = '${v.venue_id}'"&${demoQuery}&" order by C desc label C 'Час', E 'Кухар', G 'Код', H 'Страва', N 'Нетто, г', O 'Відхилення, %', R 'Вердикт', S 'Фото vs підпис'",1)`);
  return { title: `${v.venue_id} · ${v.name.replace(/^Nori Lab\s*/, '')}`, headers: H, rows };
}

function networkPage(venues) {
  const H = ['Точка', 'Перевірок (7 днів)', '% у нормі', '⬇️ Недовага', 'Середня недовага, %', '⬆️ Перевага', 'Середня перевага, %', '🚫 Фото ≠ підпис', '🔎 Перевірити', 'Перевірок сьогодні', '% у нормі сьогодні'];
  const rows = [];
  const add = (cells) => { rows.push(cells); return rows.length + 1; };
  add({ [H[0]]: 'Враховувати демо-дані (ТАК / НІ):', [H[1]]: 'ТАК' });
  add({ [H[0]]: '' });
  const first = rows.length + 2;
  const line = (label, vm, r) => ({
    [H[0]]: label,
    [H[1]]: count(vm, 'week'),
    [H[2]]: `=IFERROR(ROUND(100*SUMPRODUCT(${vm}*${PERIOD.week}*${demoMask}*(${J(COL.verdict)}="OK"))/B${r},1),"—")`,
    [H[3]]: count(vm, 'week', ['UNDER']),
    [H[4]]: avgDev(vm, 'week', 'UNDER', `D${r}`),
    [H[5]]: count(vm, 'week', ['OVER']),
    [H[6]]: avgDev(vm, 'week', 'OVER', `F${r}`),
    [H[7]]: count(vm, 'week', ['MISMATCH']),
    [H[8]]: count(vm, 'week', ['RECHECK']),
    [H[9]]: count(vm, 'today'),
    [H[10]]: `=IFERROR(ROUND(100*SUMPRODUCT(${vm}*${PERIOD.today}*${demoMask}*(${J(COL.verdict)}="OK"))/J${r},1),"—")`,
  });
  venues.forEach((v, i) => add(line(`${v.venue_id} · ${v.name}`, venueMask(v.venue_id), first + i)));
  const last = first + venues.length - 1;
  const totalRow = rows.length + 2;
  add(line('Мережа разом', anyVenue, totalRow));
  add({ [H[0]]: '' });
  const range = (c) => `${c}${first}:${c}${last}`;
  add({ [H[0]]: 'Найнижчий % у нормі (7 днів):', [H[1]]: `=IFERROR(INDEX(${range('A')},MATCH(MIN(${range('C')}),${range('C')},0)),"—")` });
  add({ [H[0]]: 'Найбільше недоваги:', [H[1]]: `=IFERROR(INDEX(${range('A')},MATCH(MAX(${range('D')}),${range('D')},0)),"—")` });
  add({ [H[0]]: 'Найбільше переваги:', [H[1]]: `=IFERROR(INDEX(${range('A')},MATCH(MAX(${range('F')}),${range('F')},0)),"—")` });
  add({ [H[0]]: '' });
  add({ [H[0]]: 'Страви з відхиленнями по мережі (7 днів):' });
  for (let k = 1; k <= 5; k++) add({ [H[0]]: topN(`A <> ''`, 'H', k) });
  add({ [H[0]]: '' });
  add({ [H[0]]: 'Усе рахується формулами з листа «Журнал». Перемикач демо-даних — клітинка B2 (ТАК / НІ).' });
  return { title: 'Мережа', headers: H, rows };
}

function buildPages(venues, sep = ',') {
  const pages = [networkPage(venues), ...venues.map(venuePage)];
  for (const p of pages) {
    // the first row must carry every header key: its keys become the header row of the empty tab
    p.rows[0] = Object.fromEntries(p.headers.map((k) => [k, p.rows[0][k] ?? '']));
    p.rows = p.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, localize(v, sep)])));
  }
  return pages;
}
module.exports = { buildPages, localize };

// CLI: write the pages as CSV files with formulas, ready for File → Import in Google Sheets
// («Insert new sheet(s)», keep «Convert text to numbers, dates and formulas» on).
//   node tools/sheet-pages.js ";"   → data/pages/page-network.csv, page-V1.csv … (use "," for an English-locale sheet)
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const sep = process.argv[2] || ';';
  const [h, ...l] = fs.readFileSync(path.join(root, 'data', 'venues.csv'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  const cols = h.split(',');
  const venues = l.map((r) => Object.fromEntries(r.split(',').map((x, i) => [cols[i], x])));
  const outDir = path.join(root, 'data', 'pages');
  fs.mkdirSync(outDir, { recursive: true });
  const cell = (x) => { const s = String(x ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  for (const p of buildPages(venues, sep)) {
    const file = p.title === 'Мережа' ? 'page-network.csv' : `page-${p.title.split(' ')[0]}.csv`;
    const lines = [p.headers.map(cell).join(','), ...p.rows.map((r) => p.headers.map((k) => cell(r[k])).join(','))];
    fs.writeFileSync(path.join(outDir, file), lines.join('\n') + '\n');
    console.log(`${file} — tab «${p.title}», ${p.rows.length} rows`);
  }
}
