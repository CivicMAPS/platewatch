/**
 * Infringement number (I-N) allocation and verification — shared by the handset and the server.
 *
 * Owner decisions (docs/architecture/decisions/infringement-number-generation.md in
 * TechCorp25/CivicMaps-rebuild, 17/11/2026; void/reissue 23/11/2026):
 * - 20 digits `OOOOO YYMMDD SSS TTTT CC`: officer id, allocation date (council local time), daily
 *   sequence 001–999 (pool = officer + date), 4-digit signature tag, ISO 7064 MOD 97-10 check digits.
 * - The number is produced only on the officer's handset, which signs an allocation statement
 *   (council, officer, key id, date, sequence, timestamp, hash of the previous statement) with a
 *   non-exportable ECDSA P-256 key. Tag = first 8 bytes of SHA-256(signature) mod 10000.
 * - A second signed statement covers the issued record.
 * - The server never creates a number: it verifies the signature, the next expected sequence, the
 *   hash chain, the date against receipt time and uniqueness, then accepts.
 *
 * Development build: the browser's WebCrypto key is non-extractable but not hardware-attested
 * (production uses the managed EnforcementMAPS handset's hardware keystore).
 */

export const GENESIS_HASH = '0'.repeat(64);

export interface AllocationStatement {
  v: 1;
  type: 'allocation';
  council: string;
  officer: string;
  keyId: string;
  /** YYMMDD, council local time. */
  date: string;
  sequence: number;
  /** ISO 8601 with offset. */
  timestamp: string;
  /** SHA-256 (hex) of the previous statement signed with this key, or GENESIS_HASH. */
  prevHash: string;
}

export interface IssueStatement {
  v: 1;
  type: 'issue' | 'cancel';
  number: string;
  keyId: string;
  /** Hash of the allocation statement for this number. */
  allocationHash: string;
  /** SHA-256 of the canonical issued record (absent for a cancelled number). */
  recordHash?: string;
  timestamp: string;
  prevHash: string;
}

export type Statement = AllocationStatement | IssueStatement;

export interface Signed<S extends Statement = Statement> {
  statement: S;
  /** base64url, IEEE P1363 (r‖s, 64 bytes). */
  signature: string;
  /** SHA-256 (hex) of canonical(statement). */
  hash: string;
}

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

/** Deterministic JSON: object keys sorted at every level, no whitespace. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text: string): Promise<string> {
  return hex(await subtle().digest('SHA-256', enc.encode(text)));
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** ISO 7064 MOD 97-10 check digits for the first 18 digits. */
export function checkDigits(first18: string): string {
  if (!/^\d{18}$/.test(first18)) throw new Error('I-N body must be 18 digits.');
  return String(98n - ((BigInt(first18) * 100n) % 97n)).padStart(2, '0');
}

/** Valid when all 20 digits mod 97 = 1. */
export function isValidInfringementNumber(n: string): boolean {
  return /^\d{20}$/.test(n) && BigInt(n) % 97n === 1n;
}

/** Officer id as the 5 leading digits. Officer numbers must be numeric, up to 5 digits. */
export function officerDigits(officer: string): string {
  const o = officer.trim();
  if (!/^\d{1,5}$/.test(o)) throw new Error('Officer number must be 1–5 digits to allocate an infringement number.');
  return o.padStart(5, '0');
}

/** YYMMDD in the device's local time zone (council local time on a council handset). */
export function allocationDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export async function signatureTag(signatureB64: string): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', fromBase64Url(signatureB64) as BufferSource));
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(digest[i]!);
  return String(v % 10000n).padStart(4, '0');
}

export function composeNumber(parts: { officer: string; date: string; sequence: number; tag: string }): string {
  if (parts.sequence < 1 || parts.sequence > 999) throw new Error('Daily sequence exhausted (001–999).');
  const body = `${officerDigits(parts.officer)}${parts.date}${String(parts.sequence).padStart(3, '0')}${parts.tag}`;
  return body + checkDigits(body);
}

export interface NumberParts {
  officer: string;
  date: string;
  sequence: number;
  tag: string;
  check: string;
}

export function parseNumber(n: string): NumberParts | null {
  if (!isValidInfringementNumber(n)) return null;
  return { officer: n.slice(0, 5), date: n.slice(5, 11), sequence: Number(n.slice(11, 14)), tag: n.slice(14, 18), check: n.slice(18) };
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** A new non-exportable signing key pair. */
export async function generateSigningKey(): Promise<{ privateKey: CryptoKey; publicJwk: JsonWebKey; keyId: string }> {
  const pair = (await subtle().generateKey(ECDSA, false, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await subtle().exportKey('jwk', pair.publicKey);
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  return { privateKey: pair.privateKey, publicJwk, keyId: await keyIdOf(publicJwk) };
}

/** Key id: first 16 hex of SHA-256 over the canonical public JWK. */
export async function keyIdOf(publicJwk: JsonWebKey): Promise<string> {
  return (await sha256Hex(canonical({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))).slice(0, 16);
}

export async function signStatement<S extends Statement>(privateKey: CryptoKey, statement: S): Promise<Signed<S>> {
  const text = canonical(statement);
  const sig = new Uint8Array(await subtle().sign(SIGN, privateKey, enc.encode(text)));
  return { statement, signature: toBase64Url(sig), hash: await sha256Hex(text) };
}

export async function verifyStatement(publicJwk: JsonWebKey, signed: Pick<Signed, 'statement' | 'signature'>): Promise<boolean> {
  try {
    const key = await subtle().importKey('jwk', { ...publicJwk, ext: true }, ECDSA, false, ['verify']);
    return await subtle().verify(SIGN, key, fromBase64Url(signed.signature) as BufferSource, enc.encode(canonical(signed.statement)));
  } catch {
    return false;
  }
}

/** Allocate the next number: sign the allocation statement and derive tag and check digits. */
export async function allocate(args: {
  privateKey: CryptoKey;
  keyId: string;
  council: string;
  officer: string;
  sequence: number;
  prevHash: string;
  now: number;
  timestamp: string;
}): Promise<{ number: string; allocation: Signed<AllocationStatement> }> {
  const statement: AllocationStatement = {
    v: 1,
    type: 'allocation',
    council: args.council,
    officer: officerDigits(args.officer),
    keyId: args.keyId,
    date: allocationDate(args.now),
    sequence: args.sequence,
    timestamp: args.timestamp,
    prevHash: args.prevHash,
  };
  const allocation = await signStatement(args.privateKey, statement);
  const number = composeNumber({ officer: statement.officer, date: statement.date, sequence: statement.sequence, tag: await signatureTag(allocation.signature) });
  return { number, allocation };
}

/** The number an allocation statement commits to (used by the verifier). */
export async function numberFor(allocation: Pick<Signed<AllocationStatement>, 'statement' | 'signature'>): Promise<string> {
  const s = allocation.statement;
  return composeNumber({ officer: s.officer, date: s.date, sequence: s.sequence, tag: await signatureTag(allocation.signature) });
}
