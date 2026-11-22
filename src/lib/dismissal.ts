/**
 * Officer decisions after a vehicle check: dismissing an overstay alert with a reason, and the
 * plate tags (known disability / emergency vehicles) a dismissal leaves behind.
 *
 * A disability permit and an emergency services vehicle are not tied to a plate, so the
 * officer confirms them by looking at the vehicle. The tag only prompts that check on later days:
 *   Confirmed → tag kept, scan recorded; emergency: no timer; disability: timed against twice the
 *               allowance (the prescribed time in disability-only spaces).
 *   Dismiss   → not confirmed at the vehicle check, tag removed, scan recorded, timer applied.
 *
 * A disability permit doubles the allowance in timed and paid + timed spaces. Dismissing an
 * overstay for one therefore re-times the vehicle against 2 × the allowance rather than closing
 * the timing; if it is over even that, the overstay stands.
 */
import { disabilityDoubles, isDisabilityOnlyRestriction, withDisabilityConcession, type PermitStatus } from './engine';
import { localDateString } from './time';
import type { DismissReason, Observation, PlateFlag, PlateFlagKind, ScanRecord } from './types';
import { plateKey } from './plate';

export const DISMISS_REASONS: readonly { reason: DismissReason; label: string; hint: string; flag?: PlateFlagKind }[] = [
  { reason: 'disability_permit', label: 'Disability permit displayed', hint: 'Allowance doubled; timing continues. Plate is tagged: from tomorrow each scan asks you to check for a displayed permit.', flag: 'disability' },
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

/** Why "Disability permit displayed" cannot clear this overstay, or null when it can. */
export function disabilityBlocked(observation: Observation, capturedAt: number, description = ''): 'disability_only' | 'not_eligible' | 'over_double' | null {
  if (observation.concession) return 'over_double';
  if (!disabilityDoubles(observation.restrictionCode, description)) return isDisabilityOnlyRestriction(observation.restrictionCode, description) ? 'disability_only' : 'not_eligible';
  const doubled = withDisabilityConcession(observation);
  return capturedAt - doubled.startedAt >= (doubled.limitMinutes + doubled.graceMinutes) * 60_000 ? 'over_double' : null;
}

export const DISABILITY_BLOCKED_TEXT: Record<NonNullable<ReturnType<typeof disabilityBlocked>>, string> = {
  disability_only: 'Disability-only space: the prescribed time applies, the permit does not extend it.',
  not_eligible: 'A disability permit does not apply in this restriction.',
  over_double: 'Over twice the allowance: the overstay stands even with a disability permit.',
};

/**
 * Dismiss an overstay alert. The scan keeps the reason; a disability / emergency reason tags the
 * plate, confirmed for today.
 * - Disability permit displayed: the timing continues against twice the allowance.
 * - Emergency vehicle / permit displayed: the timing closes as dismissed, so the plate is not
 *   re-alerted this restriction period.
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
    observation:
      reason === 'disability_permit'
        ? withDisabilityConcession(observation)
        : { ...observation, status: 'dismissed', dismissReason: reason, closedAt: at },
    ...(kind
      ? { flag: { key: plateKey(scan.plate), plate: scan.plate, kind, createdAt: at, sourceScanId: scan.id, confirmedDay: localDateString(scan.meta.capturedAt) } }
      : {}),
  };
}

/** Tag after the officer confirmed the vehicle on a later day. */
export function confirmFlag(flag: PlateFlag, capturedAt: number): PlateFlag {
  return { ...flag, confirmedDay: localDateString(capturedAt) };
}
