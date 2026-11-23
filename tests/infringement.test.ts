import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { newObservation } from '../src/lib/engine';
import { applyInfringementResult, buildHandoff, formatInfringementNumber } from '../src/lib/infringement';
import { offenceFor } from '../src/lib/offence';
import type { Observation, ScanRecord } from '../src/lib/types';
import { at, r2P, timed } from './fixtures';

const schema = JSON.parse(readFileSync(new URL('../schemas/platewatch-infringement-handoff.v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const errors = (d: unknown) => (ajv.validate(schema, d) ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath} ${e.message}`));

const t = (h: number, m = 0, s = 0) => at(2026, 11, 21, h, m, s);
const list = timed({
  displayId: 'com-20055',
  segment: { street: 'Little Bourke Street', fromStreet: 'Swanston Street', toStreet: 'Elizabeth Street', side: 'south', suburb: 'Melbourne' },
  restrictions: [r2P({ description: 'Meter' })],
});
const loc = { latitude: -37.81277, longitude: 144.96443, accuracy: 4, altitude: null, altitudeAccuracy: null, heading: null, speed: null, timestamp: 0 };
const scan = (id: string, capturedAt: number, patch: Partial<ScanRecord> = {}): ScanRecord =>
  ({
    id, listId: list.id, observationId: 'o1', plate: 'DTS512', key: 'DTS512', ocrText: 'DTS512', ocrConfidence: 90, corrected: false, outcome: 'recorded',
    meta: { capturedAt, capturedAtLocal: '', timeZone: 'Australia/Melbourne', location: loc, locationAgeMs: 0, userAgent: 't', payment: { parkingArea: '645', easyPark: ['7514'], payStay: [] } },
    image: new Blob(), thumb: new Blob(), sha256: 'a'.repeat(64), createdAt: capturedAt, ...patch,
  }) as ScanRecord;
const first = scan('s1', t(8, 20, 5), { payment: { status: 'paid', source: 'easypark', sourceRef: '7514', paidFrom: t(8, 18), paidTo: t(10, 45), checkedAt: t(8, 21, 2), checkedBy: '4471' } });
const current = scan('s2', t(10, 41, 7), { outcome: 'overstay' });
const obs: Observation = {
  ...newObservation({ id: 'o1', list, plate: 'DTS512', scanId: 's1', at: t(8, 20, 5), instance: { restriction: list.restrictions[0]!, start: t(7), end: t(22) } }),
  scanCount: 2, payment: { status: 'paid', paidTo: t(10, 45) },
};

describe('infringement hand-off payload (WF-S31, requirements §10)', () => {
  const offer = offenceFor(obs, current.meta.capturedAt)!;
  const handoff = buildHandoff({ handoffId: '6f1c2a9e-0b7d-4d43-9a51-2f4b8c1e7d20', list, observation: obs, scan: current, firstScan: first, offer, officerNumber: '4471', device: 'test' });

  it('validates against the requirements JSON Schema', () => {
    expect(errors(handoff)).toEqual([]);
  });

  it('pre-fills the S31 scenario: 701, time from = first sighting, payment from the first scan, two evidence images', () => {
    expect(handoff).toMatchObject({
      location: { displayId: 'com-20055', street: 'Little Bourke Street', side: 'south', parkingArea: '645', easyPark: ['7514'] },
      vehicle: { registration: 'DTS512', plateCheckedOnVehicle: false },
      offence: { suggestedCode: '701', basis: 'allowance_exceeded', restrictionCode: '2P', spaceType: 'meter', limitMinutes: 120 },
      payment: { status: 'paid', source: 'easypark', sourceRef: '7514', checkedBy: '4471' },
    });
    expect(handoff.times.timeFrom).toMatch(/T08:20:05\.000[+-]\d{2}:\d{2}$/);
    expect(handoff.times.timeTo).toMatch(/T10:41:07\.000/);
    expect((handoff.evidence as { role: string }[]).map((e) => e.role)).toEqual(['first_sighting', 'current_scan']);
    expect(handoff.notesTemplate).toBe('First sighted 08:20:05, re-sighted 10:41:07, 2P allowance exceeded by 21m 02s. Paid to 10:45:00 (EasyPark 7514).');
  });

  it('702 no payment: time from = first scan; note names where it was checked', () => {
    const o702: Observation = { ...obs, scanCount: 1, payment: { status: 'not_found' } };
    const f = scan('s1', t(8, 20, 5), { payment: { status: 'not_found', source: 'easypark', sourceRef: '7514', checkedAt: t(8, 21), checkedBy: '4471' } });
    const h = buildHandoff({ handoffId: '6f1c2a9e-0b7d-4d43-9a51-2f4b8c1e7d21', list, observation: o702, scan: f, offer: offenceFor(o702, t(8, 20, 5))!, officerNumber: '4471', device: 'test' });
    expect(errors(h)).toEqual([]);
    expect(h.offence).toMatchObject({ suggestedCode: '702', basis: 'no_payment_found' });
    expect(h.notesTemplate).toBe('No paid session found at 08:20:05 (EasyPark 7514 checked).');
  });

  it('carries the look-alike the officer acted on (the wizard then asks for the plate check, OQ28-6)', () => {
    const linked = { ...current, plate: '1UP6YF', lookalikes: [{ readAs: '1UP6YF', candidatePlate: '1UR6YF', source: 'timed' as const, candidateId: 'o1', choice: 'same' as const, decidedAt: t(10, 41, 30) }] };
    const h = buildHandoff({ handoffId: '6f1c2a9e-0b7d-4d43-9a51-2f4b8c1e7d22', list, observation: obs, scan: linked, firstScan: first, offer, officerNumber: '4471', device: 'test' });
    expect(errors(h)).toEqual([]);
    expect(h.vehicle).toMatchObject({ registration: '1UP6YF', lookalike: { readAs: '1UP6YF', candidatePlate: '1UR6YF', choice: 'same' } });
    expect(h.notesTemplate).toContain('Plate read as 1UP6YF; linked to timing for 1UR6YF by officer at 10:41:30.');
  });

  it('stores the issued infringement back and closes the timing as issued (requirements §11)', () => {
    const out = applyInfringementResult({ scan: current, observation: obs, handoff, result: { status: 'issued', number: '04471261121001836393', issuedAt: t(10, 45), offenceCode: '701' } });
    expect(out.scan.infringement).toMatchObject({ status: 'issued', number: '04471261121001836393', offenceCode: '701', offenceOverridden: false, sync: 'pending', pinSource: 'device', officerNumber: '4471' });
    expect(out.observation).toMatchObject({ status: 'issued', closedAt: t(10, 45) });
    expect(formatInfringementNumber('04471261121001836393')).toBe('04471 261121 001 8363 93');
  });

  it('a cancelled wizard keeps the timing running; an override is recorded', () => {
    const c = applyInfringementResult({ scan: current, observation: obs, handoff, result: { status: 'cancelled', number: '04471261121002899513' } });
    expect(c.scan.infringement?.status).toBe('cancelled');
    expect(c.observation.status).toBe('active');
    const o = applyInfringementResult({ scan: current, observation: obs, handoff, result: { status: 'issued', number: '04471261121001836393', offenceCode: '702', issuedAt: 1 } });
    expect(o.scan.infringement?.offenceOverridden).toBe(true);
  });
});
