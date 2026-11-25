/**
 * Officer safety on a hot-list match (owner direction 25/11/2026; docs/BACKEND.md §3).
 *
 *   hit (handset pop-up, officer blocked) ── SAFE & CLEAR ──▶ logged to the plate's history
 *        │                                 └─ CODE 1 ───────▶ Code 1 (red, whole branch)
 *        └─ no acknowledgement by the deadline ─▶ soft Code 1 (amber) to dispatch + the officer's
 *           team supervisor (not on shift: every team supervisor on shift + the compliance lead)
 *              acknowledge = radio response requested ─▶ radio OK: resolved
 *                                                       └─ no response: escalate ─▶ Code 1
 *   Code 1: every officer handset and console in the branch gets the alarm and the location pin;
 *   acknowledged by dispatch, cleared with an outcome (or cancelled as raised in error).
 *
 * The handset pushes the soft Code 1 at its deadline; the watchdog raises it here as well if the
 * handset could not (lost signal, damaged), after a grace period.
 */
import { plateKey, normalisePlate } from '../src/lib/plate';
import { tx, type Db, type Tx } from './db';
import { HttpError, need, num, str, type Ctx, type Router, type StaffRole } from './http';

export interface SafetyConfig {
  timeZone: string;
  defaultBranch: string;
  /** Seconds the officer has to acknowledge the pop-up before the soft Code 1. */
  hotAckSeconds: number;
  /** Extra seconds the server waits for the handset's own soft Code 1 before raising it itself. */
  watchdogGraceSeconds: number;
  /** Auto-escalate a soft Code 1 with no radio response after this many seconds (0 = manual only). */
  radioEscalateSeconds: number;
}

type Q = Pick<Tx, 'query'>;
type Location = { lat: number; lng: number; accuracyM?: number } | null;

export interface Recipients {
  roles: StaffRole[];
  staffIds: string[];
  fallback: boolean;
  branch: string;
  reason: string;
}

/** Council-local calendar day (YYYY-MM-DD) for shift lookups. */
export function councilDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export async function officerOf(q: Q, officerNumber: string): Promise<{ id: string; name: string; team: string | null; branch: string } | null> {
  return (await q.query<{ id: string; name: string; team: string | null; branch: string }>('select id, name, team, branch from staff where officer_number = $1 and active', [officerNumber])).rows[0] ?? null;
}

/**
 * Soft Code 1 recipients: dispatch, plus the officer's own team supervisor when on shift today;
 * otherwise every team supervisor of the branch on shift today and the compliance lead.
 */
export async function softCode1Recipients(q: Q, officerNumber: string, day: string, defaultBranch: string): Promise<Recipients & { officer: Awaited<ReturnType<typeof officerOf>> }> {
  const officer = await officerOf(q, officerNumber);
  const branch = officer?.branch ?? defaultBranch;
  const onShift = (extra: string, params: unknown[]) =>
    q.query<{ id: string }>(`select s.id from staff s join shifts h on h.staff_id = s.id and h.day = $1 where s.active and s.branch = $2 ${extra}`, [day, branch, ...params]);
  if (officer?.team) {
    const own = await onShift("and s.role = 'team_supervisor' and s.team = $3", [officer.team]);
    if (own.rows.length) return { officer, roles: ['dispatch'], staffIds: own.rows.map((r) => r.id), fallback: false, branch, reason: `Team ${officer.team} supervisor on shift` };
  }
  const sups = await onShift("and s.role = 'team_supervisor'", []);
  const leads = await q.query<{ id: string }>("select id from staff where active and branch = $1 and role = 'compliance_lead'", [branch]);
  return {
    officer,
    roles: ['dispatch'],
    staffIds: [...sups.rows, ...leads.rows].map((r) => r.id),
    fallback: true,
    branch,
    reason: officer?.team ? `Team ${officer.team} supervisor not on shift: all team supervisors on shift and the compliance lead` : 'Officer not in the roster: all team supervisors on shift and the compliance lead',
  };
}

async function event(q: Q, alertId: string, actor: string, role: string, action: string, note?: string | null): Promise<void> {
  await q.query('insert into alert_events (alert_id, actor, role, action, note) values ($1,$2,$3,$4,$5)', [alertId, actor, role, action, note ?? null]);
}

const loc = (v: unknown): Location => {
  const l = v as { lat?: unknown; lng?: unknown; accuracyM?: unknown } | null | undefined;
  const lat = num(l?.lat);
  const lng = num(l?.lng);
  return lat === null || lng === null ? null : { lat, lng, accuracyM: num(l?.accuracyM) ?? undefined };
};

