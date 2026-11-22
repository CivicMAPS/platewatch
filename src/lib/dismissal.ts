/**
 * Officer decisions after a vehicle check: dismissing an overstay alert with a reason, and the
 * plate tags (known disability / emergency vehicles) a dismissal leaves behind.
 *
 * A disability permit and an emergency services vehicle are not tied to a plate, so the
 * officer confirms them by looking at the vehicle. The tag only prompts that check on later days:
 *   Confirmed → tag kept, scan recorded, no timer.
 *   Dismiss   → not confirmed at the vehicle check, tag removed, scan recorded, timer applied.
 */
import type { PermitStatus } from './engine';
import { localDateString } from './time';
import type { DismissReason, Observation, PlateFlag, PlateFlagKind, ScanRecord } from './types';
import { plateKey } from './plate';

export const DISMISS_REASONS: readonly { reason: DismissReason; label: string; hint: string; flag?: PlateFlagKind }[] = [
  { reason: 'disability_permit', label: 'Disability permit displayed', hint: 'Plate is tagged: from tomorrow each scan asks you to check for a displayed permit.', flag: 'disability' },
  { reason: 'emergency_vehicle', label: 'Emergency services vehicle', hint: 'Plate is tagged: from tomorrow each scan asks you to check the vehicle.', flag: 'emergency' },
  { reason: 'permit_displayed', label: 'Permit displayed', hint: 'A resident permit displayed on the vehicle (not every permit is digital yet). No tag.' },
];

export const DISMISS_LABEL: Record<DismissReason, string> = Object.fromEntries(DISMISS_REASONS.map((r) => [r.reason, r.label])) as Record<DismissReason, string>;

/** The on-screen message when a tagged plate is scanned on a later day. */
export const FLAG_MESSAGE: Record<PlateFlagKind, string> = {
  emergency: 'Known emergency services vehicle — check vehicle',
  disability: 'Previous disability permit vehicle — check vehicle for displayed permit',
};

export const FLAG_LABEL: Record<PlateFlagKind, string> = {
  emergency: 'Emergency services vehicle',
  disability: 'Disability permit vehicle',
};

export const PERMIT_STATUS_TEXT: Record<PermitStatus, string> = {
  ACTIVE_IN_AREA: 'Active · applies here',
  ACTIVE_NOT_IN_AREA: 'Active · for another area or street',
  ACTIVE_SCOPE_UNKNOWN: 'Active · area not held — check where it applies',
  NOT_ACTIVE_EXPIRED: 'Expired',
  NOT_YET_ACTIVE: 'Not yet valid',
};

/**
 * Dismiss an overstay alert: the scan keeps the reason, the timing closes as dismissed (so the
 * plate is not re-alerted this restriction period), and a disability / emergency reason tags the
 * plate, confirmed for today.
 */
export function applyDismissal(args: { scan: ScanRecord; observation: Observation; reason: DismissReason; at: number }): {
  scan: ScanRecord;
  observation: Observation;
  flag?: PlateFlag;
} {
  const { scan, observation, reason, at } = args;
  const kind = DISMISS_REASONS.find((r) => r.reason === reason)?.flag;
  return {
    scan: { ...scan, alertDismissal: { reason, at } },
    observation: { ...observation, status: 'dismissed', dismissReason: reason, closedAt: at },
    ...(kind
      ? { flag: { key: plateKey(scan.plate), plate: scan.plate, kind, createdAt: at, sourceScanId: scan.id, confirmedDay: localDateString(scan.meta.capturedAt) } }
      : {}),
  };
}

/** Tag after the officer confirmed the vehicle on a later day. */
export function confirmFlag(flag: PlateFlag, capturedAt: number): PlateFlag {
  return { ...flag, confirmedDay: localDateString(capturedAt) };
}
