// Code node «Зведення» — runs once for all items (input: rows of the «Журнал» sheet). Builds the /stats reply.
const readErr = $input.all().find(i => i.json && i.json.error);
if (readErr) throw new Error('Журнал: ' + readErr.json.error);

const N = '\n';
const msg = $('Telegram Trigger').first().json.message || {};
const rows = $input.all().map(i => i.json).filter(r => r && r.verdict);
const scopeAll = /(all|все|всі|усі|весь)/i.test(String(msg.text || ''));
const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
const inScope = scopeAll ? rows : rows.filter(r => String(r.date || '').slice(0, 10) === today);
const cnt = v => inScope.filter(r => r.verdict === v).length;
const devs = inScope.filter(r => r.verdict === 'OK' || r.verdict === 'BRAK')
  .map(r => Math.abs(Number(String(r.deviation_pct).replace(',', '.')))).filter(Number.isFinite);
const avg = devs.length ? Math.round(devs.reduce((a, b) => a + b, 0) / devs.length * 10) / 10 : null;
const icon = { BRAK: '⛔️', MISMATCH: '🚫', RECHECK: '🔎', LOWCONF: '⚠️', UNREADABLE: '❓' };
const has = x => x !== '' && x != null;
const failed = inScope.filter(r => r.verdict !== 'OK');
const lines = failed.slice(-20).reverse().map(r => {
  const g = has(r.net_grams) ? r.net_grams : (has(r.scale_grams) ? r.scale_grams : r.actual_grams);
  return (icon[r.verdict] || '•') + ' ' + String(r.ts || '').slice(5, 16) + ' '
    + ([r.dish_id, r.dish_name].filter(Boolean).join(' ') || '—')
    + (has(g) ? ': ' + g + ' г' : '')
    + (has(r.deviation_pct) ? ' (' + (Number(r.deviation_pct) > 0 ? '+' : '') + r.deviation_pct + '%)' : '')
    + (r.chef ? ' — ' + r.chef : '');
});
let parts = ['📊 Статистика ' + (scopeAll ? 'за весь час' : 'за сьогодні (' + today + ')'), '',
  'Всього перевірок: ' + inScope.length,
  '✅ У нормі: ' + cnt('OK'),
  '⛔️ Брак: ' + cnt('BRAK'),
  '🚫 Фото ≠ підпис: ' + cnt('MISMATCH'),
  '🔎 Перевірити: ' + cnt('RECHECK'),
  '⚠️ Невизначено: ' + cnt('LOWCONF'),
  '❓ Нечитабельно: ' + cnt('UNREADABLE')];
if (avg != null) parts.push('Середнє відхилення: ' + avg + '%');
if (failed.length) { parts.push('', 'Останні проблемні (' + Math.min(20, failed.length) + ' з ' + failed.length + '):'); parts = parts.concat(lines); }
else parts.push('', 'Проблемних перевірок немає 👌');
if (!scopeAll) parts.push('', '«/stats all» — за весь час.');
return [{ json: { chat_id: String((msg.chat && msg.chat.id) ?? ''), reply: parts.join(N).slice(0, 3800) } }];