/** Record a hit (idempotent). Also used by the sync path for `kind: 'hit'` events. */
export async function upsertHit(q: Q, keyId: string | null, h: Record<string, unknown>, cfg: SafetyConfig): Promise<string> {
  const id = need(str(h.id, 64), 'hit.id');
  const at = need(num(h.at), 'hit.at');
  const plate = normalisePlate(need(str(h.plate, 16), 'hit.plate'));
  const l = loc(h.location);
  const deadline = num(h.ackDeadline) ?? at + cfg.hotAckSeconds * 1000;
  await q.query(
    `insert into hot_hits (id, plate, plate_key, hot_list_entry_id, scan_id, officer_number, device_key_id, lat, lng, accuracy_m, at, ack_deadline, entry)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (id) do nothing`,
    // Never refuse a hit for want of an officer number (a CODE 1 carries it): logged as "unknown".
    [id, plate, plateKey(plate), need(str(h.hotListEntryId, 64), 'hit.hotListEntryId'), str(h.scanId, 64) || null, str(h.officerNumber, 12).trim() || 'unknown', keyId,
      l?.lat ?? null, l?.lng ?? null, l?.accuracyM ?? null, new Date(at), new Date(deadline), JSON.stringify(entryOf(h.entry, h.where))],
  );
  return id;
}

function entryOf(e: unknown, where: unknown): Record<string, unknown> {
  const x = (e ?? {}) as Record<string, unknown>;
  const w = (where ?? {}) as Record<string, unknown>;
  return {
    make: str(x.make, 60), type: str(x.type, 60), colour: str(x.colour, 40), riskLevel: str(x.riskLevel, 20),
    risks: Array.isArray(x.risks) ? x.risks.slice(0, 20).map((r) => str(r, 40)) : [], alertMessage: str(x.alertMessage, 160), ownerDescription: str(x.ownerDescription, 300),
    listName: str(w.listName, 120), listId: str(w.listId, 64), displayId: str(w.displayId, 64),
  };
}

export async function recordResponse(q: Q, hitId: string, r: { response: string; note?: string; at: number; officer?: string }): Promise<void> {
  if (r.response !== 'safe_clear' && r.response !== 'code1') throw new HttpError(422, 'invalid', 'response must be safe_clear or code1.');
  // The answering officer is kept (the pop-up requires a number); a hit reported as "unknown"
  // before the number was entered takes it too, so history and the console name the officer.
  const officer = r.officer?.trim() && r.officer.trim() !== 'unknown' ? r.officer.trim().slice(0, 12) : null;
  await q.query(
    `update hot_hits set response = coalesce(response, $2), responded_at = coalesce(responded_at, $3), note = coalesce($4, note),
       responded_by = coalesce(responded_by, $5),
       officer_number = case when $5::text is not null and officer_number in ('unknown', '') then $5 else officer_number end
     where id = $1`,
    [hitId, r.response, new Date(r.at), r.note?.trim() ? r.note.trim().slice(0, 1000) : null, officer],
  );
  // A late acknowledgement is shown on any open soft Code 1 for this hit (dispatch still confirms by radio).
  const open = (await q.query<{ id: string }>("select id from alerts where hit_id = $1 and kind = 'soft_code1' and status in ('active', 'radio_requested')", [hitId])).rows[0];
  if (open) {
    await event(q, open.id, 'handset', 'officer', r.response === 'safe_clear' ? 'officer_safe_clear' : 'officer_code1', r.note ?? null);
    await q.query("update alerts set updated_at = now(), change_no = nextval('change_seq'), data = data || $2 where id = $1", [open.id, JSON.stringify({ officerResponse: r.response, officerResponseAt: r.at })]);
  }
}

