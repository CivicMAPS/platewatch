// PlateWatch console — CommandMAPS stand-in (development and field testing). docs/BACKEND.md.
// Everything that came from a device (plates, notes, names) is set with textContent, never HTML.

const $app = document.getElementById('app');
const S = { auth: null, tab: 'live', selected: null, data: {}, timer: null, tick: null };
const ROLE_LABEL = { officer: 'Officer', dispatch: 'Dispatch', team_supervisor: 'Team supervisor', compliance_lead: 'Compliance lead' };
const isManager = () => S.auth && (S.auth.role === 'team_supervisor' || S.auth.role === 'compliance_lead');
const ALERT_STATUS = { active: ['alert', 'Active'], radio_requested: ['alert', 'Radio response requested'], resolved: ['active', 'Resolved — officer OK'], escalated: ['inactive', 'Escalated to Code 1'], acknowledged: ['alert', 'Acknowledged'], cleared: ['active', 'Cleared'], cancelled: ['inactive', 'Cancelled'] };
const OPEN = new Set(['active', 'radio_requested', 'acknowledged']);
const INF_PILL = { allocated: ['pending', 'Allocated'], issued: ['issued', 'PIN issued'], cancelled: ['inactive', 'Cancelled'], void_requested: ['alert', 'Void requested'], voided: ['inactive', 'Voided'], paid: ['active', 'Paid'], rejected: ['alert', 'Rejected'] };
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
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

