// Code node «Зведення» — /stats. Input: rows of the «Журнал» sheet. report-lib (RL) is inlined above by the build.
//   cook / manager → own kitchen; owner → the whole network, or one kitchen with «/stats V2».
const readErr = $input.all().find((i) => i.json && i.json.error);
if (readErr) throw new Error('Журнал: ' + readErr.json.error);

const msg = $('Telegram Trigger').first().json.message || {};
const cook = $('Кухар').first().json.cook || {};
const text = String(msg.text || '');
const rows = $input.all().map((i) => i.json);
const p = RL.periodFrom(text);
const wantVenue = RL.venueFrom(text);
const hint = '«/stats all» — за весь час · «/stats 7» — за тиждень';
let reply;
if (cook.role === 'owner') {
  if (wantVenue) {
    const vr = RL.filterRows(rows, { venue: wantVenue, from: p.from });
    const name = (rows.find((r) => String(r.venue_id).trim().toUpperCase() === wantVenue) || {}).venue || '';
    reply = RL.venueReport(vr, (wantVenue + ' ' + name).trim(), p.label) + '\n\n' + hint;
  } else {
    reply = RL.networkReport(RL.filterRows(rows, { from: p.from }), p.label) + '\n\n«/stats V2» — одна точка · ' + hint;
  }
} else {
  const vr = RL.filterRows(rows, { venue: cook.venue_id, from: p.from });
  reply = RL.venueReport(vr, ((cook.venue_id || '') + ' ' + (cook.venue || '')).trim(), p.label)
    + (wantVenue && wantVenue !== cook.venue_id ? '\n\nℹ️ Статистика інших точок доступна лише власнику мережі.' : '')
    + '\n\n' + hint;
}
return [{ json: { chat_id: String((msg.chat && msg.chat.id) ?? ''), reply: reply.slice(0, 3900) } }];