export async function raiseAlert(
  q: Q,
  cfg: SafetyConfig,
  a: { id: string; kind: 'soft_code1' | 'code1'; hitId?: string | null; escalatedFrom?: string | null; cause: string; raisedBy: string; officerNumber: string; keyId?: string | null; at: number; location: Location; now: number },
): Promise<{ id: string; created: boolean }> {
  if (a.hitId) {
    const existing = (await q.query<{ id: string }>('select id from alerts where hit_id = $1 and kind = $2', [a.hitId, a.kind])).rows[0];
    if (existing) return { id: existing.id, created: false };
  }
  const dup = (await q.query<{ id: string }>('select id from alerts where id = $1', [a.id])).rows[0];
  if (dup) return { id: dup.id, created: false };
  const day = councilDay(a.now, cfg.timeZone);
  const r = await softCode1Recipients(q, a.officerNumber, day, cfg.defaultBranch);
  // A Code 1 goes to the whole branch: every console role and every officer handset.
  const recipients: Recipients =
    a.kind === 'code1' ? { roles: ['dispatch', 'team_supervisor', 'compliance_lead'], staffIds: [], fallback: false, branch: r.branch, reason: `Code 1: all staff and officers of branch ${r.branch}` } : { roles: r.roles, staffIds: r.staffIds, fallback: r.fallback, branch: r.branch, reason: r.reason };
  await q.query(
    `insert into alerts (id, kind, hit_id, escalated_from, cause, raised_by, officer_number, officer_name, team, branch, device_key_id, lat, lng, accuracy_m, location_at, raised_at, recipients, status)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'active')`,
    [a.id, a.kind, a.hitId ?? null, a.escalatedFrom ?? null, a.cause, a.raisedBy, a.officerNumber, r.officer?.name ?? null, r.officer?.team ?? null, r.branch, a.keyId ?? null,
      a.location?.lat ?? null, a.location?.lng ?? null, a.location?.accuracyM ?? null, a.location ? new Date(a.at) : null, new Date(a.at), JSON.stringify(recipients)],
  );
  if (a.location) await q.query('insert into alert_locations (alert_id, at, lat, lng, accuracy_m) values ($1,$2,$3,$4,$5)', [a.id, new Date(a.at), a.location.lat, a.location.lng, a.location.accuracyM ?? null]);
  await event(q, a.id, a.raisedBy, a.raisedBy === 'handset' || a.raisedBy === 'officer' ? 'officer' : a.raisedBy === 'server_watchdog' ? 'system' : 'staff', `${a.kind}_raised`, a.cause);
  return { id: a.id, created: true };
}

/** Raise the soft Code 1 for overdue hits the handset did not report, and auto-escalate if configured. */
export async function runWatchdog(db: Db, cfg: SafetyConfig, now: number): Promise<{ softCode1: string[]; escalated: string[] }> {
  const overdue = await db.query<{ id: string; officer_number: string; device_key_id: string | null; lat: number | null; lng: number | null; accuracy_m: number | null }>(
    `select h.id, h.officer_number, h.device_key_id, h.lat, h.lng, h.accuracy_m from hot_hits h
     where h.response is null and h.ack_deadline < $1 and not exists (select 1 from alerts a where a.hit_id = h.id)`,
    [new Date(now - cfg.watchdogGraceSeconds * 1000)],
  );
  const softCode1: string[] = [];
  for (const h of overdue.rows) {
    const out = await tx(db, (q) =>
      raiseAlert(q, cfg, { id: `sc1-${h.id}`, kind: 'soft_code1', hitId: h.id, cause: 'hot_list_timeout', raisedBy: 'server_watchdog', officerNumber: h.officer_number, keyId: h.device_key_id, at: now, location: h.lat === null ? null : { lat: h.lat, lng: h.lng!, accuracyM: h.accuracy_m ?? undefined }, now }),
    );
    if (out.created) softCode1.push(out.id);
  }
  const escalated: string[] = [];
  if (cfg.radioEscalateSeconds > 0) {
    const stale = await db.query<{ id: string }>("select id from alerts where kind = 'soft_code1' and status = 'radio_requested' and acknowledged_at < $1", [new Date(now - cfg.radioEscalateSeconds * 1000)]);
    for (const s of stale.rows) {
      const id = await tx(db, (q) => escalate(q, cfg, s.id, { actor: 'server_watchdog', role: 'system', note: `No radio response within ${cfg.radioEscalateSeconds} s`, now }));
      escalated.push(id);
    }
  }
  return { softCode1, escalated };
}

async function escalate(q: Q, cfg: SafetyConfig, softId: string, by: { actor: string; role: string; note?: string; now: number }): Promise<string> {
  const s = (await q.query<{ status: string; officer_number: string; device_key_id: string | null; hit_id: string | null; lat: number | null; lng: number | null; accuracy_m: number | null }>(
    "select status, officer_number, device_key_id, hit_id, lat, lng, accuracy_m from alerts where id = $1 and kind = 'soft_code1' for update",
    [softId],
  )).rows[0];
  if (!s) throw new HttpError(404, 'not_found', 'No such soft Code 1.');
  if (!['active', 'radio_requested'].includes(s.status)) throw new HttpError(409, 'state', `Soft Code 1 is ${s.status}.`);
  // The hot-list hit stays on the soft Code 1 and is read through escalated_from (ALERT_HIT), so an
  // officer's own CODE 1 for the same hit is never merged into this one (alerts_hit_kind index).
  const code1Id = `c1-${softId}`;
  await raiseAlert(q, cfg, { id: code1Id, kind: 'code1', escalatedFrom: softId, cause: 'no_radio_response', raisedBy: by.actor, officerNumber: s.officer_number, keyId: s.device_key_id, at: by.now, location: s.lat === null ? null : { lat: s.lat, lng: s.lng!, accuracyM: s.accuracy_m ?? undefined }, now: by.now });
  await q.query("update alerts set status = 'escalated', escalated_to = $2, closed_by = $3, closed_at = now(), updated_at = now(), change_no = nextval('change_seq') where id = $1", [softId, code1Id, by.actor]);
  await event(q, softId, by.actor, by.role, 'escalated_to_code1', by.note ?? 'No radio response');
  return code1Id;
}