/* ───────────── API ───────────── */
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${S.auth.token}`, ...(S.auth.staffId ? { 'X-Staff-Id': S.auth.staffId } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`);
  return data;
}
async function imageUrl(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${S.auth.token}`, 'X-Staff-Id': S.auth.staffId } });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}
function img(path, caption) {
  const fig = h('figure', {}, h('div', { class: 'muted small' }, 'Loading…'), h('figcaption', {}, caption));
  imageUrl(path).then((u) => fig.replaceChildren(u ? h('img', { src: u, alt: caption }) : h('div', { class: 'muted small' }, 'Not uploaded yet'), h('figcaption', {}, caption)));
  return fig;
}

/* ───────────── Login ───────────── */
/** Step 1: console token. Step 2: who you are, from the roster (or bootstrap the first manager). */
function loginView(error) {
  const token = h('input', { type: 'password', autocomplete: 'off', required: true });
  return h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    S.auth = { token: token.value.trim() };
    try {
      const dir = await api('GET', '/api/console/directory');
      render(dir.bootstrap ? bootstrapView(dir) : pickView(dir));
    } catch (err) { S.auth = null; render(loginView(err.message)); }
  } },
    h('h2', {}, 'PlateWatch console'),
    h('p', { class: 'muted small' }, 'CommandMAPS stand-in for development and field testing. Production sign-in is CivicMAPS identity.'),
    error ? h('div', { class: 'notice alert' }, error) : null,
    h('div', { class: 'stack' }, h('label', { class: 'f' }, 'Console token', token), h('button', { class: 'btn primary', type: 'submit' }, 'Continue')));
}

function pickView(dir, error) {
  const who = h('select', { required: true }, dir.staff.map((x) => h('option', { value: x.id }, `${x.name} · ${ROLE_LABEL[x.role]}${x.team ? ` · team ${x.team}` : ''} (${x.id})`)));
  return h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    S.auth.staffId = who.value;
    try {
      const me = await api('GET', '/api/console/me');
      Object.assign(S.auth, { role: me.role, name: me.name, team: me.team, branch: me.branch, council: me.council, radioEscalateSeconds: me.radioEscalateSeconds });
      sessionStorage.setItem('pw-console', JSON.stringify(S.auth));
      start();
    } catch (err) { render(pickView(dir, err.message)); }
  } },
    h('h2', {}, 'Who are you?'),
    error ? h('div', { class: 'notice alert' }, error) : null,
    h('div', { class: 'stack' }, h('label', { class: 'f' }, 'Staff member', who), h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
}

function bootstrapView(dir, error) {
  const id = h('input', { required: true, placeholder: 'Staff number' });
  const name = h('input', { required: true, placeholder: 'Name' });
  const role = h('select', {}, h('option', { value: 'team_supervisor' }, 'Team supervisor'), h('option', { value: 'compliance_lead' }, 'Compliance lead'));
  const team = h('input', { placeholder: 'Team (supervisors)' });
  const branch = h('input', { value: 'parking' });
  return h('form', { class: 'card login', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/console/staff', { id: id.value, name: name.value, role: role.value, team: team.value, branch: branch.value });
      render(pickView(await api('GET', '/api/console/directory')));
    } catch (err) { render(bootstrapView(dir, err.message)); }
  } },
    h('h2', {}, 'Set up the roster'),
    h('p', { class: 'muted small' }, 'The roster is empty. Add the first manager (team supervisor or compliance lead); they then add everyone else under Roster.'),
    error ? h('div', { class: 'notice alert' }, error) : null,
    h('div', { class: 'stack' }, h('label', { class: 'f' }, 'Staff number', id), h('label', { class: 'f' }, 'Name', name), h('label', { class: 'f' }, 'Role', role), h('label', { class: 'f' }, 'Team', team), h('label', { class: 'f' }, 'Branch', branch),
      h('button', { class: 'btn primary', type: 'submit' }, 'Create')));
}

function render(node) { $app.replaceChildren(node); }

/* ───────────── Shell ───────────── */
const TABS = [['live', 'Live'], ['infringements', 'Infringements'], ['sightings', 'Sightings'], ['analytics', '701 / 702'], ['payments', 'Paid sessions (test)'], ['roster', 'Roster'], ['devices', 'Devices'], ['audit', 'Audit']];

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
    if (S.tab === 'audit' && isManager()) S.data.audit = (await api('GET', '/api/console/audit')).audit;
    if (S.tab === 'roster') S.data.roster = await api('GET', '/api/console/staff');
    if (S.tab === 'live') {
      S.data.allAlerts = (await api('GET', '/api/console/alerts?scope=all')).alerts;
      S.data.hits = (await api('GET', '/api/console/hits')).hits;
    }
    S.error = null;
  } catch (e) { S.error = e.message; }
  siren();
  // Under someone typing, redraw only the safety banners (forms keep their values): a focused field
  // left unattended must never hide a soft Code 1 or a Code 1.
  const a = document.activeElement;
  if (a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName) && a.closest('main')) {
    const current = document.querySelector('.banners');
    if (current) current.replaceWith(banners());
    else draw();
    return;
  }
  draw();
}

/**
 * Banners (S3 3b shape): Code 1 red, always above; soft Code 1 amber, only for its recipients
 * (dispatch and the designated supervisors / compliance lead). Each stays until its life cycle closes.
 */
function banners() {
  const open = (S.data.alerts || []).filter((a) => OPEN.has(a.status) && a.forMe);
  open.sort((x, y) => (x.kind === y.kind ? y.raisedAt - x.raisedAt : x.kind === 'code1' ? -1 : 1));
  return h('div', { class: 'banners', 'aria-live': 'assertive' }, open.map((a) => {
    const code1 = a.kind === 'code1';
    const actions = [];
    if (!code1 && a.status === 'active') actions.push(h('button', { class: 'btn ack', onclick: () => act(a.id, 'acknowledge') }, 'ACKNOWLEDGE — REQUEST RADIO'));
    if (!code1 && a.status === 'radio_requested') {
      actions.push(h('button', { class: 'btn ok', onclick: () => act(a.id, 'radio-ok', { note: prompt('Radio response received. Note (optional):') ?? '' }) }, 'RADIO OK — OFFICER SAFE'));
      actions.push(h('button', { class: 'btn danger', onclick: () => confirm('No radio response: escalate to a Code 1 for the whole branch?') && act(a.id, 'escalate', { note: 'No radio response' }) }, 'NO RESPONSE — CODE 1'));
    }
    if (code1 && a.status === 'active') actions.push(h('button', { class: 'btn ack', onclick: () => act(a.id, 'acknowledge') }, 'ACKNOWLEDGE'));
    if (code1) actions.push(h('button', { class: 'btn ack', onclick: () => { const o = prompt('Clear this Code 1. Outcome (required):'); if (o) act(a.id, 'clear', { outcome: o }); } }, 'CLEAR'));
    const since = a.status === 'radio_requested' ? a.acknowledgedAt : a.raisedAt;
    return h('div', { class: `hot-banner ${code1 ? 'code1' : ''}`, role: 'alert', 'data-alert': a.id, 'data-kind': a.kind, 'data-status': a.status },
      h('span', { class: 'beacon', 'aria-hidden': 'true' }),
      h('div', {},
        h('div', { class: 'row' }, h('span', { class: 'label' }, code1 ? 'CODE 1' : 'SOFT CODE 1 · HOT LIST'), a.hit ? plate(a.hit.plate) : null, a.hit?.entry?.riskLevel ? pill('alert', `Risk ${a.hit.entry.riskLevel}`) : null,
          a.status === 'radio_requested' ? pill('alert', `Radio requested by ${a.acknowledgedBy}`) : a.acknowledgedBy ? pill('active', `Ack ${a.acknowledgedBy}`) : null,
          a.officerResponse ? pill('active', `Officer answered ${a.officerResponse === 'safe_clear' ? 'SAFE & CLEAR' : 'CODE 1'}`) : null),
        h('div', { class: 'meta' }, `${a.officerName ? `${a.officerName} · ` : 'Officer '}${a.officerNumber}${a.team ? ` · team ${a.team}` : ''} · `, where(a.location), ' ', mapLink(a.location), ` · ${stamp(a.raisedAt)}`)),
      h('span', { class: 'timer', 'data-since': since }, elapsed(since)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { S.tab = 'live'; S.selected = { kind: 'alert', id: a.id }; draw(); loadDetail(); } }, 'Open'), actions));
  }));
}
function elapsed(since) { const s = Math.max(0, Math.floor((Date.now() - since) / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }

async function act(id, action, body) {
  try { const r = await api('POST', `/api/console/alerts/${encodeURIComponent(id)}/${action}`, body || {}); toast(`Done: ${r.status.replace(/_/g, ' ')}`); } catch (e) { toast(e.message); }
  await refresh();
  if (S.selected?.kind === 'alert') loadDetail();
}

/**
 * Audible alarm until acknowledged (needs one click on the page first): a Code 1 siren, or for a
 * soft Code 1 waiting for this console a softer repeating chime.
 */
let audioCtx = null;
let sirenTimer = null;
let sirenMode = null;
function siren() {
  const mine = (S.data.alerts || []).filter((a) => a.status === 'active' && a.forMe);
  const mode = mine.some((a) => a.kind === 'code1') ? 'code1' : mine.some((a) => a.kind === 'soft_code1') ? 'soft' : null;
  if (mode === sirenMode) return;
  if (sirenTimer) { clearInterval(sirenTimer); sirenTimer = null; }
  sirenMode = mode;
  if (!mode) return;
  const tones = mode === 'code1' ? { type: 'sawtooth', freqs: [980, 740, 980], gain: 0.15, every: 2000 } : { type: 'sine', freqs: [660, 880], gain: 0.1, every: 4000 };
  const beep = () => {
    try {
      audioCtx ??= new AudioContext();
      tones.freqs.forEach((f, i) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain();
        o.type = tones.type; o.frequency.value = f; g.gain.value = tones.gain;
        o.connect(g).connect(audioCtx.destination); o.start(audioCtx.currentTime + i * 0.3); o.stop(audioCtx.currentTime + i * 0.3 + 0.25);
      });
    } catch { /* no audio */ }
  };
  beep();
  sirenTimer = setInterval(beep, tones.every);
}

function draw() {
  const s = S.data.summary || {};
  const counts = { live: s.alerts_active, infringements: s.void_requests, devices: s.devices_pending };
  render(h('div', {},
    h('header', { class: 'topbar' },
      h('h1', {}, 'PlateWatch console'),
      h('span', { class: 'small' }, `Council ${S.auth.council || ''} · CommandMAPS stand-in`),
      h('div', { class: 'who' }, `${ROLE_LABEL[S.auth.role]} · ${S.auth.name}${S.auth.team ? ` · team ${S.auth.team}` : ''}`, h('button', { onclick: () => { sessionStorage.removeItem('pw-console'); location.reload(); } }, 'Sign out'))),
    h('nav', { class: 'tabs', 'aria-label': 'Sections' }, TABS.filter(([k]) => k !== 'audit' || isManager()).map(([k, l]) =>
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
    const hits = S.data.hits || [];
    return h('div', { class: 'grid2' },
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('h2', {}, 'Officer-safety alerts'),
          h('p', { class: 'muted small' }, 'Soft Code 1: the officer did not answer the hot-list pop-up in time. It goes to dispatch and the officer’s team supervisor (not on shift: every team supervisor on shift and the compliance lead). Acknowledge to request a radio response, then mark the officer safe or escalate to Code 1. Code 1: the whole branch, with the officer’s location.'),
          rows.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Raised'), h('th', {}, 'Kind'), h('th', {}, 'Officer'), h('th', {}, 'Plate'), h('th', {}, 'Status'))),
            h('tbody', {}, rows.map((a) => h('tr', { class: `clickable ${S.selected?.id === a.id ? 'selected' : ''}`, onclick: () => selectRow('alert', a.id) },
              h('td', { class: 'mono small' }, stamp(a.raisedAt)), h('td', {}, a.kind === 'code1' ? h('span', { class: 'pill code1' }, 'Code 1') : pill('alert', 'Soft Code 1')),
              h('td', { class: 'mono' }, a.officerNumber), h('td', {}, a.hit ? plate(a.hit.plate) : '—'), h('td', {}, pill(...(ALERT_STATUS[a.status] || ['inactive', a.status])))))))
            : h('p', { class: 'muted' }, 'No alerts.')),
        h('section', { class: 'card' }, h('h2', {}, 'Hot-list hits'),
          hits.length ? table(['When', 'Plate', 'Officer', 'Answer', 'Note', 'Where'], hits.map((x) => [stamp(x.at), plate(x.plate), h('span', { class: 'mono' }, x.officerNumber),
            [x.response === 'code1' ? h('span', { class: 'pill code1' }, 'Code 1') : x.response === 'safe_clear' ? pill('active', 'SAFE & CLEAR') : pill('alert', 'No answer yet'), x.respondedBy && x.respondedBy !== x.officerNumber ? h('span', { class: 'small' }, ` by ${x.respondedBy}`) : null], x.note || '—', h('span', { class: 'small' }, x.entry?.listName || '', ' ', mapLink(x.location))]))
            : h('p', { class: 'muted' }, 'No hits yet.'))),
      h('section', { class: 'card' }, S.selected?.kind === 'alert' ? detailBox : h('p', { class: 'muted' }, 'Select an alert to see the officer’s location, the vehicle profile and the life cycle.')));
  },
  roster() {
    const r = S.data.roster;
    if (!r) return h('p', { class: 'muted' }, 'Loading…');
    const mgr = isManager();
    const f = { id: h('input', { required: true, placeholder: 'Staff number' }), name: h('input', { required: true, placeholder: 'Name' }), role: h('select', {}, Object.entries(ROLE_LABEL).map(([v, l]) => h('option', { value: v }, l))),
      officerNumber: h('input', { placeholder: 'Officers: e.g. 4471', inputmode: 'numeric' }), team: h('input', { placeholder: 'e.g. A' }), branch: h('input', { value: S.auth.branch || 'parking' }) };
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/console/staff', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]))); toast('Saved.'); refresh(); } catch (err) { toast(err.message); }
    } }, h('h2', {}, 'Add or update staff'), h('p', { class: 'muted small' }, 'Same staff number updates the record. Officers need their handset officer number; a team links officers to their team supervisor.'),
      h('div', { class: 'formgrid' }, Object.entries({ id: 'Staff number', name: 'Name', role: 'Role', officerNumber: 'Officer number', team: 'Team', branch: 'Branch' }).map(([k, l]) => h('label', { class: 'f' }, l, f[k]))),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    return h('div', { class: 'stack' }, mgr ? form : h('div', { class: 'notice' }, 'Team supervisors and the compliance lead manage the roster.'),
      h('section', { class: 'card' }, h('h2', {}, `Roster · on shift ${r.day}`),
        table(['Staff', 'Name', 'Role', 'Officer no.', 'Team', 'Branch', 'On shift today'], r.staff.map((x) => [h('span', { class: 'mono' }, x.id), x.name, ROLE_LABEL[x.role], h('span', { class: 'mono' }, x.officerNumber || '—'), x.team || '—', x.branch,
          mgr ? h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: x.onShift, 'data-shift': x.id, onchange: async (e) => { try { await api('POST', `/api/console/staff/${encodeURIComponent(x.id)}/shift`, { day: r.day, on: e.target.checked }); } catch (err) { toast(err.message); } refresh(); } }), x.onShift ? 'On shift' : 'Off')
            : x.onShift ? pill('active', 'On shift') : pill('inactive', 'Off')]))));
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
    const sup = isManager();
    return h('section', { class: 'card' }, h('h2', {}, 'Handset signing keys'),
      h('p', { class: 'muted small' }, 'A handset’s infringement numbers are accepted only once its key is approved. Production requires hardware key attestation and two-person approval; this development backend takes one team supervisor or the compliance lead.'),
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
      const d = await api('GET', `/api/console/alerts/${encodeURIComponent(sel.id)}`);
      const a = d.alert;
      const e = a.hit?.entry || d.profile?.entry || {};
      const p = d.profile;
      detailBox.replaceChildren(
        h('h2', {}, a.kind === 'code1' ? 'Code 1' : 'Soft Code 1', ' ', a.hit ? plate(a.hit.plate) : ''),
        h('div', { class: 'row' }, pill(...(ALERT_STATUS[a.status] || ['inactive', a.status])), e.riskLevel ? pill('alert', `Risk ${e.riskLevel}`) : null),
        e.alertMessage ? h('div', { class: 'notice alert', style: 'margin-top:10px;font-weight:700' }, e.alertMessage) : null,
        h('dl', { class: 'kv', style: 'margin-top:10px' },
          h('dt', {}, 'Officer'), h('dd', {}, `${a.officerName || ''} `, h('span', { class: 'mono' }, a.officerNumber), a.team ? ` · team ${a.team}` : '', ` · branch ${a.branch}`),
          h('dt', {}, 'Raised'), h('dd', {}, h('span', { class: 'mono' }, stamp(a.raisedAt)), ` · ${a.cause.replace(/_/g, ' ')} · by ${a.raisedBy}`),
          h('dt', {}, 'Location'), h('dd', {}, where(a.location), ' ', mapLink(a.location), a.location?.at ? ` · ${clock(a.location.at)}` : ''),
          h('dt', {}, 'Recipients'), h('dd', {}, a.kind === 'code1' ? `Whole branch ${a.branch}` : ['Dispatch', ...d.recipients.map((r) => `${r.name} (${ROLE_LABEL[r.role]})`)].join(' · '), a.recipients?.fallback ? ' — own supervisor not on shift' : ''),
          h('dt', {}, 'Vehicle'), h('dd', {}, [e.make, e.type, e.colour].filter(Boolean).join(' · ') || '—'),
          h('dt', {}, 'Registered owner'), h('dd', {}, e.ownerDescription || '—'),
          a.acknowledgedBy ? [h('dt', {}, 'Acknowledged'), h('dd', {}, `${a.acknowledgedBy} · ${stamp(a.acknowledgedAt)}`)] : null,
          a.outcome ? [h('dt', {}, 'Outcome'), h('dd', {}, a.outcome)] : null,
          a.escalatedTo ? [h('dt', {}, 'Escalated to'), h('dd', { class: 'mono' }, a.escalatedTo)] : null,
          d.receipts.length ? [h('dt', {}, 'Alarm received'), h('dd', {}, d.receipts.map((r) => `${r.officerNumber} ${clock(r.at)}`).join(' · '))] : null),
        d.scanId ? h('div', { class: 'thumbs', style: 'margin-top:12px' }, img(`/api/console/evidence/${encodeURIComponent(d.scanId)}`, 'Evidence at the hit')) : null,
        d.trail.length > 1 ? [h('h2', { style: 'margin-top:14px' }, 'Location trail'), h('ul', { class: 'timeline small' }, d.trail.slice(0, 12).map((t) => h('li', {}, h('span', { class: 'mono' }, clock(t.at)), ' · ', where(t), ' ', mapLink(t))))] : null,
        h('h2', { style: 'margin-top:14px' }, 'Life cycle'),
        h('ul', { class: 'timeline' }, d.events.map((x) => h('li', {}, h('strong', {}, x.action.replace(/_/g, ' ')), ` · ${stamp(x.at)} · ${x.actor} (${x.role})${x.note ? ` — ${x.note}` : ''}`))),
        p ? [
          h('h2', { style: 'margin-top:14px' }, `Hot-list match history (${p.history.length})`),
          h('ul', { class: 'timeline small' }, p.history.slice(0, 15).map((x) => h('li', {}, h('span', { class: 'mono' }, stamp(x.at)), ` · officer ${x.officerNumber}${x.where ? ` · ${x.where}` : ''} · ${x.response === 'code1' ? 'CODE 1' : x.response === 'safe_clear' ? 'SAFE & CLEAR' : 'no answer'}${x.respondedBy && x.respondedBy !== x.officerNumber ? ` by ${x.respondedBy}` : ''}${x.note ? ` — ${x.note}` : ''}`))),
          h('h2', { style: 'margin-top:14px' }, 'Known locations'),
          h('ul', { class: 'timeline small' }, p.knownLocations.map((x) => h('li', {}, `${x.label} · ${x.count}× · last ${stamp(x.lastAt)}`))),
        ] : null);
    } else {
      const d = await api('GET', `/api/console/infringements/${encodeURIComponent(sel.id)}`);
      const x = d.infringement;
      const sup = isManager();
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
          x.rejection ? [h('dt', {}, 'Rejected'), h('dd', {}, `${x.rejection.message} (${x.rejection.code}) — the signed statements are kept in the device's chain; the number is not valid.`)] : null,
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
if (S.auth?.staffId) start(); else render(loginView());
