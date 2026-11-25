/**
 * Accepting signed I-N statements from a handset (docs/BACKEND.md §Infringement numbers).
 * The server never creates or changes a number. It checks, in one transaction:
 *  1. the device key is registered and approved;
 *  2. each signature verifies against that key;
 *  3. the statement chains onto the key's last accepted statement (no gaps, no forks);
 *  4. the allocation's sequence is the next in the officer's daily pool, and its date is plausible
 *     against receipt time;
 *  5. the number is the one the statement commits to (tag + MOD 97-10) and is unique;
 *  6. an issue statement's record hash matches the record, the record's hand-off validates against
 *     the schema, and the locked time from and the internal 702 classification are what the rules
 *     derive (re-derived here, never trusted from the client).
 */
import Ajv2020 from 'ajv/dist/2020.js';
import handoffSchema from '../schemas/platewatch-infringement-handoff.v1.schema.json';
import { canonical, GENESIS_HASH, numberFor, sha256Hex, verifyStatement, type AllocationStatement, type IssueStatement, type Signed } from '../src/lib/inNumber';
import { timeFromFor, variantFor } from '../src/lib/issuance';
import type { InfringementHandoff } from '../src/lib/infringement';
import type { IssuedRecord, VoidReason } from '../src/lib/types';
import type { Tx } from './db';
import { HttpError } from './http';

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateHandoff = ajv.compile(handoffSchema);

export interface BundleIn {
  keyId: string;
  scanId: string;
  allocation: Signed<AllocationStatement>;
  closing?: Signed<IssueStatement>;
  record?: IssuedRecord;
}

const MAX_AGE_DAYS = 35;

function dayToUtc(day: string): number {
  return Date.UTC(2000 + Number(day.slice(0, 2)), Number(day.slice(2, 4)) - 1, Number(day.slice(4, 6)));
}

async function head(c: Tx, keyId: string): Promise<string> {
  const r = await c.query<{ head_hash: string }>('select head_hash from chain_heads where key_id = $1 for update', [keyId]);
  return r.rows[0]?.head_hash ?? GENESIS_HASH;
}

async function setHead(c: Tx, keyId: string, hash: string): Promise<void> {
  await c.query('insert into chain_heads (key_id, head_hash) values ($1, $2) on conflict (key_id) do update set head_hash = excluded.head_hash', [keyId, hash]);
}

async function event(c: Tx, number: string, e: { actor: string; role: string; action: string; from?: string | null; to?: string | null; reason?: string | null; data?: unknown }): Promise<void> {
  await c.query('insert into infringement_events (number, actor, actor_role, action, from_status, to_status, reason, data) values ($1,$2,$3,$4,$5,$6,$7,$8)', [
    number, e.actor, e.role, e.action, e.from ?? null, e.to ?? null, e.reason ?? null, e.data === undefined ? null : JSON.stringify(e.data),
  ]);
}

export { event as recordInfringementEvent };