/** The alert's hot-list hit: its own, or the soft Code 1's it was escalated from. */
const ALERT_HIT = `coalesce(a.hit_id, (select s.hit_id from alerts s where s.id = a.escalated_from))`;

const ALERT_COLS = `a.*, ${ALERT_HIT} as resolved_hit_id, (select json_build_object('lat', l.lat, 'lng', l.lng, 'accuracyM', l.accuracy_m, 'at', (extract(epoch from l.at) * 1000)::bigint) from alert_locations l where l.alert_id = a.id order by l.id desc limit 1) as last_location,
  (select row_to_json(h) from (select plate, entry, response, responded_at, note, at from hot_hits where id = ${ALERT_HIT}) h) as hit`;

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

export function alertJson(a: Record<string, any>) {
  const last = a.last_location as { lat: number; lng: number; accuracyM: number | null; at: string | number } | null;
  return {
    id: a.id, kind: a.kind, status: a.status, cause: a.cause, raisedBy: a.raised_by, officerNumber: a.officer_number, officerName: a.officer_name, team: a.team, branch: a.branch,
    raisedAt: ms(a.raised_at), acknowledgedBy: a.acknowledged_by, acknowledgedAt: ms(a.acknowledged_at), closedBy: a.closed_by, closedAt: ms(a.closed_at), outcome: a.outcome,
    escalatedFrom: a.escalated_from, escalatedTo: a.escalated_to, recipients: a.recipients, hitId: a.resolved_hit_id ?? a.hit_id,
    location: last ? { ...last, at: Number(last.at) } : a.lat === null ? null : { lat: a.lat, lng: a.lng, accuracyM: a.accuracy_m, at: ms(a.location_at) },
    hit: a.hit ? { plate: a.hit.plate, entry: a.hit.entry, response: a.hit.response, note: a.hit.note, at: Date.parse(a.hit.at), respondedAt: a.hit.responded_at ? Date.parse(a.hit.responded_at) : null } : null,
    officerResponse: a.data?.officerResponse ?? null,
  };
}

const OPEN = "a.status in ('active', 'radio_requested', 'acknowledged')";

