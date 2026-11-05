// ===== report-lib — shared by «Зведення», «Звіт на вимогу» and «Щоденний звіт» (tools/build-workflow.js inlines it) =====
const RL = (() => {
  const INCLUDE_DEMO = true; // the demo history counts in reports; set to false for a real kitchen
  const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const isDemo = (r) => r.demo === true || String(r.demo).trim().toUpperCase() === 'TRUE';
  const kyivDate = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(d);
  const today = () => kyivDate(new Date());
  const daysAgo = (n) => kyivDate(new Date(Date.now() - n * 86400000));
  // v3 rows still say BRAK — split by the sign of the deviation
  const verdictOf = (r) => { const v = String(r.verdict || ''); if (v !== 'BRAK') return v; const d = num(r.deviation_pct); return d != null && d < 0 ? 'UNDER' : 'OVER'; };

  function filterRows(rows, { venue = null, from = null, includeDemo = INCLUDE_DEMO } = {}) {
    return rows.filter((r) => r && r.verdict
      && (!venue || String(r.venue_id).trim().toUpperCase() === venue)
      && (!from || String(r.date || '').slice(0, 10) >= from)
      && (includeDemo || !isDemo(r)));
  }
  function summarize(rows) {
    const s = { total: rows.length, OK: 0, UNDER: 0, OVER: 0, MISMATCH: 0, RECHECK: 0, LOWCONF: 0, UNREADABLE: 0 };
    const under = [], over = [];
    for (const r of rows) {
      const v = verdictOf(r); if (v in s) s[v]++;
      const d = num(r.deviation_pct);
      if (v === 'UNDER' && d != null) under.push(d);
      if (v === 'OVER' && d != null) over.push(d);
    }
    const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);
    s.okPct = s.total ? Math.round(s.OK / s.total * 1000) / 10 : null;
    s.avgUnder = avg(under); s.avgOver = avg(over);
    return s;
  }
  function top(rows, keyFn, n = 3) {
    const m = new Map();
    for (const r of rows) {
      const v = verdictOf(r); if (!['UNDER', 'OVER', 'MISMATCH'].includes(v)) continue;
      const k = keyFn(r); if (!k) continue;
      const e = m.get(k) || { k, n: 0, UNDER: 0, OVER: 0, MISMATCH: 0 }; e.n++; e[v]++; m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, n);
  }
  const pct = (v) => (v == null ? '—' : v + '%');
  const sgn = (v) => (v == null ? '' : (v > 0 ? '+' : '') + v + '%');
  const kinds = (e) => [e.UNDER ? '⬇️' + e.UNDER : '', e.OVER ? '⬆️' + e.OVER : '', e.MISMATCH ? '🚫' + e.MISMATCH : ''].filter(Boolean).join(' ');
  // UPD 2026-11-05: ⚠️ (undetermined + unreadable) added so the categories add up to the check count
  const line = (s) => `✅ ${pct(s.okPct)} · ⬇️ ${s.UNDER}${s.UNDER ? ' (' + sgn(s.avgUnder) + ')' : ''} · ⬆️ ${s.OVER}${s.OVER ? ' (' + sgn(s.avgOver) + ')' : ''} · 🚫 ${s.MISMATCH} · 🔎 ${s.RECHECK} · ⚠️ ${s.LOWCONF + s.UNREADABLE}`;
  const LEGEND = '✅ у нормі · ⬇️ недовага · ⬆️ перевага · 🚫 фото ≠ підпис · 🔎 перевірити · ⚠️ не визначено або нечитабельно';
  const dishKey = (r) => [r.dish_id, r.dish_name].filter(Boolean).join(' ');

  function venueReport(rows, title, period) {
    const s = summarize(rows);
    const L = [`📊 ${title} — ${period}`, '', `Перевірок: ${s.total}`,
      `✅ У нормі: ${s.OK} (${pct(s.okPct)})`,
      `⬇️ Недовага: ${s.UNDER}${s.UNDER ? ' · середня ' + sgn(s.avgUnder) : ''}`,
      `⬆️ Перевага: ${s.OVER}${s.OVER ? ' · середня ' + sgn(s.avgOver) : ''}`,
      `🚫 Фото ≠ підпис: ${s.MISMATCH}`, `🔎 Перевірити: ${s.RECHECK}`, `⚠️ Не визначено / ❓ нечитабельно: ${s.LOWCONF + s.UNREADABLE}`];
    const td = top(rows, dishKey);
    if (td.length) { L.push('', 'Страви з відхиленнями:'); for (const e of td) L.push(`• ${e.k}: ${e.n} (${kinds(e)})`); }
    const tc = top(rows, (r) => r.chef);
    if (tc.length) { L.push('', 'Кухарі з відхиленнями:'); for (const e of tc) L.push(`• ${e.k}: ${e.n} (${kinds(e)})`); }
    if (!s.total) L.push('', 'Перевірок за цей період немає.');
    return L.join('\n');
  }
  function networkReport(rows, period) {
    const names = new Map();
    for (const r of rows) if (r.venue_id) names.set(String(r.venue_id).trim().toUpperCase(), String(r.venue || r.venue_id));
    const per = [...names.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, name]) => ({ id, name, s: summarize(rows.filter((r) => String(r.venue_id).trim().toUpperCase() === id)) }));
    const L = [`🏢 Мережа — ${period}`, ''];
    for (const v of per) L.push(`${v.id} ${v.name}: ${v.s.total} перевірок`, '   ' + line(v.s));
    const all = summarize(rows);
    L.push('', `Разом: ${all.total} · ${line(all)}`);
    const withData = per.filter((v) => v.s.total >= 5);
    if (withData.length > 1) {
      // UPD 2026-11-05: a tie names every kitchen that shares the value; when all kitchens tie there is no "lowest"
      const leaders = (f) => { const best = Math.max(...withData.map(f)); return withData.filter((v) => f(v) === best); };
      const worst = leaders((v) => -(v.s.okPct ?? 0));
      const under = leaders((v) => v.s.UNDER / v.s.total);
      const over = leaders((v) => v.s.OVER / v.s.total);
      const H = [];
      if (worst.length === 1) H.push(`Найнижчий % у нормі: ${worst[0].id} ${worst[0].name} (${pct(worst[0].s.okPct)})`);
      else if (worst.length < withData.length) H.push(`Найнижчий % у нормі (${pct(worst[0].s.okPct)}): ${worst.map((v) => v.id + ' ' + v.name).join(', ')}`);
      if (under[0].s.UNDER) H.push('Найбільше недоваги: ' + under.map((v) => `${v.id} ${v.name} (${v.s.UNDER} з ${v.s.total}, середня ${sgn(v.s.avgUnder)})`).join('; '));
      if (over[0].s.OVER) H.push('Найбільше переваги: ' + over.map((v) => `${v.id} ${v.name} (${v.s.OVER} з ${v.s.total}, середня ${sgn(v.s.avgOver)})`).join('; '));
      if (H.length) L.push('', ...H);
    }
    const td = top(rows, dishKey);
    if (td.length) { L.push('', 'Страви з відхиленнями по мережі:'); for (const e of td) L.push(`• ${e.k}: ${e.n} (${kinds(e)})`); }
    if (!all.total) L.push('Перевірок за цей період немає.');
    else L.push('', LEGEND);
    return L.join('\n');
  }
  function periodFrom(text) {
    const t = String(text || '').toLowerCase();
    if (/(all|все|всі|весь)/.test(t)) return { from: null, label: 'за весь час' };
    if (/(^|\s)7(\s|$)|тиж|нед|week/.test(t)) return { from: daysAgo(6), label: 'за 7 днів' };
    return { from: today(), label: 'за сьогодні (' + today() + ')' };
  }
  function venueFrom(text) {
    const m = String(text || '').match(/(?:^|\s)[vв]\s?(\d{1,2})(?!\d)/i);
    return m ? 'V' + Number(m[1]) : null;
  }
  return { INCLUDE_DEMO, filterRows, summarize, venueReport, networkReport, periodFrom, venueFrom, today, verdictOf };
})();
// ===== end report-lib =====
