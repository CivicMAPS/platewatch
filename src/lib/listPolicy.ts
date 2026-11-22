/**
 * Who may import, create, edit and delete lists, and where.
 *
 * Owner decisions (WF-S26 OQ26-5, 23/11/2026) and the CivicMAPS integration brief:
 *
 * - **Development (this build).** Importing and editing of *all* lists is possible from within
 *   PlateWatch, so data can be loaded, corrected and field-tested on the device.
 *
 * - **EnforcementMAPS (once integrated).**
 *   - Importing lists is a **CommandMAPS** dashboard feature, restricted to team leaders and
 *     parking services management who hold the import authorisation. Nothing is imported on the
 *     officer's device.
 *   - Lists imported or created in CommandMAPS arrive as `system` lists. Their settings cannot be
 *     edited (or the list deleted) from EnforcementMAPS: the list shows a `SYSTEM` tag, not ✎.
 *   - Parking enforcement officers may create **daily digital chalking lists**: timed lists for
 *     street segments with time restrictions that are not linked to paid parking. An officer may
 *     edit their own list, and it lasts for that day only.
 *
 * The rules are pure functions over an explicit context so they can be tested and so the
 * EnforcementMAPS shell can supply the real role and authorisation later.
 */
import { localDateString } from './time';
import type { ListOrigin, ListType, PlateList } from './types';

export type DeploymentMode = 'development' | 'enforcementmaps';

/** CivicMAPS roles that matter for lists. */
export type ListRole = 'officer' | 'team_leader' | 'parking_services_manager';

export interface PolicyContext {
  mode: DeploymentMode;
  /** The signed-in user's role (from the EnforcementMAPS operating context; unknown standalone). */
  role?: ListRole;
}

/**
 * The build's deployment mode. Development unless the build sets
 * `VITE_PLATEWATCH_MODE=enforcementmaps`; any other value falls back to development so a typo can
 * never lock officers out of their lists during field testing.
 */
export function deploymentMode(env: Record<string, unknown> = import.meta.env ?? {}): DeploymentMode {
  return env.VITE_PLATEWATCH_MODE === 'enforcementmaps' ? 'enforcementmaps' : 'development';
}

export function policyContext(): PolicyContext {
  return { mode: deploymentMode(), role: deploymentMode() === 'enforcementmaps' ? 'officer' : undefined };
}

export const isDevelopment = (ctx: PolicyContext): boolean => ctx.mode === 'development';

/** A list's origin; lists saved before provenance existed count as the officer's own. */
export function listOrigin(list: Pick<PlateList, 'source'>): ListOrigin {
  return list.source?.origin ?? 'officer';
}

/* ───────────────────────────── Import ───────────────────────────── */

/** Importing from a file inside the PlateWatch / EnforcementMAPS app. */
export function canImportOnDevice(ctx: PolicyContext): boolean {
  return isDevelopment(ctx);
}

/**
 * Importing in the CommandMAPS dashboard (the rule CommandMAPS must enforce; kept here so both
 * sides share one definition): team leaders and parking services management, with authorisation.
 */
export function canImportInCommandMaps(role: ListRole | undefined, authorised: boolean): boolean {
  return authorised && (role === 'team_leader' || role === 'parking_services_manager');
}

/* ───────────────────────────── Create ───────────────────────────── */

/** List types the user may create on the device. */
export function creatableListTypes(ctx: PolicyContext): ListType[] {
  if (isDevelopment(ctx)) return ['timed', 'hot', 'allow'];
  // Officers create daily digital chalking lists only (timed segments).
  return ctx.role === 'officer' ? ['timed'] : [];
}

/**
 * Whether a list being created or edited on the device may carry paid-parking details
 * (parking area, EasyPark, PayStay, meters). Officer chalking lists are for segments that are
 * not linked to paid parking.
 */
export function allowsPaidParking(list: Pick<PlateList, 'source'> | null, ctx: PolicyContext): boolean {
  if (isDevelopment(ctx)) return true;
  return !!list && listOrigin(list) === 'system';
}

/* ───────────────────────────── Edit / delete ───────────────────────────── */

/** True once an officer list's day has passed (EnforcementMAPS only; boundary = local midnight). */
export function isExpired(list: Pick<PlateList, 'source'>, ctx: PolicyContext, now = Date.now()): boolean {
  if (isDevelopment(ctx) || listOrigin(list) !== 'officer') return false;
  const day = list.source?.serviceDay;
  return !!day && day < localDateString(now);
}

export type LockReason = 'system' | 'expired' | null;

export interface ListPermissions {
  origin: ListOrigin;
  edit: boolean;
  delete: boolean;
  /** Why editing is not allowed, for the read-only notice. */
  locked: LockReason;
  /** In development, a system list stays editable here although EnforcementMAPS will lock it. */
  devOverride: boolean;
}

export function listPermissions(list: Pick<PlateList, 'source'>, ctx: PolicyContext, now = Date.now()): ListPermissions {
  const origin = listOrigin(list);
  if (isDevelopment(ctx)) return { origin, edit: true, delete: true, locked: null, devOverride: origin === 'system' };
  if (origin === 'system') return { origin, edit: false, delete: false, locked: 'system', devOverride: false };
  if (isExpired(list, ctx, now)) return { origin, edit: false, delete: false, locked: 'expired', devOverride: false };
  return { origin, edit: true, delete: true, locked: null, devOverride: false };
}

/** Lists shown for patrol: expired officer lists drop out in EnforcementMAPS; nothing is hidden in development. */
export function isActiveList(list: Pick<PlateList, 'source'>, ctx: PolicyContext, now = Date.now()): boolean {
  return !isExpired(list, ctx, now);
}

/* ───────────────────────────── Provenance stamps ───────────────────────────── */

/** Source for a list created on the device by the officer. */
export function officerSource(now = Date.now()): NonNullable<PlateList['source']> {
  return { origin: 'officer', serviceDay: localDateString(now) };
}

/** Source for a list created or updated by an import. */
export function systemSource(importedFrom: string, now = Date.now()): NonNullable<PlateList['source']> {
  return { origin: 'system', importedFrom, importedAt: now };
}