/** Device and console routes for the safety flow. */
export function registerSafety(
  r: Router,
  db: Db,
  cfg: SafetyConfig,
  h: {
    now: () => number;
    needDevice: (c: Ctx) => string;
    deviceOfficer: (c: Ctx) => Promise<string>;
    staffAuth: (c: Ctx, roles?: readonly StaffRole[]) => Promise<NonNullable<Ctx['staff']>>;
    audit: (c: Ctx, action: string, entity: string, id: string, data?: unknown) => Promise<unknown>;
  },
): void {
  /* ── Device ── */

  r.on('POST', '/api/hot-hits', async (c) => {
    const keyId = h.needDevice(c);
    const b = await c.body<{ hit?: Record<string, unknown> }>();
    const id = await tx(db, (q) => upsertHit(q, keyId, b.hit ?? {}, cfg));
    const row = (await db.query<{ ack_deadline: Date }>('select ack_deadline from hot_hits where id = $1', [id])).rows[0]!;
    return { id, ackDeadline: row.ack_deadline.getTime(), hotAckSeconds: cfg.hotAckSeconds };
  });

  r.on('POST', '/api/hot-hits/:id/response', async (c) => {
    h.needDevice(c);
    const b = await c.body<{ response?: string; note?: string; at?: number; officerNumber?: string; hit?: Record<string, unknown> }>();
    const officer = str(b.officerNumber, 12).trim() || str(b.hit?.officerNumber, 12).trim() || (await h.deviceOfficer(c));
    await tx(db, async (q) => {
      if (b.hit) await upsertHit(q, c.device?.keyId ?? null, b.hit, cfg);
      if (!(await q.query('select 1 from hot_hits where id = $1', [c.params.id])).rowCount) throw new HttpError(404, 'not_found', 'Unknown hit: send the hit first.');
      await recordResponse(q, c.params.id!, { response: str(b.response, 20), note: str(b.note, 1000), at: num(b.at) ?? h.now(), officer });
    });
    return { ok: true };
  });

  /** The handset's own soft Code 1 at the acknowledgement deadline (idempotent per hit). */
  r.on('POST', '/api/alerts/soft-code1', async (c) => {
    const keyId = h.needDevice(c);
    const b = await c.body<{ hit?: Record<string, unknown>; at?: number; location?: unknown }>();
    const now = h.now();
    return tx(db, async (q) => {
      const hitId = await upsertHit(q, keyId, b.hit ?? {}, cfg);
      const hit = (await q.query<{ officer_number: string; response: string | null }>('select officer_number, response from hot_hits where id = $1', [hitId])).rows[0]!;
      if (hit.response) return { id: null, status: 'not_needed', response: hit.response };
      const out = await raiseAlert(q, cfg, { id: `sc1-${hitId}`, kind: 'soft_code1', hitId, cause: 'hot_list_timeout', raisedBy: 'handset', officerNumber: hit.officer_number, keyId, at: num(b.at) ?? now, location: loc(b.location), now });
      return { id: out.id, status: 'raised' };
    });
  });

  /** Officer duress (from the hot-list pop-up, or any Code 1 the handset raises). */
  r.on('POST', '/api/code1', async (c) => {
    const keyId = h.needDevice(c);
    const b = await c.body<{ id?: string; hit?: Record<string, unknown>; cause?: string; at?: number; location?: unknown }>();
    const now = h.now();
    // No officer header (older handset, number typed on the pop-up): the hit's officer, then the device's.
    const hitOfficer = c.req.headers['x-officer-number'] ? '' : str(b.hit?.officerNumber, 12).trim();
    const officer = hitOfficer || (await h.deviceOfficer(c));
    return tx(db, async (q) => {
      const hitId = b.hit ? await upsertHit(q, keyId, b.hit, cfg) : null;
      if (hitId) await recordResponse(q, hitId, { response: 'code1', at: num(b.at) ?? now, officer });
      const out = await raiseAlert(q, cfg, { id: need(str(b.id, 64), 'id'), kind: 'code1', hitId, cause: hitId ? 'hot_list_code1' : str(b.cause, 40) || 'officer_duress', raisedBy: 'officer', officerNumber: officer, keyId, at: num(b.at) ?? now, location: loc(b.location), now });
      return { id: out.id, status: 'raised' };
    });
  });

  r.on('POST', '/api/code1/:id/location', async (c) => {
    h.needDevice(c);
    const l = loc(await c.body());
    if (!l) throw new HttpError(422, 'invalid', 'lat and lng are required.');
    const at = num((await c.body<{ at?: number }>()).at) ?? h.now();
    const a = (await db.query<{ status: string }>("select status from alerts where id = $1 and kind = 'code1'", [c.params.id])).rows[0];
    if (!a) throw new HttpError(404, 'not_found', 'No such Code 1.');
    await db.query('insert into alert_locations (alert_id, at, lat, lng, accuracy_m) values ($1,$2,$3,$4,$5)', [c.params.id, new Date(at), l.lat, l.lng, l.accuracyM ?? null]);
    await db.query("update alerts set updated_at = now(), change_no = nextval('change_seq') where id = $1", [c.params.id]);
    return { status: a.status };
  });

  r.on('POST', '/api/code1/:id/cancel', async (c) => {
    h.needDevice(c);
    const officer = await h.deviceOfficer(c);
    const b = await c.body<{ reason?: string }>();
    return tx(db, async (q) => {
      const a = (await q.query<{ status: string; officer_number: string }>("select status, officer_number from alerts where id = $1 and kind = 'code1' for update", [c.params.id])).rows[0];
      if (!a) throw new HttpError(404, 'not_found', 'No such Code 1.');
      if (a.officer_number !== officer) throw new HttpError(403, 'forbidden', 'Only the officer who raised it can cancel from the handset.');
      if (!['active', 'acknowledged'].includes(a.status)) return { status: a.status };
      await q.query("update alerts set status = 'cancelled', outcome = $2, closed_by = $3, closed_at = now(), updated_at = now(), change_no = nextval('change_seq') where id = $1", [c.params.id, `Raised in error: ${str(b.reason, 300) || 'no reason given'}`, `officer ${officer}`]);
      await event(q, c.params.id!, officer, 'officer', 'code1_cancelled', str(b.reason, 300));
      return { status: 'cancelled' };
    });
  });

  /** What the handset shows: its own open alerts and the branch's Code 1s (alarm until received). */
  r.on('GET', '/api/alerts/live', async (c) => {
    h.needDevice(c);
    const officer = await h.deviceOfficer(c);
    const me = await officerOf(db, officer);
    const branch = me?.branch ?? cfg.defaultBranch;
    const since = new Date(h.now() - 12 * 3600_000);
    // Every open alert, however old or many, is returned; the 12 h window and the limit of 20 apply
    // only to closed history, so recent history can never push an open emergency off the feed.
    const own = await db.query(
      `(select ${ALERT_COLS} from alerts a where a.officer_number = $1 and ${OPEN})
       union all
       (select ${ALERT_COLS} from alerts a where a.officer_number = $1 and not ${OPEN} and a.raised_at > $2 order by a.raised_at desc limit 20)`,
      [officer, since],
    );
    const branchC1 = await db.query(
      `(select ${ALERT_COLS}, exists (select 1 from alert_receipts r where r.alert_id = a.id and r.officer_number = $3) as received
        from alerts a where a.kind = 'code1' and a.branch = $1 and a.officer_number <> $3 and ${OPEN})
       union all
       (select ${ALERT_COLS}, exists (select 1 from alert_receipts r where r.alert_id = a.id and r.officer_number = $3) as received
        from alerts a where a.kind = 'code1' and a.branch = $1 and a.officer_number <> $3 and not ${OPEN} and a.closed_at > $2 order by a.closed_at desc limit 20)`,
      [branch, since, officer],
    );
    const newest = (x: Record<string, any>, y: Record<string, any>) => y.raised_at.getTime() - x.raised_at.getTime();
    own.rows.sort(newest);
    branchC1.rows.sort(newest);
    return { officerNumber: officer, branch, own: own.rows.map(alertJson), branch_code1: branchC1.rows.map((a) => ({ ...alertJson(a), received: a.received })) };
  });

  r.on('POST', '/api/alerts/:id/receipt', async (c) => {
    h.needDevice(c);
    const officer = await h.deviceOfficer(c);
    await db.query('insert into alert_receipts (alert_id, officer_number) values ($1,$2) on conflict do nothing', [c.params.id, officer]);
    await event(db, c.params.id!, officer, 'officer', 'alarm_received');
    return { ok: true };
  });

  /** Full profile for the pop-up's "More information": match history, interactions, known locations. */
  r.on('GET', '/api/hot-profile', async (c) => {
    h.needDevice(c);
    return profile(db, c.url.searchParams.get('plate') ?? '', c.url.searchParams.get('entryId'));
  });

  /* ── Console ── */

  const CONSOLE: readonly StaffRole[] = ['dispatch', 'team_supervisor', 'compliance_lead'];

  r.on('GET', '/api/console/alerts', async (c) => {
    const s = await h.staffAuth(c, CONSOLE);
    const all = c.url.searchParams.get('scope') === 'all';
    const rows = await db.query(`select ${ALERT_COLS} from alerts a ${all ? '' : `where ${OPEN}`} order by (a.kind = 'code1') desc, a.raised_at desc limit 200`);
    return {
      alerts: rows.rows.map((a) => {
        const j = alertJson(a);
        const rec = a.recipients as Recipients;
        const forMe = a.kind === 'code1' ? s.role === 'dispatch' || a.branch === s.branch : rec.roles.includes(s.role) || rec.staffIds.includes(s.id);
        return { ...j, forMe };
      }),
    };
  });

  r.on('GET', '/api/console/alerts/:id', async (c) => {
    await h.staffAuth(c, CONSOLE);
    const a = (await db.query(`select ${ALERT_COLS} from alerts a where a.id = $1`, [c.params.id])).rows[0];
    if (!a) throw new HttpError(404, 'not_found', 'No such alert.');
    const [events, trail, receipts, recips] = await Promise.all([
      db.query('select at, actor, role, action, note from alert_events where alert_id = $1 order by id', [c.params.id]),
      db.query('select at, lat, lng, accuracy_m from alert_locations where alert_id = $1 order by id desc limit 50', [c.params.id]),
      db.query('select officer_number, at from alert_receipts where alert_id = $1 order by at', [c.params.id]),
      db.query<{ id: string; name: string; role: string }>('select id, name, role from staff where id = any($1)', [(a.recipients as Recipients).staffIds]),
    ]);
    const hit = a.resolved_hit_id ? (await db.query<{ plate: string; scan_id: string | null; hot_list_entry_id: string }>('select plate, scan_id, hot_list_entry_id from hot_hits where id = $1', [a.resolved_hit_id])).rows[0] : undefined;
    return {
      alert: alertJson(a),
      recipients: recips.rows,
      events: events.rows.map((e) => ({ ...e, at: ms(e.at) })),
      trail: trail.rows.map((t) => ({ at: ms(t.at), lat: t.lat, lng: t.lng, accuracyM: t.accuracy_m })),
      receipts: receipts.rows.map((x) => ({ officerNumber: x.officer_number, at: ms(x.at) })),
      scanId: hit?.scan_id ?? null,
      profile: hit ? await profile(db, hit.plate, hit.hot_list_entry_id) : null,
    };
  });

  const act = (path: string, roles: readonly StaffRole[], fn: (q: Q, a: { kind: string; status: string; recipients: Recipients }, s: NonNullable<Ctx['staff']>, body: Record<string, unknown>, id: string) => Promise<unknown>) =>
    r.on('POST', `/api/console/alerts/:id/${path}`, async (c) => {
      const s = await h.staffAuth(c, roles);
      const body = await c.body<Record<string, unknown>>();
      const out = await tx(db, async (q) => {
        const a = (await q.query<{ kind: string; status: string; recipients: Recipients }>('select kind, status, recipients from alerts where id = $1 for update', [c.params.id])).rows[0];
        if (!a) throw new HttpError(404, 'not_found', 'No such alert.');
        return fn(q, a, s, body, c.params.id!);
      });
      await h.audit(c, `alert_${path}`, 'alert', c.params.id!, body);
      return out;
    });

  /** Soft Code 1: acknowledging requests the officer's radio response. Code 1: dispatch has it. */
  act('acknowledge', CONSOLE, async (q, a, s, _b, id) => {
    if (a.kind === 'soft_code1') {
      if (s.role !== 'dispatch' && !a.recipients.staffIds.includes(s.id)) throw new HttpError(403, 'forbidden', 'Only dispatch or the designated supervisors acknowledge this soft Code 1.');
      if (a.status !== 'active') throw new HttpError(409, 'state', `Already ${a.status}.`);
      await q.query("update alerts set status = 'radio_requested', acknowledged_by = $2, acknowledged_at = now(), updated_at = now(), change_no = nextval('change_seq') where id = $1", [id, `${s.name} (${s.id})`]);
      await event(q, id, s.id, s.role, 'acknowledged_radio_requested');
      return { status: 'radio_requested' };
    }
    if (a.status !== 'active') throw new HttpError(409, 'state', `Already ${a.status}.`);
    await q.query("update alerts set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), updated_at = now(), change_no = nextval('change_seq') where id = $1", [id, `${s.name} (${s.id})`]);
    await event(q, id, s.id, s.role, 'code1_acknowledged');
    return { status: 'acknowledged' };
  });

  act('radio-ok', CONSOLE, async (q, a, s, b, id) => {
    if (a.kind !== 'soft_code1') throw new HttpError(409, 'state', 'Only a soft Code 1 is resolved by radio.');
    if (s.role !== 'dispatch' && !a.recipients.staffIds.includes(s.id)) throw new HttpError(403, 'forbidden', 'Only dispatch or the designated supervisors resolve this soft Code 1.');
    if (!['active', 'radio_requested'].includes(a.status)) throw new HttpError(409, 'state', `Already ${a.status}.`);
    await q.query("update alerts set status = 'resolved', outcome = $2, closed_by = $3, closed_at = now(), acknowledged_by = coalesce(acknowledged_by, $3), acknowledged_at = coalesce(acknowledged_at, now()), updated_at = now(), change_no = nextval('change_seq') where id = $1", [id, `Radio response received: officer OK${str(b.note, 300) ? ` — ${str(b.note, 300)}` : ''}`, `${s.name} (${s.id})`]);
    await event(q, id, s.id, s.role, 'radio_ok', str(b.note, 300));
    return { status: 'resolved' };
  });

  act('escalate', CONSOLE, async (q, a, s, b, id) => {
    if (a.kind !== 'soft_code1') throw new HttpError(409, 'state', 'Only a soft Code 1 escalates.');
    if (s.role !== 'dispatch' && !a.recipients.staffIds.includes(s.id)) throw new HttpError(403, 'forbidden', 'Only dispatch or the designated supervisors escalate this soft Code 1.');
    const code1 = await escalate(q, cfg, id, { actor: s.id, role: s.role, note: str(b.note, 300) || 'No radio response', now: h.now() });
    return { status: 'escalated', code1 };
  });

  act('clear', CONSOLE, async (q, a, s, b, id) => {
    if (a.kind !== 'code1') throw new HttpError(409, 'state', 'Only a Code 1 is cleared.');
    if (!['active', 'acknowledged'].includes(a.status)) throw new HttpError(409, 'state', `Already ${a.status}.`);
    const outcome = need(str(b.outcome, 500).trim(), 'outcome');
    await q.query("update alerts set status = 'cleared', outcome = $2, closed_by = $3, closed_at = now(), acknowledged_by = coalesce(acknowledged_by, $3), acknowledged_at = coalesce(acknowledged_at, now()), updated_at = now(), change_no = nextval('change_seq') where id = $1", [id, outcome, `${s.name} (${s.id})`]);
    await event(q, id, s.id, s.role, 'code1_cleared', outcome);
    return { status: 'cleared' };
  });

  act('cancel', CONSOLE, async (q, a, s, b, id) => {
    if (a.kind !== 'code1') throw new HttpError(409, 'state', 'Only a Code 1 is cancelled.');
    if (!['active', 'acknowledged'].includes(a.status)) throw new HttpError(409, 'state', `Already ${a.status}.`);
    const reason = need(str(b.reason, 300).trim(), 'reason');
    await q.query("update alerts set status = 'cancelled', outcome = $2, closed_by = $3, closed_at = now(), updated_at = now(), change_no = nextval('change_seq') where id = $1", [id, `Raised in error: ${reason}`, `${s.name} (${s.id})`]);
    await event(q, id, s.id, s.role, 'code1_cancelled', reason);
    return { status: 'cancelled' };
  });

  r.on('GET', '/api/console/hits', async (c) => {
    await h.staffAuth(c, CONSOLE);
    const rows = await db.query('select id, plate, officer_number, at, lat, lng, accuracy_m, response, responded_at, responded_by, note, entry from hot_hits order by at desc limit 200');
    return { hits: rows.rows.map((x) => ({ id: x.id, plate: x.plate, officerNumber: x.officer_number, at: ms(x.at), location: x.lat === null ? null : { lat: x.lat, lng: x.lng, accuracyM: x.accuracy_m }, response: x.response, respondedAt: ms(x.responded_at), respondedBy: x.responded_by, note: x.note, entry: x.entry })) };
  });

  r.on('GET', '/api/console/hot-profile', async (c) => {
    await h.staffAuth(c, CONSOLE);
    return profile(db, c.url.searchParams.get('plate') ?? '', c.url.searchParams.get('entryId'));
  });
}

