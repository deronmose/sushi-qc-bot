// Code node «Кухар» — who is writing and which kitchen they belong to.
// The sender is identified by the Telegram user ID (message.from.id) against the chat_id column of «Кухарі».
// Input: rows of the «Кухарі» sheet (with the «Точки» rows read just before it), or one {fresh: true} item when
// the cached lists (workflow static data, refreshed every 5 minutes, after «📍 Точка» or by /reload) are valid.
// Output: { found, cook: { chat_id, name, venue_id, venue, venue_ok, venues, role, allowed, can_switch } }.
const sd = $getWorkflowStaticData('global');
const inRows = $input.all().map((i) => i.json);
const readErr = inRows.find((r) => r && r.error);
if (readErr) throw new Error('Кухарі: ' + readErr.error);
const isActive = (v) => v === true || ['TRUE', '1', 'ТАК', 'YES'].includes(String(v ?? '').trim().toUpperCase());

let rows, venues = null;
if (inRows.length === 1 && inRows[0].fresh === true && sd.cooks) ({ rows, venues = null } = sd.cooks);
else {
  rows = inRows.filter((r) => r && r.chat_id !== undefined && r.chat_id !== '');
  let vRows = null;
  try { vRows = $('Точки — для кешу').all().map((i) => i.json); } catch (e) { /* the kitchen list was not read */ }
  if (vRows) {
    const vErr = vRows.find((r) => r && r.error);
    if (vErr) throw new Error('Точки: ' + vErr.error);
    venues = vRows.filter((v) => v && v.venue_id && isActive(v.active))
      .map((v) => ({ id: String(v.venue_id).trim().toUpperCase(), name: String(v.name || v.venue_id).trim() }));
  }
  sd.cooks = { at: Date.now(), rows, venues };
}

const msg = $('Telegram Trigger').first().json.message || {};
const id = String((msg.from && msg.from.id) ?? (msg.chat && msg.chat.id) ?? '');
const r = rows.find((x) => String(x.chat_id).trim() === id && isActive(x.active));
const role = r ? String(r.role || '').trim().toLowerCase() : '';
// optional column allowed_venues («V1;V2») — kitchens this person may also send checks to; the owner may use any
const allowed = r ? String(r.allowed_venues || '').split(/[;, ]+/).map((v) => v.trim().toUpperCase()).filter(Boolean) : [];
const venueId = r ? String(r.venue_id || '').trim().toUpperCase() : '';
const home = venues ? venues.find((v) => v.id === venueId) : null;
const cook = r ? {
  chat_id: id,
  name: String(r.name || ''),
  venue_id: venueId,
  venue: home ? home.name : String(r.venue || r.venue_id || ''),
  // the kitchen in the profile must be an active row of «Точки», otherwise nothing is logged (unknown when the list was not read)
  venue_ok: venues ? !!home : true,
  venues: venues || [],
  role: ['owner', 'manager', 'cook'].includes(role) ? role : 'cook',
  allowed,
  can_switch: role === 'owner' || allowed.length > 1,
} : null;
return [{ json: { found: !!cook, cook } }];
