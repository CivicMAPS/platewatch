import { plateKey } from '../src/lib/plate';
import type { AllowList, HotList, TimedList, TimedRestriction } from '../src/lib/types';

/** Local Melbourne time helper (TZ is pinned in vite.config.ts test.env). */
export const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

export const r2P = (patch: Partial<TimedRestriction> = {}): TimedRestriction => ({
  id: 'r-2p',
  code: '2P',
  limitMinutes: 120,
  graceMinutes: 0,
  days: [1, 2, 3, 4, 5],
  startTime: '08:00',
  endTime: '18:00',
  allDay: false,
  description: '',
  ...patch,
});

export const timed = (patch: Partial<TimedList> = {}): TimedList => ({
  id: 'timed-1',
  type: 'timed',
  name: 'Smith St 2P',
  notes: '',
  createdAt: 0,
  updatedAt: 0,
  segment: { street: 'Smith Street', fromStreet: 'Johnston St', toStreet: 'Gertrude St', side: 'both', suburb: 'Fitzroy' },
  restrictions: [r2P()],
  allowListIds: ['allow-1'],
  ...patch,
});

export const allow = (plates: string[], patch: Partial<AllowList> = {}): AllowList => ({
  id: 'allow-1',
  type: 'allow',
  name: 'Zone 12 residents',
  notes: '',
  createdAt: 0,
  updatedAt: 0,
  entries: plates.map((p, i) => ({
    id: `a${i}`,
    plate: p,
    key: plateKey(p),
    label: `Resident ${i}`,
    permitNo: `P${i}`,
    validFrom: '',
    validTo: '',
    addedAt: 0,
  })),
  ...patch,
});

export const hot = (plates: string[], patch: Partial<HotList> = {}): HotList => ({
  id: 'hot-1',
  type: 'hot',
  name: 'Officer safety',
  notes: '',
  createdAt: 0,
  updatedAt: 0,
  entries: plates.map((p, i) => ({
    id: `h${i}`,
    plate: p,
    key: plateKey(p),
    risks: ['aggressive', 'spitting'],
    riskLevel: 'high',
    make: 'Toyota',
    model: 'Corolla',
    bodyType: 'Wagon',
    colour: 'Blue',
    notes: '',
    addedAt: 0,
  })),
  ...patch,
});