/** Match history, interactions and known locations for a plate (all officers). */
export async function profile(db: Q, plate: string, entryId: string | null) {
  const key = plateKey(plate);
  if (!key && !entryId) throw new HttpError(422, 'invalid', 'plate or entryId is required.');
  const hits = await db.query<{ id: string; plate: string; officer_number: string; at: Date; lat: number | null; lng: number | null; accuracy_m: number | null; response: string | null; responded_at: Date | null; responded_by: string | null; note: string | null; entry: Record<string, string> }>(
    'select id, plate, officer_number, at, lat, lng, accuracy_m, response, responded_at, responded_by, note, entry from hot_hits where plate_key = $1 or hot_list_entry_id = $2 order by at desc limit 100',
    [key, entryId ?? ''],
  );
  const alerts = await db.query<{ hit_id: string; kind: string; status: string; outcome: string | null }>('select hit_id, kind, status, outcome from alerts where hit_id = any($1)', [hits.rows.map((x) => x.id)]);
  const places = new Map<string, { label: string; lat: number | null; lng: number | null; count: number; lastAt: number }>();
  for (const x of hits.rows) {
    const label = x.entry.listName || (x.lat !== null ? `${x.lat.toFixed(3)}, ${x.lng!.toFixed(3)}` : 'Location unavailable');
    const k = x.entry.listId || label;
    const p = places.get(k) ?? { label: x.entry.displayId ? `${label} (${x.entry.displayId})` : label, lat: x.lat, lng: x.lng, count: 0, lastAt: 0 };
    p.count += 1;
    p.lastAt = Math.max(p.lastAt, x.at.getTime());
    places.set(k, p);
  }
  const latest = hits.rows[0]?.entry ?? {};
  return {
    plate: hits.rows[0]?.plate ?? plate,
    entry: latest,
    history: hits.rows.map((x) => ({
      at: ms(x.at), officerNumber: x.officer_number, location: x.lat === null ? null : { lat: x.lat, lng: x.lng, accuracyM: x.accuracy_m },
      where: x.entry.listName || null, response: x.response, respondedAt: ms(x.responded_at), respondedBy: x.responded_by, note: x.note,
      alerts: alerts.rows.filter((a) => a.hit_id === x.id).map((a) => ({ kind: a.kind, status: a.status, outcome: a.outcome })),
    })),
    interactions: hits.rows.filter((x) => x.note).map((x) => ({ at: ms(x.at), officerNumber: x.responded_by ?? x.officer_number, note: x.note })),
    knownLocations: [...places.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt),
  };
}
