/**
 * PlateWatch backend: device API (sync, soft Code 1 alerts, I-N statements, evidence, updates,
 * payment lookup) and the CommandMAPS console API. See docs/BACKEND.md.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { keyIdOf } from '../src/lib/inNumber';
import { normalisePlate, plateKey } from '../src/lib/plate';
import { tx, type Db } from './db';
import { bearer, HttpError, need, num, readBody, Router, secretMatches, send, STAFF_ROLES, str, type Ctx, type StaffRole } from './http';
import { acceptBundle, recordInfringementEvent, VOID_REASONS, type BundleIn } from './verify';

export interface Config {
  council: string;
  deviceToken: string;
  consoleToken: string;
  /** Allowed CORS origins, or ['*']. */
  corsOrigins: string[];
  /** Built PlateWatch app (dist/) to serve at /, if present. */
  appDir?: string;
  /** Console static files. */
  consoleDir: string;
  /** CivicMAPS design tokens and fonts (src/styles/civicmaps), served at /console/civicmaps/. */
  tokensDir?: string;
  version: string;
  now?: () => number;
}

const MB = 1024 * 1024;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);

const ALERT_RECIPIENTS = ['dispatch', 'compliance_coordinator'] as const;
type Recipient = (typeof ALERT_RECIPIENTS)[number];

