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
 *
 * Checks 1–3 and 5 (who signed, the chain, the number itself) refuse the statement: it is not
 * part of the key's chain. Checks 4 and 6 are business rules: a statement that passes 1–3 but
 * breaks one is still recorded in the chain and the number is marked `rejected` with the reason,
 * so the handset's later statements, already chained onto it, are not refused as chain breaks.
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

export interface BundleResult {
  number: string;
  status: string;
  /** Present when the statements were kept in the chain but the number refused (business rule). */
  rejection?: { code: string; message: string };
}

async function insertStatement(c: Tx, keyId: string, type: 'allocation' | 'issue' | 'cancel', number: string, signed: { hash: string; signature: string; statement: { prevHash: string } }): Promise<void> {
  await c.query('insert into statements (hash, key_id, type, number, prev_hash, statement, signature) values ($1,$2,$3,$4,$5,$6,$7)', [signed.hash, keyId, type, number, signed.statement.prevHash, JSON.stringify(signed.statement), signed.signature]);
  await setHead(c, keyId, signed.hash);
}

async function reject(c: Tx, number: string, actor: string, e: HttpError, record?: IssuedRecord): Promise<BundleResult> {
  const rejection = { code: e.code, message: e.message };
  await c.query("update infringements set status = 'rejected', rejection = $2, record = coalesce($3, record), updated_at = now(), change_no = nextval('change_seq') where number = $1", [number, JSON.stringify(rejection), record ? JSON.stringify(record) : null]);
  await event(c, number, { actor, role: 'officer', action: 'rejected', to: 'rejected', reason: e.message, data: { code: e.code } });
  return { number, status: 'rejected', rejection };
}