export async function acceptBundle(c: Tx, b: BundleIn, opts: { council: string; now: number }): Promise<{ number: string; status: string }> {
  const dev = (await c.query<{ public_jwk: JsonWebKey; status: string }>('select public_jwk, status from devices where key_id = $1 for update', [b.keyId])).rows[0];
  if (!dev) throw new HttpError(404, 'unknown_device', 'This device key is not registered.');
  if (dev.status !== 'approved') throw new HttpError(403, 'device_not_approved', `Device key ${b.keyId} is ${dev.status}; a supervisor must approve it before its numbers are accepted.`);

  const a = b.allocation;
  if (!a?.statement || a.statement.type !== 'allocation') throw new HttpError(422, 'invalid', 'Allocation statement missing.');
  if ((await sha256Hex(canonical(a.statement))) !== a.hash) throw new HttpError(422, 'hash_mismatch', 'Allocation hash does not match the statement.');
  const number = await numberFor(a);

  const known = (await c.query<{ number: string }>('select number from statements where hash = $1', [a.hash])).rows[0];
  if (!known) {
    const s = a.statement;
    if (s.keyId !== b.keyId) throw new HttpError(422, 'key_mismatch', 'Statement was not made with this device key.');
    if (!(await verifyStatement(dev.public_jwk, a))) throw new HttpError(422, 'bad_signature', 'Allocation signature does not verify.');
    if (s.council !== opts.council) throw new HttpError(422, 'wrong_council', `Statement is for council "${s.council}", this backend serves "${opts.council}".`);
    if (!/^\d{6}$/.test(s.date)) throw new HttpError(422, 'invalid', 'Allocation date must be YYMMDD.');
    const dayMs = dayToUtc(s.date);
    if (dayMs > opts.now + 2 * 86_400_000 || dayMs < opts.now - MAX_AGE_DAYS * 86_400_000) throw new HttpError(422, 'implausible_date', `Allocation date ${s.date} is not plausible at receipt.`);
    const h = await head(c, b.keyId);
    if (s.prevHash !== h) throw new HttpError(409, 'chain_break', 'Statement does not follow the last statement accepted from this key.', { expectedPrevHash: h });
    const pool = (await c.query<{ last_sequence: number }>('select last_sequence from pools where officer = $1 and day = $2 for update', [s.officer, s.date])).rows[0];
    const expected = (pool?.last_sequence ?? 0) + 1;
    if (s.sequence !== expected) throw new HttpError(409, 'sequence', `Sequence ${s.sequence} is not the next in pool ${s.officer}/${s.date} (expected ${expected}).`);
    if ((await c.query('select 1 from infringements where number = $1', [number])).rowCount) throw new HttpError(409, 'duplicate_number', `${number} already exists.`);
    await c.query('insert into statements (hash, key_id, type, number, prev_hash, statement, signature) values ($1,$2,$3,$4,$5,$6,$7)', [a.hash, b.keyId, 'allocation', number, s.prevHash, JSON.stringify(s), a.signature]);
    await setHead(c, b.keyId, a.hash);
    await c.query('insert into pools (officer, day, last_sequence) values ($1,$2,$3) on conflict (officer, day) do update set last_sequence = excluded.last_sequence', [s.officer, s.date, s.sequence]);
    await c.query('insert into infringements (number, key_id, scan_id, officer_number, status, allocated_at) values ($1,$2,$3,$4,$5,$6)', [number, b.keyId, b.scanId, s.officer, 'allocated', new Date(Date.parse(s.timestamp) || opts.now)]);
    await event(c, number, { actor: s.officer, role: 'officer', action: 'allocated', to: 'allocated', data: { sequence: s.sequence, date: s.date } });
  } else if (known.number !== number) {
    throw new HttpError(409, 'conflict', 'Allocation hash already used for another number.');
  }

  const z = b.closing;
  if (!z) return { number, status: 'allocated' };
  if ((await sha256Hex(canonical(z.statement))) !== z.hash) throw new HttpError(422, 'hash_mismatch', 'Closing hash does not match the statement.');
  if ((await c.query('select 1 from statements where hash = $1', [z.hash])).rowCount) {
    const cur = (await c.query<{ status: string }>('select status from infringements where number = $1', [number])).rows[0];
    return { number, status: cur?.status ?? 'allocated' };
  }
  const st = z.statement;
  if (st.number !== number || st.keyId !== b.keyId || st.allocationHash !== a.hash) throw new HttpError(422, 'closing_mismatch', 'Closing statement does not belong to this allocation.');
  if (st.type !== 'issue' && st.type !== 'cancel') throw new HttpError(422, 'invalid', 'Closing statement type must be issue or cancel.');
  if (!(await verifyStatement(dev.public_jwk, z))) throw new HttpError(422, 'bad_signature', 'Closing signature does not verify.');
  const h = await head(c, b.keyId);
  if (st.prevHash !== h) throw new HttpError(409, 'chain_break', 'Closing statement does not follow the last statement accepted from this key.', { expectedPrevHash: h });
  const cur = (await c.query<{ status: string }>('select status from infringements where number = $1 for update', [number])).rows[0];
  if (cur?.status !== 'allocated') throw new HttpError(409, 'already_closed', `${number} is already ${cur?.status}.`);

  if (st.type === 'cancel') {
    await c.query('insert into statements (hash, key_id, type, number, prev_hash, statement, signature) values ($1,$2,$3,$4,$5,$6,$7)', [z.hash, b.keyId, 'cancel', number, st.prevHash, JSON.stringify(st), z.signature]);
    await setHead(c, b.keyId, z.hash);
    await c.query("update infringements set status = 'cancelled', updated_at = now(), change_no = nextval('change_seq') where number = $1", [number]);
    await event(c, number, { actor: a.statement.officer, role: 'officer', action: 'cancelled', from: 'allocated', to: 'cancelled', reason: 'Cancelled before issue; the number is consumed.' });
    return { number, status: 'cancelled' };
  }

  const r = b.record;
  if (!r) throw new HttpError(422, 'invalid', 'An issue statement needs the issued record.');
  if ((await sha256Hex(canonical(r))) !== st.recordHash) throw new HttpError(422, 'record_hash', 'The record does not match the signed record hash.');
  if (r.number !== number) throw new HttpError(422, 'invalid', 'Record number does not match the allocation.');
  if (!validateHandoff(r.handoff)) throw new HttpError(422, 'invalid_handoff', 'Hand-off payload does not validate against the schema.', validateHandoff.errors);
  const handoff = r.handoff as unknown as InfringementHandoff;
  if (r.offenceCode !== '701' && r.offenceCode !== '702') throw new HttpError(422, 'invalid', 'Offence code must be 701 or 702.');
  const lockedFrom = timeFromFor(handoff, r.offenceCode);
  if (Date.parse(r.timeFrom) !== Date.parse(lockedFrom)) throw new HttpError(422, 'time_from', `Time from must be the locked ${lockedFrom}.`);
  if (!(Date.parse(r.timeTo) >= Date.parse(r.timeFrom))) throw new HttpError(422, 'time_to', 'Time to is before time from.');
  const variant = variantFor(handoff, r.offenceCode) ?? null;
  if ((r.internalVariant ?? null) !== variant) throw new HttpError(422, 'variant', `The internal 702 classification is derived (${variant ?? 'none'}), not chosen.`);
  const paidTo = (handoff.payment as { paidTo?: string } | undefined)?.paidTo;
  const shortfall = variant === 'expired_session' && paidTo ? Math.max(0, Math.floor((Date.parse(String(handoff.times.scanAt ?? r.timeTo)) - Date.parse(paidTo)) / 60_000)) : null;

  await c.query('insert into statements (hash, key_id, type, number, prev_hash, statement, signature) values ($1,$2,$3,$4,$5,$6,$7)', [z.hash, b.keyId, 'issue', number, st.prevHash, JSON.stringify(st), z.signature]);
  await setHead(c, b.keyId, z.hash);

  if (r.reissueOf) {
    const orig = (await c.query<{ status: string; scan_id: string }>('select status, scan_id from infringements where number = $1 for update', [r.reissueOf])).rows[0];
    if (!orig) throw new HttpError(422, 'reissue', `Reissue of unknown infringement ${r.reissueOf}.`);
    if (!['issued', 'void_requested'].includes(orig.status)) throw new HttpError(409, 'reissue', `${r.reissueOf} is ${orig.status}; only an issued infringement can be reissued.`);
    if (orig.scan_id !== b.scanId) throw new HttpError(422, 'reissue', 'A reissue must come from the same sighting.');
    // Owner, 23/11/2026: a void followed by a reissue needs no approval.
    await c.query("update infringements set status = 'voided', reissued_by = $2, updated_at = now(), change_no = nextval('change_seq') where number = $1", [r.reissueOf, number]);
    await event(c, r.reissueOf, { actor: r.officerNumber, role: 'officer', action: 'voided_by_reissue', from: orig.status, to: 'voided', reason: r.reissueReason ?? null, data: { replacement: number } });
  }

  await c.query(
    `update infringements set status = 'issued', officer_number = $14, handoff_id = $2, plate = $3, offence_code = $4, internal_variant = $5, variant_source = $6, shortfall_minutes = $7,
       time_from = $8, time_to = $9, issued_at = $10, location = $11, record = $12, reissue_of = $13, updated_at = now(), change_no = nextval('change_seq')
     where number = $1`,
    [
      number, r.handoffId, String((handoff.vehicle as { registration?: string }).registration ?? ''), r.offenceCode, variant, variant ? 'derived' : null, shortfall,
      new Date(r.timeFrom), new Date(r.timeTo), new Date(r.issuedAt), JSON.stringify(handoff.location ?? null), JSON.stringify(r), r.reissueOf ?? null,
      r.officerNumber,
    ],
  );
  await event(c, number, { actor: r.officerNumber, role: 'officer', action: 'issued', from: 'allocated', to: 'issued', data: { offenceCode: r.offenceCode, overridden: r.offenceOverridden, reissueOf: r.reissueOf ?? null } });
  return { number, status: 'issued' };
}

export const VOID_REASONS: readonly VoidReason[] = ['officer_error', 'permit_displayed', 'incorrect_offence', 'incorrect_vehicle_details', 'non_conforming_signage', 'other'];