export function createApp(db: Db, cfg: Config) {
  const now = () => (cfg.now ? cfg.now() : Date.now());
  const r = new Router();

  const deviceAuth = (c: Ctx) => {
    if (!secretMatches(bearer(c.req), cfg.deviceToken)) throw new HttpError(401, 'unauthorised', 'Device token missing or wrong.');
    const keyId = str(c.req.headers['x-device-key'], 64) || null;
    c.device = { keyId };
  };
  const needDevice = (c: Ctx): string => {
    deviceAuth(c);
    if (!c.device?.keyId) throw new HttpError(400, 'device_key', 'X-Device-Key header required.');
    return c.device.keyId;
  };
  const staffAuth = (c: Ctx, roles: readonly StaffRole[] = STAFF_ROLES) => {
    if (!secretMatches(bearer(c.req), cfg.consoleToken)) throw new HttpError(401, 'unauthorised', 'Console token missing or wrong.');
    const role = str(c.req.headers['x-staff-role'], 40) as StaffRole;
    const user = str(c.req.headers['x-staff-user'], 80).trim();
    if (!STAFF_ROLES.includes(role)) throw new HttpError(400, 'role', 'X-Staff-Role must be dispatch, compliance_coordinator or supervisor.');
    if (!user) throw new HttpError(400, 'user', 'X-Staff-User required.');
    if (!roles.includes(role)) throw new HttpError(403, 'forbidden', `Only ${roles.join(' or ')} can do this.`);
    c.staff = { role, user };
    return c.staff;
  };
  const audit = (c: { staff?: Ctx['staff'] }, action: string, entity: string, id: string, data?: unknown) =>
    db.query('insert into audit_log (actor, role, action, entity, entity_id, data) values ($1,$2,$3,$4,$5,$6)', [c.staff?.user ?? 'system', c.staff?.role ?? 'system', action, entity, id, data === undefined ? null : JSON.stringify(data)]);
  const touchDevice = (keyId: string) => db.query('update devices set last_seen_at = now() where key_id = $1', [keyId]);

  /* ─────────────────────────── Public ─────────────────────────── */

  r.on('GET', '/api/health', async () => {
    await db.query('select 1');
    return { ok: true, council: cfg.council, version: cfg.version, time: new Date(now()).toISOString() };
  });

  /* ─────────────────────────── Device API ─────────────────────────── */

  r.on('POST', '/api/devices/register', async (c) => {
    deviceAuth(c);
    const b = await c.body<{ publicJwk?: JsonWebKey; label?: string; officerNumber?: string }>();
    const jwk = b.publicJwk;
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new HttpError(422, 'invalid', 'publicJwk must be an EC P-256 public key.');
    const keyId = await keyIdOf(jwk);
    const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
    const row = (
      await db.query<{ status: string }>(
        `insert into devices (key_id, public_jwk, label, officer_number, last_seen_at) values ($1,$2,$3,$4, now())
         on conflict (key_id) do update set label = excluded.label, officer_number = excluded.officer_number, last_seen_at = now()
         returning status`,
        [keyId, JSON.stringify(pub), str(b.label, 120), str(b.officerNumber, 12)],
      )
    ).rows[0]!;
    return { keyId, status: row.status, council: cfg.council };
  });

  r.on('GET', '/api/devices/me', async (c) => {
    const keyId = needDevice(c);
    const row = (await db.query<{ status: string }>('select status from devices where key_id = $1', [keyId])).rows[0];
    if (!row) throw new HttpError(404, 'unknown_device', 'Register this device first.');
    await touchDevice(keyId);
    return { keyId, status: row.status, council: cfg.council };
  });

  r.on('POST', '/api/sync', async (c) => {
    const keyId = needDevice(c);
    const b = await c.body<{ scans?: unknown[]; observations?: unknown[]; hotEvents?: unknown[] }>();
    const accepted = { scans: [] as string[], observations: [] as string[], hotEvents: [] as string[] };
    const rejected: { kind: string; id: string; error: string }[] = [];
    await tx(db, async (q) => {
      for (const raw of (b.scans ?? []).slice(0, 200)) {
        const s = raw as Record<string, unknown> & { meta?: Record<string, unknown> & { location?: { latitude?: number; longitude?: number; accuracy?: number } | null }; thumbJpegBase64?: string };
        const id = str(s.id, 64);
        const capturedAt = num(s.meta?.capturedAt);
        if (!id || !str(s.plate) || capturedAt === null || !/^[0-9a-f]{64}$/.test(str(s.sha256, 64))) {
          rejected.push({ kind: 'scan', id: id || '?', error: 'id, plate, meta.capturedAt and sha256 are required' });
          continue;
        }
        const { thumbJpegBase64, ...data } = s;
        const loc = s.meta?.location ?? null;
        await q.query(
          `insert into scans (id, device_key_id, officer_number, list_id, plate, plate_key, outcome, captured_at, lat, lng, accuracy_m, sha256, observation_id, thumb_jpeg, data)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           on conflict (id) do update set plate = excluded.plate, plate_key = excluded.plate_key, outcome = excluded.outcome, observation_id = excluded.observation_id,
             thumb_jpeg = coalesce(excluded.thumb_jpeg, scans.thumb_jpeg), data = excluded.data, updated_at = now()
           where scans.sha256 = excluded.sha256`,
          [
            id, keyId, str(s.officerNumber, 12) || null, str(s.listId, 64), normalisePlate(str(s.plate, 16)), plateKey(str(s.plate, 16)), str(s.outcome, 40), new Date(capturedAt),
            num(loc?.latitude), num(loc?.longitude), num(loc?.accuracy), str(s.sha256, 64), str(s.observationId, 64) || null,
            thumbJpegBase64 ? Buffer.from(String(thumbJpegBase64), 'base64') : null, JSON.stringify(data),
          ],
        );
        accepted.scans.push(id);
      }
      for (const raw of (b.observations ?? []).slice(0, 200)) {
        const o = raw as Record<string, unknown>;
        const id = str(o.id, 64);
        const started = num(o.startedAt);
        if (!id || started === null) {
          rejected.push({ kind: 'observation', id: id || '?', error: 'id and startedAt are required' });
          continue;
        }
        await q.query(
          `insert into observations (id, device_key_id, list_id, plate, status, started_at, data) values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (id) do update set status = excluded.status, plate = excluded.plate, data = excluded.data, updated_at = now()`,
          [id, keyId, str(o.listId, 64), str(o.plate, 16), str(o.status, 20), new Date(started), JSON.stringify(o)],
        );
        accepted.observations.push(id);
      }
      for (const raw of (b.hotEvents ?? []).slice(0, 200)) {
        const e = raw as Record<string, unknown>;
        const res = await upsertHotEvent(q, keyId, e);
        if (res) rejected.push({ kind: 'hotEvent', id: str(e.id, 64) || '?', error: res });
        else accepted.hotEvents.push(str(e.id, 64));
      }
    });
    await touchDevice(keyId);
    return { accepted, rejected };
  });

  async function upsertHotEvent(q: { query: Db['query'] }, keyId: string, e: Record<string, unknown>): Promise<string | null> {
    const id = str(e.id, 64);
    const at = num(e.at);
    if (!id || at === null || !str(e.plate) || !str(e.hotListEntryId)) return 'id, at, plate and hotListEntryId are required';
    const loc = e.location as { lat?: number; lng?: number; accuracyM?: number } | null;
    await q.query(
      `insert into hot_events (id, device_key_id, kind, plate, plate_key, hot_list_entry_id, scan_id, at, officer_number, lat, lng, accuracy_m, data)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (id) do update set data = excluded.data`,
      [id, keyId, str(e.kind, 40), str(e.plate, 16), plateKey(str(e.plate, 16)), str(e.hotListEntryId, 64), str(e.scanId, 64) || null, new Date(at), str(e.officerNumber, 12), num(loc?.lat), num(loc?.lng), num(loc?.accuracyM), JSON.stringify(e)],
    );
    return null;
  }

  /** Soft Code 1: the officer acknowledged a hot-list sighting (WF-S29). */
  r.on('POST', '/api/hot-alerts', async (c) => {
    const keyId = needDevice(c);
    const b = await c.body<{ event?: Record<string, unknown>; entry?: Record<string, unknown> }>();
    const e = b.event ?? {};
    if (e.kind !== 'acknowledged') throw new HttpError(422, 'invalid', 'Only an acknowledgement raises a soft Code 1.');
    const id = need(str(e.id, 64), 'event.id');
    const officer = need(str(e.officerNumber, 12), 'event.officerNumber');
    const at = need(num(e.at), 'event.at');
    const loc = e.location as { lat?: number; lng?: number; accuracyM?: number } | null;
    const entry = b.entry ?? {};
    const recipients = ((e.notification as { recipients?: string[] } | undefined)?.recipients ?? [...ALERT_RECIPIENTS]).filter((x): x is Recipient => (ALERT_RECIPIENTS as readonly string[]).includes(x));
    const sentAt = await tx(db, async (q) => {
      const err = await upsertHotEvent(q, keyId, e);
      if (err) throw new HttpError(422, 'invalid', err);
      const row = (
        await q.query<{ received_at: Date }>(
          `insert into alerts (id, plate, hot_list_entry_id, scan_id, risk_level, officer_number, device_key_id, lat, lng, accuracy_m, raised_at, recipients, data)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           on conflict (id) do update set data = alerts.data returning received_at`,
          [
            id, normalisePlate(str(e.plate, 16)), str(e.hotListEntryId, 64), str(e.scanId, 64) || null, str(entry.riskLevel, 20) || null, officer, keyId,
            num(loc?.lat), num(loc?.lng), num(loc?.accuracyM), new Date(at), JSON.stringify(recipients.length ? recipients : ALERT_RECIPIENTS),
            JSON.stringify({ entry: { riskLevel: entry.riskLevel ?? null, risks: Array.isArray(entry.risks) ? entry.risks.slice(0, 20) : [], make: str(entry.make, 60), type: str(entry.type, 60), colour: str(entry.colour, 40) }, atLocal: str(e.atLocal, 40) }),
          ],
        )
      ).rows[0]!;
      return row.received_at.getTime();
    });
    await touchDevice(keyId);
    return { sentAt };
  });

  r.on('POST', '/api/infringements/statements', async (c) => {
    const keyId = needDevice(c);
    const b = await c.body<BundleIn>();
    if (b.keyId !== keyId) throw new HttpError(422, 'key_mismatch', 'Bundle key does not match X-Device-Key.');
    if (!str(b.scanId, 64)) throw new HttpError(422, 'invalid', 'scanId is required.');
    const out = await tx(db, (q) => acceptBundle(q, b, { council: cfg.council, now: now() }));
    await touchDevice(keyId);
    return out;
  });

  /** Void without a reissue: waits for supervisor approval (owner, 23/11/2026). */
  r.on('POST', '/api/infringements/:number/void-request', async (c) => {
    const keyId = needDevice(c);
    const b = await c.body<{ reason?: string; note?: string; requestedAt?: number; officerNumber?: string }>();
    const reason = str(b.reason, 40);
    if (!(VOID_REASONS as readonly string[]).includes(reason)) throw new HttpError(422, 'invalid', `reason must be one of ${VOID_REASONS.join(', ')}.`);
    return tx(db, async (q) => {
      const row = (await q.query<{ status: string; key_id: string }>('select status, key_id from infringements where number = $1 for update', [c.params.number])).rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'No such infringement (sync the issue first).');
      if (row.key_id !== keyId) throw new HttpError(403, 'forbidden', 'Only the issuing device can request a void.');
      if (row.status === 'void_requested') return { status: 'void_requested' };
      if (row.status !== 'issued') throw new HttpError(409, 'state', `A ${row.status} infringement cannot be voided.`);
      const request = { reason, note: str(b.note, 500), requestedAt: num(b.requestedAt) ?? now(), officerNumber: str(b.officerNumber, 12) };
      await q.query("update infringements set status = 'void_requested', void_request = $2, updated_at = now(), change_no = nextval('change_seq') where number = $1", [c.params.number, JSON.stringify(request)]);
      await recordInfringementEvent(q, c.params.number!, { actor: request.officerNumber || 'officer', role: 'officer', action: 'void_requested', from: 'issued', to: 'void_requested', reason, data: { note: request.note } });
      return { status: 'void_requested' };
    });
  });

  r.on('PUT', '/api/evidence/:scanId', async (c) => {
    needDevice(c);
    const want = str(c.req.headers['x-content-sha256'], 64);
    const bytes = await c.raw(15 * MB);
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== want) throw new HttpError(422, 'sha256', 'Evidence bytes do not match X-Content-SHA256.');
    const scan = (await db.query<{ sha256: string }>('select sha256 from scans where id = $1', [c.params.scanId])).rows[0];
    if (scan && scan.sha256 !== got) throw new HttpError(422, 'sha256', 'Evidence does not match the SHA-256 recorded at capture.');
    await db.query('insert into evidence (scan_id, sha256, mime, bytes) values ($1,$2,$3,$4) on conflict (scan_id) do nothing', [c.params.scanId, got, str(c.req.headers['content-type'], 60) || 'image/jpeg', bytes]);
    return { scanId: c.params.scanId, sha256: got, verifiedAgainstCapture: !!scan };
  });

  /** Changes for this device since its cursor: infringement status and alert acknowledgements. */
  r.on('GET', '/api/updates', async (c) => {
    const keyId = needDevice(c);
    const since = Number(c.url.searchParams.get('since') ?? 0) || 0;
    const inf = await db.query<{ number: string; scan_id: string; status: string; void_request: unknown; paid_at: Date | null; change_no: string }>(
      'select number, scan_id, status, void_request, paid_at, change_no from infringements where key_id = $1 and change_no > $2 order by change_no limit 500',
      [keyId, since],
    );
    const al = await db.query<{ id: string; status: string; change_no: string; acks: unknown }>(
      `select a.id, a.status, a.change_no, coalesce(json_agg(json_build_object('recipient', k.recipient, 'by', k.acknowledged_by, 'at', (extract(epoch from k.acknowledged_at) * 1000)::bigint)) filter (where k.alert_id is not null), '[]') as acks
       from alerts a left join alert_acks k on k.alert_id = a.id where a.device_key_id = $1 and a.change_no > $2 group by a.id order by a.change_no limit 500`,
      [keyId, since],
    );
    const cursor = Math.max(since, ...inf.rows.map((x) => Number(x.change_no)), ...al.rows.map((x) => Number(x.change_no)));
    await touchDevice(keyId);
    return {
      cursor,
      infringements: inf.rows.map((x) => ({ number: x.number, scanId: x.scan_id, status: x.status, voidRequest: x.void_request, paidAt: ms(x.paid_at) })),
      alerts: al.rows.map((x) => ({ id: x.id, status: x.status, acknowledgedBy: (x.acks as { recipient: string; by: string; at: string | number }[]).map((k) => ({ ...k, at: Number(k.at) })) })),
    };
  });

  /** Test payment provider: the paid session covering `at` (or the latest) for a plate. */
  r.on('GET', '/api/payments/lookup', async (c) => {
    deviceAuth(c);
    const plate = plateKey(need(c.url.searchParams.get('plate'), 'plate'));
    const at = new Date(Number(c.url.searchParams.get('at')) || now());
    const ref = c.url.searchParams.get('ref');
    const row = (
      await db.query<{ source: string; source_ref: string; paid_from: Date; paid_to: Date }>(
        `select source, source_ref, paid_from, paid_to from paid_sessions where plate_key = $1 and paid_from <= $2 ${ref ? 'and (source_ref = $3 or source_ref = \'\')' : ''}
         order by (paid_to >= $2) desc, paid_to desc limit 1`,
        ref ? [plate, at, ref] : [plate, at],
      )
    ).rows[0];
    return { session: row ? { source: row.source, sourceRef: row.source_ref, paidFrom: ms(row.paid_from), paidTo: ms(row.paid_to) } : null };
  });

  /* ─────────────────────────── Console API (CommandMAPS stand-in) ─────────────────────────── */

  r.on('GET', '/api/console/me', async (c) => ({ ...staffAuth(c), council: cfg.council, version: cfg.version }));

  r.on('GET', '/api/console/summary', async (c) => {
    staffAuth(c);
    const q = await db.query<{ k: string; n: string }>(`
      select 'alerts_active' k, count(*)::text n from alerts where status = 'active'
      union all select 'void_requests', count(*)::text from infringements where status = 'void_requested'
      union all select 'devices_pending', count(*)::text from devices where status = 'pending'
      union all select 'issued_today', count(*)::text from infringements where issued_at >= date_trunc('day', now())
      union all select 'scans_today', count(*)::text from scans where captured_at >= date_trunc('day', now())`);
    return Object.fromEntries(q.rows.map((x) => [x.k, Number(x.n)]));
  });

  const alertJson = (a: Record<string, unknown> & { acks: unknown }) => ({
    id: a.id, plate: a.plate, hotListEntryId: a.hot_list_entry_id, scanId: a.scan_id, riskLevel: a.risk_level, officerNumber: a.officer_number,
    location: a.lat === null ? null : { lat: a.lat, lng: a.lng, accuracyM: a.accuracy_m }, raisedAt: ms(a.raised_at as Date), receivedAt: ms(a.received_at as Date),
    recipients: a.recipients, status: a.status, closedAt: ms(a.closed_at as Date | null), entry: (a.data as { entry?: unknown }).entry ?? null,
    acks: (a.acks as { recipient: string; by: string; at: number }[]).map((k) => ({ ...k, at: Number(k.at) })),
  });
  const ALERT_SELECT = `select a.*, coalesce(json_agg(json_build_object('recipient', k.recipient, 'by', k.acknowledged_by, 'at', (extract(epoch from k.acknowledged_at) * 1000)::bigint)) filter (where k.alert_id is not null), '[]') as acks
    from alerts a left join alert_acks k on k.alert_id = a.id`;

  r.on('GET', '/api/console/alerts', async (c) => {
    staffAuth(c);
    const all = c.url.searchParams.get('status') === 'all';
    const rows = await db.query(`${ALERT_SELECT} ${all ? '' : "where a.status = 'active'"} group by a.id order by a.raised_at desc limit 200`);
    return { alerts: rows.rows.map((x) => alertJson(x as never)) };
  });

  r.on('GET', '/api/console/alerts/:id', async (c) => {
    staffAuth(c);
    const a = (await db.query(`${ALERT_SELECT} where a.id = $1 group by a.id`, [c.params.id])).rows[0];
    if (!a) throw new HttpError(404, 'not_found', 'No such alert.');
    const log = await db.query<{ id: string; kind: string; at: Date; officer_number: string; lat: number | null; lng: number | null; accuracy_m: number | null; scan_id: string | null; data: { readAs?: string } }>(
      'select id, kind, at, officer_number, lat, lng, accuracy_m, scan_id, data from hot_events where hot_list_entry_id = $1 order by at desc limit 200',
      [a.hot_list_entry_id],
    );
    const sightings = await db.query<{ id: string; captured_at: Date; officer_number: string | null; lat: number | null; lng: number | null; has_evidence: boolean }>(
      `select s.id, s.captured_at, s.officer_number, s.lat, s.lng, (e.scan_id is not null) as has_evidence from scans s left join evidence e on e.scan_id = s.id
       where s.plate_key = $1 and s.outcome = 'hot_sighting' order by s.captured_at desc limit 200`,
      [plateKey(String(a.plate))],
    );
    return {
      alert: alertJson(a as never),
      log: [
        ...log.rows.map((x) => ({ kind: x.kind, at: ms(x.at), officerNumber: x.officer_number, location: x.lat === null ? null : { lat: x.lat, lng: x.lng, accuracyM: x.accuracy_m }, scanId: x.scan_id, readAs: x.data.readAs ?? null })),
        ...sightings.rows.map((x) => ({ kind: 'sighting', at: ms(x.captured_at), officerNumber: x.officer_number, location: x.lat === null ? null : { lat: x.lat, lng: x.lng }, scanId: x.id, hasEvidence: x.has_evidence })),
      ].sort((p, q) => (q.at ?? 0) - (p.at ?? 0)),
    };
  });

  /** Each recipient acknowledges separately; the banner closes for that recipient (OQ29, proposed). */
  r.on('POST', '/api/console/alerts/:id/ack', async (c) => {
    const s = staffAuth(c, ['dispatch', 'compliance_coordinator']);
    const out = await tx(db, async (q) => {
      const a = (await q.query<{ recipients: Recipient[]; status: string }>('select recipients, status from alerts where id = $1 for update', [c.params.id])).rows[0];
      if (!a) throw new HttpError(404, 'not_found', 'No such alert.');
      if (!a.recipients.includes(s.role as Recipient)) throw new HttpError(403, 'forbidden', `${s.role} is not a recipient of this alert.`);
      await q.query('insert into alert_acks (alert_id, recipient, acknowledged_by) values ($1,$2,$3) on conflict do nothing', [c.params.id, s.role, s.user]);
      const acked = (await q.query<{ recipient: string }>('select recipient from alert_acks where alert_id = $1', [c.params.id])).rows.map((x) => x.recipient);
      const closed = a.recipients.every((x) => acked.includes(x));
      await q.query(`update alerts set status = $2, closed_at = case when $2 = 'closed' then coalesce(closed_at, now()) else null end, updated_at = now(), change_no = nextval('change_seq') where id = $1`, [c.params.id, closed ? 'closed' : 'active']);
      return { status: closed ? 'closed' : 'active', acknowledged: acked };
    });
    await audit(c, 'alert_acknowledged', 'alert', c.params.id!);
    return out;
  });

  const infJson = (x: Record<string, unknown>) => ({
    number: x.number, status: x.status, scanId: x.scan_id, officerNumber: x.officer_number, plate: x.plate, offenceCode: x.offence_code,
    internalVariant: x.internal_variant, variantSource: x.variant_source, shortfallMinutes: x.shortfall_minutes,
    timeFrom: iso(x.time_from as Date | null), timeTo: iso(x.time_to as Date | null), issuedAt: iso(x.issued_at as Date | null), allocatedAt: iso(x.allocated_at as Date),
    location: x.location, reissueOf: x.reissue_of, reissuedBy: x.reissued_by, voidRequest: x.void_request, paidAt: iso(x.paid_at as Date | null), updatedAt: iso(x.updated_at as Date),
  });

  r.on('GET', '/api/console/infringements', async (c) => {
    staffAuth(c);
    const status = c.url.searchParams.get('status');
    const rows = await db.query(`select * from infringements ${status ? 'where status = $1' : ''} order by coalesce(issued_at, allocated_at) desc limit 300`, status ? [status] : []);
    return { infringements: rows.rows.map(infJson) };
  });

  r.on('GET', '/api/console/infringements/:number', async (c) => {
    staffAuth(c);
    const x = (await db.query('select * from infringements where number = $1', [c.params.number])).rows[0];
    if (!x) throw new HttpError(404, 'not_found', 'No such infringement.');
    const events = await db.query('select at, actor, actor_role, action, from_status, to_status, reason, data from infringement_events where number = $1 order by id', [c.params.number]);
    const stmts = await db.query('select type, hash, prev_hash, received_at, statement from statements where number = $1 order by received_at', [c.params.number]);
    const record = x.record as { notes?: string; vehicle?: unknown; evidenceOverride?: unknown; handoff?: { evidence?: { scanId: string; role: string; sha256: string }[] } } | null;
    const evidence = record?.handoff?.evidence ?? [];
    const have = new Set((await db.query<{ scan_id: string }>('select scan_id from evidence where scan_id = any($1)', [evidence.map((e) => e.scanId)])).rows.map((e) => e.scan_id));
    return {
      infringement: { ...infJson(x), notes: record?.notes ?? null, vehicle: record?.vehicle ?? null, evidenceOverride: record?.evidenceOverride ?? null },
      evidence: evidence.map((e) => ({ ...e, uploaded: have.has(e.scanId) })),
      events: events.rows.map((e) => ({ ...e, at: iso(e.at as Date) })),
      statements: stmts.rows.map((s) => ({ type: s.type, hash: s.hash, prevHash: s.prev_hash, receivedAt: iso(s.received_at as Date), statement: s.statement })),
    };
  });

  r.on('POST', '/api/console/infringements/:number/void-decision', async (c) => {
    const s = staffAuth(c, ['supervisor']);
    const b = await c.body<{ approve?: boolean; note?: string }>();
    if (typeof b.approve !== 'boolean') throw new HttpError(422, 'invalid', 'approve must be true or false.');
    const out = await tx(db, async (q) => {
      const x = (await q.query<{ status: string; void_request: Record<string, unknown> }>('select status, void_request from infringements where number = $1 for update', [c.params.number])).rows[0];
      if (!x) throw new HttpError(404, 'not_found', 'No such infringement.');
      if (x.status !== 'void_requested') throw new HttpError(409, 'state', `Infringement is ${x.status}, not awaiting a void decision.`);
      const to = b.approve ? 'voided' : 'issued';
      const request = { ...x.void_request, decision: b.approve ? 'approved' : 'rejected', decidedBy: s.user, decidedAt: now(), decisionNote: str(b.note, 500) };
      await q.query("update infringements set status = $2, void_request = $3, updated_at = now(), change_no = nextval('change_seq') where number = $1", [c.params.number, to, JSON.stringify(request)]);
      await recordInfringementEvent(q, c.params.number!, { actor: s.user, role: s.role, action: b.approve ? 'void_approved' : 'void_rejected', from: 'void_requested', to, reason: str(b.note, 500) || null });
      return { status: to };
    });
    await audit(c, out.status === 'voided' ? 'void_approved' : 'void_rejected', 'infringement', c.params.number!);
    return out;
  });

  /** Development: simulate the customer paying (the council infringement system's event). */
  r.on('POST', '/api/console/infringements/:number/payment', async (c) => {
    const s = staffAuth(c);
    const out = await tx(db, async (q) => {
      const x = (await q.query<{ status: string }>('select status from infringements where number = $1 for update', [c.params.number])).rows[0];
      if (!x) throw new HttpError(404, 'not_found', 'No such infringement.');
      if (x.status !== 'issued') throw new HttpError(409, 'state', `A ${x.status} infringement cannot be paid.`);
      await q.query("update infringements set status = 'paid', paid_at = now(), updated_at = now(), change_no = nextval('change_seq') where number = $1", [c.params.number]);
      await recordInfringementEvent(q, c.params.number!, { actor: s.user, role: s.role, action: 'payment_recorded', from: 'issued', to: 'paid', reason: 'Simulated payment (development backend)' });
      return { status: 'paid' };
    });
    await audit(c, 'payment_recorded', 'infringement', c.params.number!);
    return out;
  });

  r.on('GET', '/api/console/devices', async (c) => {
    staffAuth(c);
    const rows = await db.query('select key_id, label, officer_number, status, registered_at, decided_by, decided_at, last_seen_at from devices order by registered_at desc');
    return { devices: rows.rows.map((d) => ({ keyId: d.key_id, label: d.label, officerNumber: d.officer_number, status: d.status, registeredAt: iso(d.registered_at), decidedBy: d.decided_by, decidedAt: iso(d.decided_at), lastSeenAt: iso(d.last_seen_at) })) };
  });

  r.on('POST', '/api/console/devices/:keyId/decision', async (c) => {
    const s = staffAuth(c, ['supervisor']);
    const b = await c.body<{ approve?: boolean }>();
    if (typeof b.approve !== 'boolean') throw new HttpError(422, 'invalid', 'approve must be true or false.');
    const row = (await db.query<{ status: string }>('update devices set status = $2, decided_by = $3, decided_at = now() where key_id = $1 returning status', [c.params.keyId, b.approve ? 'approved' : 'revoked', s.user])).rows[0];
    if (!row) throw new HttpError(404, 'not_found', 'No such device.');
    await audit(c, b.approve ? 'device_approved' : 'device_revoked', 'device', c.params.keyId!);
    return { status: row.status };
  });

  r.on('GET', '/api/console/scans', async (c) => {
    staffAuth(c);
    const limit = Math.min(500, Number(c.url.searchParams.get('limit')) || 100);
    const rows = await db.query(
      `select s.id, s.plate, s.outcome, s.captured_at, s.officer_number, s.list_id, s.lat, s.lng, s.accuracy_m, (s.thumb_jpeg is not null) as has_thumb, (e.scan_id is not null) as has_evidence, s.data->'payment' as payment
       from scans s left join evidence e on e.scan_id = s.id order by s.captured_at desc limit $1`,
      [limit],
    );
    return { scans: rows.rows.map((s) => ({ id: s.id, plate: s.plate, outcome: s.outcome, capturedAt: ms(s.captured_at), officerNumber: s.officer_number, listId: s.list_id, location: s.lat === null ? null : { lat: s.lat, lng: s.lng, accuracyM: s.accuracy_m }, hasThumb: s.has_thumb, hasEvidence: s.has_evidence, payment: s.payment })) };
  });

  r.on('GET', '/api/console/scans/:id/thumb', async (c) => {
    staffAuth(c);
    const row = (await db.query<{ thumb_jpeg: Buffer | null }>('select thumb_jpeg from scans where id = $1', [c.params.id])).rows[0];
    if (!row?.thumb_jpeg) throw new HttpError(404, 'not_found', 'No thumbnail.');
    send(c.res, 200, row.thumb_jpeg, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
  });

  r.on('GET', '/api/console/evidence/:scanId', async (c) => {
    staffAuth(c);
    const row = (await db.query<{ bytes: Buffer; mime: string; sha256: string }>('select bytes, mime, sha256 from evidence where scan_id = $1', [c.params.scanId])).rows[0];
    if (!row) throw new HttpError(404, 'not_found', 'Evidence not uploaded yet.');
    send(c.res, 200, row.bytes, { 'Content-Type': row.mime, 'X-Content-SHA256': row.sha256, 'Cache-Control': 'private, max-age=3600' });
  });

  r.on('GET', '/api/console/paid-sessions', async (c) => {
    staffAuth(c);
    const rows = await db.query('select * from paid_sessions order by created_at desc limit 200');
    return { sessions: rows.rows.map((p) => ({ id: Number(p.id), plate: p.plate_key, source: p.source, sourceRef: p.source_ref, paidFrom: ms(p.paid_from), paidTo: ms(p.paid_to), createdBy: p.created_by, createdAt: ms(p.created_at) })) };
  });

  r.on('POST', '/api/console/paid-sessions', async (c) => {
    const s = staffAuth(c);
    const b = await c.body<{ plate?: string; source?: string; sourceRef?: string; paidFrom?: number; paidTo?: number }>();
    const plate = plateKey(need(str(b.plate, 16), 'plate'));
    const source = need(str(b.source, 20), 'source');
    if (!['easypark', 'paystay', 'meter', 'ticket', 'other'].includes(source)) throw new HttpError(422, 'invalid', 'Unknown payment source.');
    const from = need(num(b.paidFrom), 'paidFrom');
    const to = need(num(b.paidTo), 'paidTo');
    if (to <= from) throw new HttpError(422, 'invalid', 'Paid to must be after paid from.');
    const row = (await db.query<{ id: string }>('insert into paid_sessions (plate_key, source, source_ref, paid_from, paid_to, created_by) values ($1,$2,$3,$4,$5,$6) returning id', [plate, source, str(b.sourceRef, 40), new Date(from), new Date(to), s.user])).rows[0]!;
    await audit(c, 'paid_session_created', 'paid_session', row.id, { plate, source, from, to });
    return { id: Number(row.id) };
  });

  /** 701 / 702 with the derived 702 split (702 / 702e) — internal analytics only. */
  r.on('GET', '/api/console/analytics/offences', async (c) => {
    staffAuth(c);
    const where = "status in ('issued', 'void_requested', 'paid')";
    const [byCode, byZone, byHour, bySource, shortfall] = await Promise.all([
      db.query(`select offence_code, coalesce(internal_variant, '') as variant, count(*)::int n from infringements where ${where} group by 1, 2 order by 1, 2`),
      db.query(`select coalesce(location->>'patrolZone', '—') zone, coalesce(location->>'displayId', location->>'listId', '—') segment, coalesce(internal_variant, '') variant, count(*)::int n from infringements where ${where} and offence_code = '702' group by 1, 2, 3 order by 1, 2, 3`),
      db.query(`select extract(hour from issued_at at time zone current_setting('TimeZone'))::int h, coalesce(internal_variant, '') variant, count(*)::int n from infringements where ${where} and offence_code = '702' group by 1, 2 order by 1, 2`),
      db.query(`select coalesce(record->'handoff'->'payment'->>'source', 'none') source, coalesce(internal_variant, '') variant, count(*)::int n from infringements where ${where} and offence_code = '702' group by 1, 2 order by 1, 2`),
      db.query(`select count(*)::int n, coalesce(round(avg(shortfall_minutes)), 0)::int avg, coalesce(percentile_cont(0.5) within group (order by shortfall_minutes), 0)::int median, coalesce(max(shortfall_minutes), 0)::int max from infringements where ${where} and internal_variant = 'expired_session' and shortfall_minutes is not null`),
    ]);
    return { byCode: byCode.rows, byZone: byZone.rows, byHour: byHour.rows, bySource: bySource.rows, shortfall: shortfall.rows[0] };
  });

  r.on('GET', '/api/console/audit', async (c) => {
    staffAuth(c, ['supervisor']);
    const rows = await db.query('select at, actor, role, action, entity, entity_id, data from audit_log order by id desc limit 300');
    return { audit: rows.rows.map((a) => ({ ...a, at: iso(a.at as Date) })) };
  });

  /* ─────────────────────────── Static ─────────────────────────── */

  const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream', '.gz': 'application/gzip',
  };
  const CONSOLE_CSP = "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

  async function serveFile(res: ServerResponse, root: string, rel: string, fallback?: string, headers: Record<string, string> = {}): Promise<boolean> {
    const base = resolve(root);
    let file = normalize(join(base, rel));
    if (file !== base && !file.startsWith(base + sep)) return false;
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      send(res, 200, body, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...headers });
      return true;
    } catch {
      if (fallback) return serveFile(res, root, fallback, undefined, headers);
      return false;
    }
  }

  function cors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin) return;
    const allowed = cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin);
    if (!allowed) return;
    res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigins.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Key, X-Content-SHA256, X-Staff-Role, X-Staff-User');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      cors(req, res);
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'OPTIONS') return send(res, 204, undefined);
        const m = r.match(req.method ?? 'GET', url.pathname);
        if (m === 'method') throw new HttpError(405, 'method', 'Method not allowed.');
        if (!m) throw new HttpError(404, 'not_found', 'No such endpoint.');
        let cached: Buffer | null = null;
        const ctx: Ctx = {
          req, res, url, params: m.params,
          raw: async (limit) => (cached ??= await readBody(req, limit)),
          body: async <T>() => {
            const buf = (cached ??= await readBody(req, 12 * MB));
            if (!buf.length) return {} as T;
            try {
              return JSON.parse(buf.toString('utf8')) as T;
            } catch {
              throw new HttpError(400, 'json', 'Body is not valid JSON.');
            }
          },
        };
        const out = await m.handler(ctx);
        if (!res.headersSent) send(res, 200, out ?? { ok: true });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'Method not allowed.');
      if (cfg.tokensDir && url.pathname.startsWith('/console/civicmaps/')) {
        if (await serveFile(res, cfg.tokensDir, decodeURIComponent(url.pathname.slice('/console/civicmaps/'.length)), undefined, { 'Cache-Control': 'public, max-age=86400' })) return;
        throw new HttpError(404, 'not_found', 'Not found.');
      }
      if (url.pathname === '/console' || url.pathname.startsWith('/console/')) {
        const rel = url.pathname.replace(/^\/console\/?/, '') || 'index.html';
        if (await serveFile(res, cfg.consoleDir, decodeURIComponent(rel), undefined, { 'Content-Security-Policy': CONSOLE_CSP, 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer' })) return;
        throw new HttpError(404, 'not_found', 'Not found.');
      }
      if (cfg.appDir && (await serveFile(res, cfg.appDir, decodeURIComponent(url.pathname), 'index.html'))) return;
      if (url.pathname === '/') return send(res, 302, undefined, { Location: '/console/' });
      throw new HttpError(404, 'not_found', 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) });
      const pgCode = (e as { code?: string }).code;
      if (pgCode === '23505') return send(res, 409, { error: 'conflict', message: 'That record already exists.' });
      console.error('[platewatch-server]', e);
      return send(res, 500, { error: 'server', message: 'Internal error.' });
    }
  };
}
