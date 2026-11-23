/**
 * Vehicle details in the structure infringement issuance requires (owner direction 23/11/2026):
 * Licence plate, Registration type, Make, Type, Colour — and the second entry of the licence
 * plate, made after the other details and checked against the first.
 */
import { normalisePlate } from './plate';
import type { VehicleDetails } from './types';

/**
 * Suggestions for Registration type. Not a fixed list: the values the council's infringement
 * system accepts are still to be confirmed, so the field takes any text.
 */
export const REGISTRATION_TYPE_SUGGESTIONS = ['Standard', 'Custom / personalised', 'Commercial', 'Heavy vehicle', 'Motorcycle', 'Trailer', 'Interstate', 'Overseas', 'Unregistered'] as const;

export const VEHICLE_MAKES = [
  'Toyota', 'Mazda', 'Ford', 'Hyundai', 'Kia', 'Mitsubishi', 'Nissan', 'Holden', 'Volkswagen', 'Subaru',
  'Honda', 'Tesla', 'BYD', 'MG', 'GWM', 'Isuzu', 'Suzuki', 'BMW', 'Mercedes-Benz', 'Audi', 'Lexus', 'Jeep',
  'Land Rover', 'Volvo', 'Peugeot', 'Renault', 'Skoda', 'LDV', 'Chery', 'Porsche', 'Ram', 'Chevrolet',
];
/** Type (body type). */
export const BODY_TYPES = [
  'Sedan', 'Hatchback', 'Wagon', 'SUV', 'Ute', 'Van', 'Coupe', 'Convertible', 'People mover', 'Light truck',
  'Truck', 'Motorcycle', 'Other',
];
export const COLOURS = [
  'White', 'Black', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Yellow', 'Orange', 'Brown', 'Gold', 'Beige',
  'Purple', 'Maroon', 'Other',
];

export const EMPTY_VEHICLE: VehicleDetails = { registrationType: '', make: '', bodyType: '', colour: '' };

/** The vehicle details held on a hot-list or permit entry (missing fields empty). */
export function vehicleOf(e: Partial<VehicleDetails>): VehicleDetails {
  return { registrationType: e.registrationType ?? '', make: e.make ?? '', bodyType: e.bodyType ?? '', colour: e.colour ?? '' };
}

export function hasVehicle(v: Partial<VehicleDetails>): boolean {
  return !!(v.registrationType || v.make || v.bodyType || v.colour);
}

/** All four details entered (required before the plate is entered again at issue). */
export function vehicleComplete(v: VehicleDetails): boolean {
  return !!(v.registrationType.trim() && v.make.trim() && v.bodyType.trim() && v.colour.trim());
}

/** "Colour Make Type · Registration type", for display. */
export function describeVehicle(v: Partial<VehicleDetails>): string {
  const main = [v.colour, v.make, v.bodyType].filter((x) => x?.trim()).join(' ');
  return [main, v.registrationType?.trim()].filter(Boolean).join(' · ');
}

/** Trimmed details, empty fields left out (for storage on allow entries). */
export function compactVehicle(v: Partial<VehicleDetails>): Partial<VehicleDetails> {
  const out: Partial<VehicleDetails> = {};
  for (const k of ['registrationType', 'make', 'bodyType', 'colour'] as const) {
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