export async function acceptBundle(c: Tx, b: BundleIn, opts: { council: string; now: number }): Promise<BundleResult> {
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
    const h = await head(c, b.keyId);
    if (s.prevHash !== h) throw new HttpError(409, 'chain_break', 'Statement does not follow the last statement accepted from this key.', { expectedPrevHash: h });
    if ((await c.query('select 1 from infringements where number = $1', [number])).rowCount) throw new HttpError(409, 'duplicate_number', `${number} already exists.`);
    // Authentic and in the chain from here on; the rules below refuse the number, not the statement.
    let problem: HttpError | null = null;
    if (s.council !== opts.council) problem = new HttpError(422, 'wrong_council', `Statement is for council "${s.council}", this backend serves "${opts.council}".`);
    else if (!/^\d{6}$/.test(s.date)) problem = new HttpError(422, 'invalid', 'Allocation date must be YYMMDD.');
    else {
      const dayMs = dayToUtc(s.date);
      if (dayMs > opts.now + 2 * 86_400_000 || dayMs < opts.now - MAX_AGE_DAYS * 86_400_000) problem = new HttpError(422, 'implausible_date', `Allocation date ${s.date} is not plausible at receipt.`);
    }
    const pool = problem ? undefined : (await c.query<{ last_sequence: number }>('select last_sequence from pools where officer = $1 and day = $2 for update', [s.officer, s.date])).rows[0];
    const expected = (pool?.last_sequence ?? 0) + 1;
    if (!problem && s.sequence !== expected) problem = new HttpError(409, 'sequence', `Sequence ${s.sequence} is not the next in pool ${s.officer}/${s.date} (expected ${expected}).`);
    await insertStatement(c, b.keyId, 'allocation', number, a);
    if (!problem) await c.query('insert into pools (officer, day, last_sequence) values ($1,$2,$3) on conflict (officer, day) do update set last_sequence = excluded.last_sequence', [s.officer, s.date, s.sequence]);
    await c.query('insert into infringements (number, key_id, scan_id, officer_number, status, allocated_at) values ($1,$2,$3,$4,$5,$6)', [number, b.keyId, b.scanId, s.officer, 'allocated', new Date(Date.parse(s.timestamp) || opts.now)]);
    await event(c, number, { actor: s.officer, role: 'officer', action: 'allocated', to: 'allocated', data: { sequence: s.sequence, date: s.date } });
    if (problem) {
      const out = await reject(c, number, s.officer, problem);
      if (!b.closing) return out;
    }
  } else if (known.number !== number) {
    throw new HttpError(409, 'conflict', 'Allocation hash already used for another number.');
  }

  const z = b.closing;
  if (!z) return { number, status: 'allocated' };
  if ((await sha256Hex(canonical(z.statement))) !== z.hash) throw new HttpError(422, 'hash_mismatch', 'Closing hash does not match the statement.');
  if ((await c.query('select 1 from statements where hash = $1', [z.hash])).rowCount) {
    const cur = (await c.query<{ status: string; rejection: BundleResult['rejection'] | null }>('select status, rejection from infringements where number = $1', [number])).rows[0];
    return { number, status: cur?.status ?? 'allocated', ...(cur?.rejection ? { rejection: cur.rejection } : {}) };
  }
  const st = z.statement;
  if (st.number !== number || st.keyId !== b.keyId || st.allocationHash !== a.hash) throw new HttpError(422, 'closing_mismatch', 'Closing statement does not belong to this allocation.');
  if (st.type !== 'issue' && st.type !== 'cancel') throw new HttpError(422, 'invalid', 'Closing statement type must be issue or cancel.');
  if (!(await verifyStatement(dev.public_jwk, z))) throw new HttpError(422, 'bad_signature', 'Closing signature does not verify.');
  const h = await head(c, b.keyId);
  if (st.prevHash !== h) throw new HttpError(409, 'chain_break', 'Closing statement does not follow the last statement accepted from this key.', { expectedPrevHash: h });
  if ((await c.query("select 1 from statements where number = $1 and type <> 'allocation'", [number])).rowCount) throw new HttpError(409, 'already_closed', `${number} already has a closing statement.`);
  const cur = (await c.query<{ status: string; rejection: BundleResult['rejection'] | null }>('select status, rejection from infringements where number = $1 for update', [number])).rows[0];
  // A refused allocation: its closing still joins the chain; the number stays rejected.
  if (cur?.status === 'rejected') {
    await insertStatement(c, b.keyId, st.type, number, z);
    return { number, status: 'rejected', ...(cur.rejection ? { rejection: cur.rejection } : {}) };
  }
  if (cur?.status !== 'allocated') throw new HttpError(409, 'already_closed', `${number} is already ${cur?.status}.`);

  if (st.type === 'cancel') {
    await insertStatement(c, b.keyId, 'cancel', number, z);
    await c.query("update infringements set status = 'cancelled', updated_at = now(), change_no = nextval('change_seq') where number = $1", [number]);
    await event(c, number, { actor: a.statement.officer, role: 'officer', action: 'cancelled', from: 'allocated', to: 'cancelled', reason: 'Cancelled before issue; the number is consumed.' });
    return { number, status: 'cancelled' };
  }

  // The record must be the one the statement signs; otherwise it is a transport or client fault and
  // the handset resends the bundle it holds (refused outright, the chain does not move).
  const r = b.record;
  if (!r) throw new HttpError(422, 'invalid', 'An issue statement needs the issued record.');
  if ((await sha256Hex(canonical(r))) !== st.recordHash) throw new HttpError(422, 'record_hash', 'The record does not match the signed record hash.');
  // The issue statement is authentic, chains, and signs this record: it joins the chain whatever the
  // business rules below decide about the number.
  await insertStatement(c, b.keyId, 'issue', number, z);
  const officer = a.statement.officer;
  if (r.number !== number) return reject(c, number, officer, new HttpError(422, 'invalid', 'Record number does not match the allocation.'), r);
  if (!validateHandoff(r.handoff)) return reject(c, number, officer, new HttpError(422, 'invalid_handoff', 'Hand-off payload does not validate against the schema.'), r);
  const handoff = r.handoff as unknown as InfringementHandoff;
  if (r.offenceCode !== '701' && r.offenceCode !== '702') return reject(c, number, officer, new HttpError(422, 'invalid', 'Offence code must be 701 or 702.'), r);
  const lockedFrom = timeFromFor(handoff, r.offenceCode);
  if (Date.parse(r.timeFrom) !== Date.parse(lockedFrom)) return reject(c, number, officer, new HttpError(422, 'time_from', `Time from must be the locked ${lockedFrom}.`), r);
  if (!(Date.parse(r.timeTo) >= Date.parse(r.timeFrom))) return reject(c, number, officer, new HttpError(422, 'time_to', 'Time to is before time from.'), r);
  const variant = variantFor(handoff, r.offenceCode) ?? null;
  if ((r.internalVariant ?? null) !== variant) return reject(c, number, officer, new HttpError(422, 'variant', `The internal 702 classification is derived (${variant ?? 'none'}), not chosen.`), r);
  const paidTo = (handoff.payment as { paidTo?: string } | undefined)?.paidTo;
  const shortfall = variant === 'expired_session' && paidTo ? Math.max(0, Math.floor((Date.parse(String(handoff.times.scanAt ?? r.timeTo)) - Date.parse(paidTo)) / 60_000)) : null;

  if (r.reissueOf) {
    const orig = (await c.query<{ status: string; scan_id: string }>('select status, scan_id from infringements where number = $1 for update', [r.reissueOf])).rows[0];
    // E.g. reissued offline while the original was paid or voided at the console: refused, chain kept.
    if (!orig) return reject(c, number, officer, new HttpError(422, 'reissue', `Reissue of unknown infringement ${r.reissueOf}.`), r);
    if (!['issued', 'void_requested'].includes(orig.status)) return reject(c, number, officer, new HttpError(409, 'reissue', `${r.reissueOf} is ${orig.status}; only an issued infringement can be reissued.`), r);
    if (orig.scan_id !== b.scanId) return reject(c, number, officer, new HttpError(422, 'reissue', 'A reissue must come from the same sighting.'), r);
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
