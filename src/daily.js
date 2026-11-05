// Code node «Щоденний звіт» — runs on the schedule (22:00 Kyiv). Input: rows of the «Кухарі» sheet;
// the journal comes from «Журнал — для звіту». Output: one message per recipient —
// owners get the network report, managers get their own kitchen. report-lib (RL) is inlined above by the build.
const journal = $('Журнал — для звіту').all().map((i) => i.json);
if (journal.some((r) => r && r.error)) throw new Error('Журнал недоступний');
const people = $input.all().map((i) => i.json).filter((r) => r && r.chat_id);
const isActive = (v) => v === true || ['TRUE', '1', 'ТАК', 'YES'].includes(String(v ?? '').trim().toUpperCase());
const t = RL.today();
const day = RL.filterRows(journal, { from: t });
const out = [];
for (const p of people) {
  if (!isActive(p.active)) continue;
  const role = String(p.role || '').trim().toLowerCase();
  const venueId = String(p.venue_id || '').trim().toUpperCase();
  if (role === 'owner') out.push({ json: { chat_id: String(p.chat_id), reply: ('🗓 Щоденний звіт\n\n' + RL.networkReport(day, 'за сьогодні (' + t + ')')).slice(0, 3900) } });
  else if (role === 'manager' && venueId) {
    const vr = RL.filterRows(journal, { venue: venueId, from: t });
    out.push({ json: { chat_id: String(p.chat_id), reply: ('🗓 Щоденний звіт\n\n' + RL.venueReport(vr, (venueId + ' ' + (p.venue || '')).trim(), 'за сьогодні (' + t + ')')).slice(0, 3900) } });
  }
}
return out;
