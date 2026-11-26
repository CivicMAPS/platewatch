import { describe, expect, it } from 'vitest';
import { allocate, allocationDate, canonical, checkDigits, composeNumber, generateSigningKey, GENESIS_HASH, isValidInfringementNumber, numberFor, officerDigits, parseNumber, signatureTag, verifyStatement } from '../src/lib/inNumber';
import { at } from './fixtures';

describe('infringement number (I-N)', () => {
  it('MOD 97-10 check digits: the published example 04471 261121 001 8363 93 is valid', () => {
    expect(checkDigits('044712611210018363')).toBe('93');
    expect(isValidInfringementNumber('04471261121001836393')).toBe(true);
    expect(isValidInfringementNumber('04471261121001836394')).toBe(false);
    expect(isValidInfringementNumber('0447126112100183639')).toBe(false);
    expect(parseNumber('04471261121001836393')).toEqual({ officer: '04471', date: '261121', sequence: 1, tag: '8363', check: '93' });
  });

  it('officer id is numeric, up to 5 digits; the daily pool is 001–999', () => {
    expect(officerDigits('4471')).toBe('04471');
    expect(() => officerDigits('A4471')).toThrow(/digits/);
    expect(() => composeNumber({ officer: '4471', date: '261121', sequence: 1000, tag: '0000' })).toThrow(/exhausted/);
    expect(allocationDate(at(2026, 11, 21, 23, 59))).toBe('261121');
  });

  it('canonical JSON is key-order independent', () => {
    expect(canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"b":1}');
  });

  it('a signed allocation commits to its number; any change breaks the signature', async () => {
    const k = await generateSigningKey();
    const { number, allocation } = await allocate({ privateKey: k.privateKey, keyId: k.keyId, council: 'com', officer: '4471', sequence: 1, prevHash: GENESIS_HASH, now: at(2026, 11, 21, 10), timestamp: '2026-11-21T10:00:00.000+11:00' });
    expect(isValidInfringementNumber(number)).toBe(true);
    expect(number.slice(0, 14)).toBe('04471261121001');
    expect(number.slice(14, 18)).toBe(await signatureTag(allocation.signature));
    expect(await numberFor(allocation)).toBe(number);
    expect(await verifyStatement(k.publicJwk, allocation)).toBe(true);
    expect(await verifyStatement(k.publicJwk, { ...allocation, statement: { ...allocation.statement, sequence: 2 } })).toBe(false);
    const other = await generateSigningKey();
    expect(await verifyStatement(other.publicJwk, allocation)).toBe(false);
  });
});
