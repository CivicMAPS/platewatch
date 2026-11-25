// PlateWatch console — CommandMAPS stand-in (development and field testing). docs/BACKEND.md.
// Everything that came from a device (plates, notes, names) is set with textContent, never HTML.

const $app = document.getElementById('app');
const S = { auth: null, tab: 'live', selected: null, data: {}, timer: null, tick: null };
const ROLE_LABEL = { dispatch: 'Dispatch', compliance_coordinator: 'Compliance coordinator', supervisor: 'Supervisor' };
const INF_PILL = { allocated: ['pending', 'Allocated'], issued: ['issued', 'PIN issued'], cancelled: ['inactive', 'Cancelled'], void_requested: ['alert', 'Void requested'], voided: ['inactive', 'Voided'], paid: ['active', 'Paid'] };
const VOID_LABEL = { officer_error: 'Officer error', permit_displayed: 'Permit displayed', incorrect_offence: 'Incorrect offence', incorrect_vehicle_details: 'Incorrect vehicle details', non_conforming_signage: 'Non-conforming signage', other: 'Other' };
const VARIANT_LABEL = { no_payment: 'No valid payment', expired_session: 'Paid session expired (702e)', unknown: 'Unknown (no payment check)', '': '—' };

/* ───────────── DOM ───────────── */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed by the console's CSP (no inline style attributes)
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const pill = (tone, text) => h('span', { class: `pill ${tone}` }, text);
const plate = (p) => h('span', { class: 'plate' }, p || '—');
const pad = (n) => String(n).padStart(2, '0');
const stamp = (v) => { if (v === null || v === undefined) return '—'; const d = new Date(v); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const clock = (v) => { const d = new Date(v); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fmtIN = (n) => (n && n.length === 20 ? `${n.slice(0, 5)} ${n.slice(5, 11)} ${n.slice(11, 14)} ${n.slice(14, 18)} ${n.slice(18)}` : n);
const where = (l) => (l ? h('span', { class: 'mono' }, `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}${l.accuracyM ? ` ±${Math.round(l.accuracyM)} m` : ''}`) : 'no GPS fix');
const mapLink = (l) => (l ? h('a', { href: `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=19/${l.lat}/${l.lng}`, target: '_blank', rel: 'noopener noreferrer' }, 'Map') : null);

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

/* ───────────── API ───────────── */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${S.auth.token}`, 'X-Staff-Role': S.auth.role, 'X-Staff-User': S.auth.user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`);
  return data;
}
async function imageUrl(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${S.auth.token}`, 'X-Staff-Role': S.auth.role, 'X-Staff-User': S.auth.user } });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
function img(path, caption) {
  const fig = h('figure', {}, h('div', { class: 'muted small' }, 'Loading…'), h('figcaption', {}, caption));
  imageUrl(path).then((u) => fig.replaceChildren(u ? h('img', { src: u, alt: caption }) : h('div', { class: 'muted small' }, 'Not uploaded yet'), h('figcaption', {}, caption)));
  return fig;
}

/* ───────────── Login ───────────── */
function loginView(error) {
  const token = h('input', { type: 'password', autocomplete: 'off', required: true });
  const role = h('select', {}, Object.entries(ROLE_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const user = h('input', { autocomplete: 'off', required: true, placeholder: 'e.g. Sgt J. Lee' });
  const form = h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    S.auth = { token: token.value.trim(), role: role.value, user: user.value.trim() };
    try {
      const me = await api('GET', '/api/console/me');
      S.auth.council = me.council;
      sessionStorage.setItem('pw-console', JSON.stringify(S.auth));
      start();
    } catch (err) { S.auth = null; render(loginView(err.message)); }
  } },
    h('h2', {}, 'PlateWatch console'),
    h('p', { class: 'muted small' }, 'CommandMAPS stand-in for development and field testing. Staff identity is self-declared here; production uses CivicMAPS sign-in.'),
    error ? h('div', { class: 'notice alert' }, error) : null,
    h('div', { style: 'display:grid;gap:10px;margin-top:10px' },
      h('label', { class: 'f' }, 'Console token', token),
      h('label', { class: 'f' }, 'Role', role),
      h('label', { class: 'f' }, 'Name or staff number', user),
      h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
  return form;
}

function render(node) { $app.replaceChildren(node); }

/* ───────────── Shell ───────────── */
const TABS = [['live', 'Live'], ['infringements', 'Infringements'], ['sightings', 'Sightings'], ['analytics', '701 / 702'], ['payments', 'Paid sessions (test)'], ['devices', 'Devices'], ['audit', 'Audit']];

async function refresh() {
  try {
    const [summary, alerts] = await Promise.all([api('GET', '/api/console/summary'), api('GET', '/api/console/alerts')]);
    S.data.summary = summary;
    S.data.alerts = alerts.alerts;
    if (S.tab === 'infringements') S.data.inf = (await api('GET', '/api/console/infringements')).infringements;
    if (S.tab === 'sightings') S.data.scans = (await api('GET', '/api/console/scans?limit=200')).scans;
    if (S.tab === 'devices') S.data.devices = (await api('GET', '/api/console/devices')).devices;
    if (S.tab === 'payments') S.data.paid = (await api('GET', '/api/console/paid-sessions')).sessions;
    if (S.tab === 'analytics') S.data.analytics = await api('GET', '/api/console/analytics/offences');
    if (S.tab === 'audit' && S.auth.role === 'supervisor') S.data.audit = (await api('GET', '/api/console/audit')).audit;
    if (S.tab === 'live') S.data.allAlerts = (await api('GET', '/api/console/alerts?status=all')).alerts;
    S.error = null;
  } catch (e) { S.error = e.message; }
  // Do not redraw under someone typing (forms keep their values); banners refresh on the next tick.
  const a = document.activeElement;
  if (a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName) && a.closest('main')) return;
  draw();
}

/** Banners for alerts this recipient has not acknowledged (Code 1 banners, if any, would stack above). */
function banners() {
  const mine = (S.data.alerts || []).filter((a) => a.recipients.includes(S.auth.role) && !a.acks.some((k) => k.recipient === S.auth.role));
  const others = S.auth.role === 'supervisor' ? S.data.alerts || [] : [];
  return h('div', { class: 'banners', 'aria-live': 'assertive' }, [...mine, ...others].map((a) => {
    const canAck = mine.includes(a);
    return h('div', { class: 'hot-banner', role: 'alert', 'data-alert': a.id },
      h('span', { class: 'beacon', 'aria-hidden': 'true' }),
      h('div', {},
        h('div', { class: 'row' }, h('span', { class: 'label' }, 'HOT LIST'), plate(a.plate), a.riskLevel ? pill('alert', `Risk ${a.riskLevel}`) : null),
        h('div', { class: 'meta' }, `Officer ${a.officerNumber} · `, where(a.location), ` · ${stamp(a.raisedAt)}`)),
      h('span', { class: 'timer', 'data-since': a.raisedAt }, elapsed(a.raisedAt)),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => { S.tab = 'live'; S.selected = { kind: 'alert', id: a.id }; draw(); loadDetail(); } }, 'Open'),
        canAck ? h('button', { class: 'btn amber', onclick: () => ack(a.id) }, 'ACKNOWLEDGE') : null));
  }));
}
function elapsed(since) { const s = Math.max(0, Math.floor((Date.now() - since) / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }

async function ack(id) {
  try { await api('POST', `/api/console/alerts/${encodeURIComponent(id)}/ack`); toast('Acknowledged — the banner is closed for your role.'); } catch (e) { toast(e.message); }
  refresh();
}

function draw() {
  const s = S.data.summary || {};
  const counts = { live: s.alerts_active, infringements: s.void_requests, devices: s.devices_pending };
  render(h('div', {},
    h('header', { class: 'topbar' },
      h('h1', {}, 'PlateWatch console'),
      h('span', { class: 'small' }, `Council ${S.auth.council || ''} · CommandMAPS stand-in`),
      h('div', { class: 'who' }, `${ROLE_LABEL[S.auth.role]} · ${S.auth.user}`, h('button', { onclick: () => { sessionStorage.removeItem('pw-console'); location.reload(); } }, 'Sign out'))),
    h('nav', { class: 'tabs', 'aria-label': 'Sections' }, TABS.filter(([k]) => k !== 'audit' || S.auth.role === 'supervisor').map(([k, l]) =>
      h('button', { 'aria-current': S.tab === k ? 'page' : null, onclick: () => { S.tab = k; S.selected = null; draw(); refresh(); } }, l, counts[k] ? h('span', { class: 'count' }, counts[k]) : null))),
    banners(),
    h('main', {}, S.error ? h('div', { class: 'notice alert' }, S.error) : null, VIEWS[S.tab]())));
}

/* ───────────── Views ───────────── */
const detailBox = h('div');
function selectRow(kind, id) { S.selected = { kind, id }; draw(); loadDetail(); }

const VIEWS = {
  live() {
    const rows = S.data.allAlerts || [];
    return h('div', { class: 'grid2' },
      h('section', { class: 'card' }, h('h2', {}, 'Soft Code 1 — hot-list sightings'),
        h('p', { class: 'muted small' }, 'Sent to dispatch and the compliance coordinator only (not all handsets). Each recipient acknowledges; the alert closes when both have. No Code 1 welfare protocol.'),
        rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Raised'), h('th', {}, 'Plate'), h('th', {}, 'Officer'), h('th', {}, 'Status'), h('th', {}, 'Acknowledged'))),
          h('tbody', {}, rows.map((a) => h('tr', { class: `clickable ${S.selected?.id === a.id ? 'selected' : ''}`, onclick: () => selectRow('alert', a.id) },
            h('td', { class: 'mono' }, stamp(a.raisedAt)), h('td', {}, plate(a.plate)), h('td', { class: 'mono' }, a.officerNumber),
            h('td', {}, a.status === 'active' ? pill('alert', 'Active') : pill('inactive', 'Closed')),
            h('td', { class: 'small' }, a.acks.map((k) => `${ROLE_LABEL[k.recipient]} (${k.by}) ${clock(k.at)}`).join(' · ') || '—')))))
          : h('p', { class: 'muted' }, 'No hot-list sightings yet.')),
      h('section', { class: 'card' }, S.selected?.kind === 'alert' ? detailBox : h('p', { class: 'muted' }, 'Select a sighting to see the evidence, map and the plate’s entry log.')));
  },
  infringements() {
    const rows = S.data.inf || [];
    return h('div', { class: 'grid2' },
      h('section', { class: 'card' }, h('h2', {}, 'Infringements'),
        h('p', { class: 'muted small' }, 'Numbers are generated and signed on the officer’s handset; this server only verifies and accepts them. A void with a reissue needs no approval; a void without one needs a supervisor.'),
        rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'I-N'), h('th', {}, 'Plate'), h('th', {}, 'Offence'), h('th', {}, 'Status'), h('th', {}, 'Issued'))),
          h('tbody', {}, rows.map((x) => h('tr', { class: `clickable ${S.selected?.id === x.number ? 'selected' : ''}`, onclick: () => selectRow('inf', x.number) },
            h('td', { class: 'mono small' }, fmtIN(x.number)), h('td', {}, x.plate ? plate(x.plate) : '—'), h('td', { class: 'mono' }, x.offenceCode || '—'),
            h('td', {}, pill(...(INF_PILL[x.status] || ['inactive', x.status]))), h('td', { class: 'mono small' }, stamp(x.issuedAt))))))
          : h('p', { class: 'muted' }, 'No infringements yet.')),
      h('section', { class: 'card' }, S.selected?.kind === 'inf' ? detailBox : h('p', { class: 'muted' }, 'Select an infringement.')));
  },
  sightings() {
    const rows = S.data.scans || [];
    return h('section', { class: 'card' }, h('h2', {}, 'Scans synced from handsets'),
      rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Captured'), h('th', {}, 'Plate'), h('th', {}, 'Outcome'), h('th', {}, 'Officer'), h('th', {}, 'Location'), h('th', {}, 'Payment'), h('th', {}, 'Evidence'))),
        h('tbody', {}, rows.map((x) => h('tr', {}, h('td', { class: 'mono small' }, stamp(x.capturedAt)), h('td', {}, plate(x.plate)), h('td', {}, x.outcome), h('td', { class: 'mono' }, x.officerNumber || '—'),
          h('td', { class: 'small' }, where(x.location), ' ', mapLink(x.location)),
          h('td', { class: 'small' }, x.payment ? `${x.payment.status === 'paid' ? 'Paid' : 'Not found'} · ${x.payment.source}${x.payment.paidTo ? ` to ${clock(x.payment.paidTo)}` : ''}` : '—'),
          h('td', { class: 'small' }, x.hasEvidence ? 'Uploaded' : x.hasThumb ? 'Thumbnail' : '—')))))
        : h('p', { class: 'muted' }, 'Nothing synced yet.'));
  },
  analytics() {
    const a = S.data.analytics;
    if (!a) return h('p', { class: 'muted' }, 'Loading…');
    const total702 = a.byCode.filter((x) => x.offence_code === '702').reduce((n, x) => n + x.n, 0) || 1;
    return h('div', { class: 'grid2' },
      h('section', { class: 'card' }, h('h2', {}, 'Offences issued'),
        h('p', { class: 'muted small' }, 'Internal analytics. Legally and on every notice a payment offence is 702; the split below is derived by PlateWatch from the payment check, never chosen by the officer, and never sent to the customer or Fines Victoria.'),
        h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Code'), h('th', {}, 'Internal'), h('th', {}, 'Count'), h('th', {}, ''))),
          h('tbody', {}, a.byCode.map((x) => h('tr', {}, h('td', { class: 'mono' }, x.offence_code), h('td', {}, x.offence_code === '702' ? VARIANT_LABEL[x.variant] : '—'), h('td', { class: 'mono' }, x.n),
            h('td', { style: 'width:40%' }, x.offence_code === '702' ? h('div', { class: `bar ${x.variant === 'expired_session' ? 'exp' : ''}`, style: `width:${Math.round((x.n / total702) * 100)}%` }) : null))))),
        h('h2', { style: 'margin-top:16px' }, 'Paid session expired — shortfall'),
        h('dl', { class: 'kv' }, h('dt', {}, 'Infringements'), h('dd', { class: 'mono' }, a.shortfall.n), h('dt', {}, 'Average'), h('dd', { class: 'mono' }, `${a.shortfall.avg} min`), h('dt', {}, 'Median'), h('dd', { class: 'mono' }, `${a.shortfall.median} min`), h('dt', {}, 'Longest'), h('dd', { class: 'mono' }, `${a.shortfall.max} min`))),
      h('section', { class: 'card' }, h('h2', {}, '702 by zone and segment'), table(['Zone', 'Segment', 'Internal', 'Count'], a.byZone.map((x) => [x.zone, x.segment, VARIANT_LABEL[x.variant], x.n])),
        h('h2', { style: 'margin-top:16px' }, '702 by hour issued'), table(['Hour', 'Internal', 'Count'], a.byHour.map((x) => [`${pad(x.h)}:00`, VARIANT_LABEL[x.variant], x.n])),
        h('h2', { style: 'margin-top:16px' }, '702 by payment source'), table(['Source', 'Internal', 'Count'], a.bySource.map((x) => [x.source, VARIANT_LABEL[x.variant], x.n]))));
  },
  payments() {
    const plateIn = h('input', { required: true, placeholder: '1UR6YF', autocomplete: 'off' });
    const source = h('select', {}, ['easypark', 'paystay', 'meter', 'ticket', 'other'].map((v) => h('option', { value: v }, v)));
    const ref = h('input', { placeholder: '7514', autocomplete: 'off' });
    const now = new Date();
    const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const from = h('input', { type: 'datetime-local', value: local(now), required: true });
    const to = h('input', { type: 'datetime-local', value: local(new Date(now.getTime() + 3600_000)), required: true });
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/console/paid-sessions', { plate: plateIn.value, source: source.value, sourceRef: ref.value, paidFrom: new Date(from.value).getTime(), paidTo: new Date(to.value).getTime() }); toast('Paid session created.'); refresh(); } catch (err) { toast(err.message); }
    } }, h('h2', {}, 'Create a paid session (test provider)'),
      h('p', { class: 'muted small' }, 'Stands in for EasyPark / PayStay while no payment provider is integrated. The handset’s “Look up paid session” finds these; the officer still confirms and saves the check.'),
      h('div', { style: 'display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(160px,1fr))' }, h('label', { class: 'f' }, 'Plate', plateIn), h('label', { class: 'f' }, 'Source', source), h('label', { class: 'f' }, 'Area / meter', ref), h('label', { class: 'f' }, 'Paid from', from), h('label', { class: 'f' }, 'Paid to', to)),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create')));
    return h('div', { class: 'grid2' }, form, h('section', { class: 'card' }, h('h2', {}, 'Paid sessions'), table(['Plate', 'Source', 'Ref', 'From', 'To', 'By'], (S.data.paid || []).map((p) => [plate(p.plate), p.source, p.sourceRef, stamp(p.paidFrom), stamp(p.paidTo), p.createdBy]))));
  },
  devices() {
    const sup = S.auth.role === 'supervisor';
    return h('section', { class: 'card' }, h('h2', {}, 'Handset signing keys'),
      h('p', { class: 'muted small' }, 'A handset’s infringement numbers are accepted only once its key is approved. Production requires hardware key attestation and two-person approval; this development backend takes one supervisor.'),
      table(['Key', 'Device', 'Officer', 'Status', 'Registered', 'Last seen', ''], (S.data.devices || []).map((d) => [
        h('span', { class: 'mono' }, d.keyId), h('span', { class: 'small' }, d.label), h('span', { class: 'mono' }, d.officerNumber || '—'),
        d.status === 'approved' ? pill('active', 'Approved') : d.status === 'revoked' ? pill('inactive', 'Revoked') : pill('alert', 'Pending'),
        h('span', { class: 'mono small' }, stamp(d.registeredAt)), h('span', { class: 'mono small' }, stamp(d.lastSeenAt)),
        sup ? h('div', { class: 'row' },
          d.status !== 'approved' ? h('button', { class: 'btn primary', onclick: () => decideDevice(d.keyId, true) }, 'Approve') : null,
          d.status !== 'revoked' ? h('button', { class: 'btn', onclick: () => decideDevice(d.keyId, false) }, 'Revoke') : null) : '',
      ])));
  },
  audit() {
    return h('section', { class: 'card' }, h('h2', {}, 'Console audit log'), table(['When', 'Who', 'Role', 'Action', 'Record'], (S.data.audit || []).map((a) => [stamp(a.at), a.actor, ROLE_LABEL[a.role] || a.role, a.action, `${a.entity} ${a.entity_id}`])));
  },
};

function table(heads, rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing yet.');
  return h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))));
}

async function decideDevice(keyId, approve) {
  try { await api('POST', `/api/console/devices/${encodeURIComponent(keyId)}/decision`, { approve }); toast(approve ? 'Device approved.' : 'Device revoked.'); } catch (e) { toast(e.message); }
  refresh();
}

async function loadDetail() {
  const sel = S.selected;
  if (!sel) return;
  detailBox.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try {
    if (sel.kind === 'alert') {
      const { alert: a, log } = await api('GET', `/api/console/alerts/${encodeURIComponent(sel.id)}`);
      const e = a.entry || {};
      detailBox.replaceChildren(
        h('h2', {}, 'Hot-list sighting ', plate(a.plate)),
        h('div', { class: 'row' }, a.status === 'active' ? pill('alert', 'Active') : pill('inactive', 'Closed'), a.riskLevel ? pill('alert', `Risk ${a.riskLevel}`) : null),
        h('dl', { class: 'kv', style: 'margin-top:10px' },
          h('dt', {}, 'Officer'), h('dd', { class: 'mono' }, a.officerNumber),
          h('dt', {}, 'Acknowledged by officer'), h('dd', { class: 'mono' }, stamp(a.raisedAt)),
          h('dt', {}, 'Location'), h('dd', {}, where(a.location), ' ', mapLink(a.location)),
          h('dt', {}, 'Vehicle'), h('dd', {}, [e.make, e.type, e.colour].filter(Boolean).join(' · ') || '—'),
          h('dt', {}, 'Risks'), h('dd', {}, (e.risks || []).join(', ') || '—'),
          h('dt', {}, 'Recipients'), h('dd', {}, a.recipients.map((r) => ROLE_LABEL[r]).join(' · ')),
          h('dt', {}, 'Acknowledged'), h('dd', {}, a.acks.map((k) => `${ROLE_LABEL[k.recipient]} · ${k.by} · ${stamp(k.at)}`).join('; ') || '—')),
        a.scanId ? h('div', { class: 'thumbs', style: 'margin-top:12px' }, img(`/api/console/evidence/${encodeURIComponent(a.scanId)}`, 'Evidence at the sighting')) : null,
        h('h2', { style: 'margin-top:14px' }, 'Entry log'),
        h('ul', { class: 'timeline' }, log.map((x) => h('li', {}, h('strong', {}, x.kind === 'sighting' ? 'Sighting' : x.kind === 'acknowledged' ? 'Acknowledged' : 'Look-alike — not this vehicle'), ` · ${stamp(x.at)} · officer ${x.officerNumber || '—'} · `, where(x.location)))));
    } else {
      const d = await api('GET', `/api/console/infringements/${encodeURIComponent(sel.id)}`);
      const x = d.infringement;
      const sup = S.auth.role === 'supervisor';
      const note = h('textarea', { rows: 2 });
      detailBox.replaceChildren(
        h('h2', { class: 'mono' }, fmtIN(x.number)),
        h('div', { class: 'row' }, pill(...(INF_PILL[x.status] || ['inactive', x.status])), x.plate ? plate(x.plate) : null),
        h('dl', { class: 'kv', style: 'margin-top:10px' },
          h('dt', {}, 'Offence'), h('dd', { class: 'mono' }, x.offenceCode || '—'),
          h('dt', {}, 'Internal (analytics only)'), h('dd', {}, x.offenceCode === '702' ? `${VARIANT_LABEL[x.internalVariant || '']} · ${x.variantSource || ''}${x.shortfallMinutes !== null && x.shortfallMinutes !== undefined ? ` · shortfall ${x.shortfallMinutes} min` : ''}` : '—'),
          h('dt', {}, 'Time from'), h('dd', { class: 'mono' }, stamp(x.timeFrom)),
          h('dt', {}, 'Time to'), h('dd', { class: 'mono' }, stamp(x.timeTo)),
          h('dt', {}, 'Issued'), h('dd', { class: 'mono' }, stamp(x.issuedAt)),
          h('dt', {}, 'Officer'), h('dd', { class: 'mono' }, x.officerNumber),
          h('dt', {}, 'Location'), h('dd', {}, x.location ? `${x.location.street}, ${x.location.fromStreet} – ${x.location.toStreet} (${x.location.side})${x.location.displayId ? ` · ${x.location.displayId}` : ''}` : '—'),
          h('dt', {}, 'Vehicle'), h('dd', {}, x.vehicle ? [x.vehicle.registrationState, x.vehicle.registrationType, x.vehicle.make, x.vehicle.type, x.vehicle.colour].filter(Boolean).join(' · ') : '—'),
          h('dt', {}, 'Notes'), h('dd', {}, x.notes || '—'),
          x.evidenceOverride ? [h('dt', {}, 'Evidence override'), h('dd', {}, x.evidenceOverride.reason)] : null,
          x.reissueOf ? [h('dt', {}, 'Reissue of'), h('dd', { class: 'mono' }, fmtIN(x.reissueOf))] : null,
          x.reissuedBy ? [h('dt', {}, 'Replaced by'), h('dd', { class: 'mono' }, fmtIN(x.reissuedBy))] : null,
          x.voidRequest ? [h('dt', {}, 'Void request'), h('dd', {}, `${VOID_LABEL[x.voidRequest.reason] || x.voidRequest.reason}${x.voidRequest.note ? ` — ${x.voidRequest.note}` : ''}${x.voidRequest.decision ? ` · ${x.voidRequest.decision} by ${x.voidRequest.decidedBy}` : ''}`)] : null),
        d.evidence.length ? h('div', { class: 'thumbs', style: 'margin-top:12px' }, d.evidence.map((e) => img(`/api/console/evidence/${encodeURIComponent(e.scanId)}`, `${e.role === 'first_sighting' ? 'First sighting' : 'This scan'} · SHA-256 ${e.sha256.slice(0, 12)}…`))) : null,
        x.status === 'void_requested' && sup ? h('div', { class: 'card', style: 'margin-top:12px' }, h('h2', {}, 'Void decision'), h('label', { class: 'f' }, 'Note', note),
          h('div', { class: 'row', style: 'margin-top:8px' },
            h('button', { class: 'btn primary', onclick: () => voidDecision(x.number, true, note.value) }, 'Approve void'),
            h('button', { class: 'btn', onclick: () => voidDecision(x.number, false, note.value) }, 'Reject — keep in force'))) : null,
        x.status === 'void_requested' && !sup ? h('div', { class: 'notice', style: 'margin-top:12px' }, 'Awaiting a supervisor’s void decision.') : null,
        x.status === 'issued' ? h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => pay(x.number) }, 'Record payment (simulated)')) : null,
        h('h2', { style: 'margin-top:14px' }, 'Life cycle'),
        h('ul', { class: 'timeline' }, d.events.map((e) => h('li', {}, h('strong', {}, e.action.replace(/_/g, ' ')), ` · ${stamp(e.at)} · ${e.actor} (${e.actor_role})${e.reason ? ` — ${VOID_LABEL[e.reason] || e.reason}` : ''}`))),
        h('h2', { style: 'margin-top:14px' }, 'Signed statements'),
        h('ul', { class: 'timeline small' }, d.statements.map((s) => h('li', {}, h('strong', {}, s.type), ' · ', h('span', { class: 'mono' }, `${s.hash.slice(0, 16)}… ← ${s.prevHash.slice(0, 16)}…`), ` · received ${stamp(s.receivedAt)}`))));
    }
  } catch (e) { detailBox.replaceChildren(h('div', { class: 'notice alert' }, e.message)); }
}

async function voidDecision(number, approve, note) {
  try { await api('POST', `/api/console/infringements/${encodeURIComponent(number)}/void-decision`, { approve, note }); toast(approve ? 'Void approved.' : 'Void rejected — infringement stays in force.'); } catch (e) { toast(e.message); }
  await refresh();
  loadDetail();
}
async function pay(number) {
  try { await api('POST', `/api/console/infringements/${encodeURIComponent(number)}/payment`); toast('Payment recorded.'); } catch (e) { toast(e.message); }
  await refresh();
  loadDetail();
}

/* ───────────── Start ───────────── */
function start() {
  draw();
  refresh();
  clearInterval(S.timer);
  clearInterval(S.tick);
  S.timer = setInterval(refresh, 4000);
  S.tick = setInterval(() => document.querySelectorAll('.timer[data-since]').forEach((t) => (t.textContent = elapsed(Number(t.dataset.since)))), 1000);
}

try { S.auth = JSON.parse(sessionStorage.getItem('pw-console') || 'null'); } catch { S.auth = null; }
if (S.auth) start(); else render(loginView());
