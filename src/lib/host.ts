/**
 * The EnforcementMAPS host bridge. Standalone PlateWatch has no server and no sign-in
 * (`docs/LIST-RULES.md`); inside EnforcementMAPS the host supplies `window.EnforcementMAPS` with
 * the officer identity, the CommandMAPS alert transport (WF-S29) and the Issue Infringement wizard
 * (WF-S31). When it is absent (the development build) alerts stay queued on the device and Issue
 * infringement is hidden.
 */
import type { HotListEvent } from './types';
import type { InfringementHandoff, InfringementResult } from './infringement';

export interface EnforcementMapsHost {
  /** Officer number from the operating context. */
  officerNumber?: string;
  /** Raise the soft Code 1 (hot-list sighting) with dispatch and the compliance coordinator. */
  sendHotListAlert?(event: HotListEvent): Promise<{ sentAt: number }>;
  /** Open the Issue Infringement wizard pre-filled from the sighting; resolves when issued or cancelled. */
  startInfringement?(handoff: InfringementHandoff): Promise<InfringementResult>;
}

declare global {
  interface Window {
    EnforcementMAPS?: EnforcementMapsHost;
  }
}

export function host(): EnforcementMapsHost | undefined {
  return typeof window === 'undefined' ? undefined : window.EnforcementMAPS;
}

/** Officer number: EnforcementMAPS operating context first, else the development-build setting. */
export function officerNumber(setting: string): string {
  return host()?.officerNumber?.trim() || setting.trim();
}
