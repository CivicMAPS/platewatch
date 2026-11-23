/**
 * Vehicle details in the structure infringement issuance requires (owner direction 23/11/2026):
 * Licence plate, Registration type, Make, Type, Colour — and the second entry of the licence
 * plate, made after the other details and checked against the first.
 */
import { normalisePlate } from './plate';
import type { VehicleDetails } from './types';

/** Registration type (fixed list, permit schema / infringement structure). */
export const REGISTRATION_TYPES = [
  ['private', 'Private'],
  ['commercial', 'Commercial'],
  ['company', 'Company'],
  ['lease', 'Lease'],
  ['diplomatic', 'Diplomatic'],
  ['other', 'Other'],
] as const;

/** Vehicle type (body type), fixed list for real use. */
export const VEHICLE_TYPES = [
  ['sedan', 'Sedan'],
  ['hatchback', 'Hatchback'],
  ['suv', 'SUV'],
  ['wagon', 'Wagon'],
  ['coupe', 'Coupe'],
  ['convertible', 'Convertible'],
  ['ute', 'Ute'],
  ['van', 'Van'],
  ['people_mover', 'People mover'],
  ['light_truck', 'Light truck'],
  ['truck', 'Truck'],
  ['bus', 'Bus'],
  ['motorcycle', 'Motorcycle'],
  ['scooter', 'Scooter'],
  ['other', 'Other'],
] as const;

export const REGISTRATION_STATES = ['VIC', 'NSW', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'] as const;

const codeOf = (list: readonly (readonly [string, string])[], v: string | undefined): string | null => {
  const x = (v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!x) return '';
  return list.find(([c, l]) => c === x || l.toLowerCase().replace(/\s+/g, '_') === x)?.[0] ?? null;
};

/** Registration type code for a value (code or label, any case); '' when blank; null when not on the list. */
export const registrationTypeCode = (v: string | undefined) => codeOf(REGISTRATION_TYPES, v);
/** Vehicle type code for a value; '' when blank; null when not on the list. */
export const vehicleTypeCode = (v: string | undefined) => codeOf(VEHICLE_TYPES, v);
export const registrationTypeLabel = (c: string) => REGISTRATION_TYPES.find(([k]) => k === c)?.[1] ?? c;
export const vehicleTypeLabel = (c: string) => VEHICLE_TYPES.find(([k]) => k === c)?.[1] ?? c;

export const VEHICLE_MAKES = [
  'Toyota', 'Mazda', 'Ford', 'Hyundai', 'Kia', 'Mitsubishi', 'Nissan', 'Holden', 'Volkswagen', 'Subaru',
  'Honda', 'Tesla', 'BYD', 'MG', 'GWM', 'Isuzu', 'Suzuki', 'BMW', 'Mercedes-Benz', 'Audi', 'Lexus', 'Jeep',
  'Land Rover', 'Volvo', 'Peugeot', 'Renault', 'Skoda', 'LDV', 'Chery', 'Porsche', 'Ram', 'Chevrolet',
];
export const COLOURS = [
  'White', 'Black', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Yellow', 'Orange', 'Brown', 'Gold', 'Beige',
  'Purple', 'Maroon', 'Other',
];

export const EMPTY_VEHICLE: VehicleDetails = { registrationType: '', make: '', bodyType: '', colour: '', registrationState: 'VIC' };

/** The vehicle details held on a hot-list or permit entry (missing fields empty). */
export function vehicleOf(e: Partial<VehicleDetails>): VehicleDetails {
  return { registrationType: e.registrationType ?? '', make: e.make ?? '', bodyType: e.bodyType ?? '', colour: e.colour ?? '', registrationState: e.registrationState || 'VIC' };
}

export function hasVehicle(v: Partial<VehicleDetails>): boolean {
  return !!(v.registrationType || v.make || v.bodyType || v.colour);
}

/** All four details entered (required before the plate is entered again at issue). */
export function vehicleComplete(v: VehicleDetails): boolean {
  return !!(v.registrationType.trim() && v.make.trim() && v.bodyType.trim() && v.colour.trim());
}

/** "Colour Make Type · Registration type · State", for display. */
export function describeVehicle(v: Partial<VehicleDetails>): string {
  const main = [v.colour, v.make, v.bodyType ? vehicleTypeLabel(v.bodyType) : ''].filter((x) => x?.trim()).join(' ');
  return [main, v.registrationType ? registrationTypeLabel(v.registrationType) : '', v.registrationState && v.registrationState !== 'VIC' ? v.registrationState : ''].filter(Boolean).join(' · ');
}

/** Trimmed details, empty fields left out (for storage on allow entries). */
export function compactVehicle(v: Partial<VehicleDetails>): Partial<VehicleDetails> {
  const out: Partial<VehicleDetails> = {};
  for (const k of ['registrationType', 'make', 'bodyType', 'colour', 'registrationState'] as const) {
    const x = v[k]?.trim();
    if (x) out[k] = x;
  }
  return out;
}

/**
 * Second entry of the licence plate: compared with the first exactly (spaces and case ignored,
 * no look-alike tolerance). `mismatch` is flagged and blocks issue until corrected.
 */
export function plateReentry(first: string, second: string): 'pending' | 'match' | 'mismatch' {
  const b = normalisePlate(second);
  if (!b) return 'pending';
  return normalisePlate(first) === b ? 'match' : 'mismatch';
}
