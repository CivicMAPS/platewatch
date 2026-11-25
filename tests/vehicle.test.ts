import { describe, expect, it } from 'vitest';
import { compactVehicle, describeVehicle, plateReentry, vehicleComplete, vehicleOf } from '../src/lib/vehicle';

describe('vehicle details (infringement structure)', () => {
  it('requires registration type, make, type and colour before the plate is entered again', () => {
    expect(vehicleComplete({ registrationType: 'Standard', make: 'Holden', bodyType: 'Hatchback', colour: 'White' })).toBe(true);
    expect(vehicleComplete({ registrationType: '', make: 'Holden', bodyType: 'Hatchback', colour: 'White' })).toBe(false);
  });

  it('checks the second licence plate entry exactly against the first (no look-alike tolerance)', () => {
    expect(plateReentry('DTS512', '')).toBe('pending');
    expect(plateReentry('DTS512', 'dts 512')).toBe('match');
    expect(plateReentry('DTS512', 'DT5512')).toBe('mismatch');
  });

  it('describes and stores the details', () => {
    expect(describeVehicle({ registrationType: 'private', make: 'Holden', bodyType: 'hatchback', colour: 'White' })).toBe('White Holden Hatchback · Private');
    expect(describeVehicle({ registrationType: 'commercial', make: 'Isuzu', bodyType: 'light_truck', colour: 'White', registrationState: 'NSW' })).toBe('White Isuzu Light truck · Commercial · NSW');
    expect(compactVehicle({ make: ' Holden ', colour: '' })).toEqual({ make: 'Holden' });
    expect(vehicleOf({ make: 'Holden' })).toEqual({ registrationType: '', make: 'Holden', bodyType: '', colour: '', registrationState: 'VIC' });
  });
});
