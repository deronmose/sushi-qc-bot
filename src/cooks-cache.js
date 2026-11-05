// Code node «Кеш кухарів?» — can the cached cook and kitchen lists be used? Yes while they are younger than
// 5 minutes AND the sender is an active person in them. A sender missing from the cache (someone just added to
// «Кухарі» or switched back on) re-reads the sheet at once instead of waiting for the cache to expire.
const sd = $getWorkflowStaticData('global');
const msg = $('Telegram Trigger').first().json.message || {};
const id = String((msg.from && msg.from.id) ?? (msg.chat && msg.chat.id) ?? '');
const isActive = (v) => v === true || ['TRUE', '1', 'ТАК', 'YES'].includes(String(v ?? '').trim().toUpperCase());
const c = sd.cooks;
const young = !!(c && c.rows && Date.now() - c.at < 5 * 60 * 1000);
const known = young && c.rows.some((r) => String(r.chat_id).trim() === id && isActive(r.active));
return [{ json: { fresh: known } }];
