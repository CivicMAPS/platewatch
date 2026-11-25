/**
 * The EnforcementMAPS host bridge. Standalone PlateWatch has no server and no sign-in
 * (`docs/LIST-RULES.md`); inside EnforcementMAPS the host supplies `window.EnforcementMAPS` with
 * the officer identity, the CommandMAPS alert transport and the Issue Infringement wizard (WF-S31).
 * With the PlateWatch backend configured (development / field testing) `src/lib/backend.ts`
 * provides the same contract. When it is absent the officer-safety pop-up still blocks and logs
 * on the device, and tells the officer to use the radio.
 */
import type { HotHitPayload } from './types';
import type { InfringementHandoff, InfringementResult } from './infringement';

export interface HotHitAnswer {
  response: 'safe_clear' | 'code1';
  note?: string;
  at: number;
  officerNumber: string;
  location: HotHitPayload['location'];
}

/** An alert as the handset sees it (soft Code 1 or Code 1). */
export interface LiveAlert {
  id: string;
  kind: 'soft_code1' | 'code1';
  status: 'active' | 'radio_requested' | 'resolved' | 'escalated' | 'acknowledged' | 'cleared' | 'cancelled';
  cause: string;
  officerNumber: string;
  officerName: string | null;
  team: string | null;
  raisedAt: number;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  closedAt: number | null;
  outcome: string | null;
  escalatedTo: string | null;
  location: { lat: number; lng: number; accuracyM?: number | null; at?: number | null } | null;
  hit: { plate: string; entry: Record<string, unknown> } | null;
  /** Branch Code 1 only: this handset has silenced the alarm. */
  received?: boolean;
}

/** "More information" on the pop-up (all officers' history for the plate). */
export interface HotProfile {
  plate: string;
  entry: Record<string, unknown>;
  history: { at: number; officerNumber: string; location: { lat: number; lng: number } | null; where: string | null; response: string | null; note: string | null; alerts: { kind: string; status: string; outcome: string | null }[] }[];
  interactions: { at: number; officerNumber: string; note: string }[];
  knownLocations: { label: string; lat: number | null; lng: number | null; count: number; lastAt: number }[];
}

export interface EnforcementMapsHost {
  /** Officer number from the operating context. */
  officerNumber?: string;
  /** Report a hot-list hit at once (the pop-up is open; the deadline runs). Retried until it resolves. */
  reportHotHit?(hit: HotHitPayload): Promise<void>;
  /** The officer's answer to a hit (SAFE & CLEAR or CODE 1, note, time, location). Retried until it resolves. */
  reportHotHitResponse?(hit: HotHitPayload, answer: HotHitAnswer): Promise<void>;
  /** The pop-up was not acknowledged in time: soft Code 1 to dispatch and the team supervisor. */
  raiseSoftCode1?(args: { hit: HotHitPayload; at: number; location: HotHitPayload['location'] }): Promise<{ id: string | null }>;
  /** Code 1 (duress), from the pop-up or elsewhere. */
  raiseCode1?(args: { id: string; hit?: HotHitPayload; cause: string; at: number; location: HotHitPayload['location']; officerNumber?: string }): Promise<{ id: string }>;
  /** `officerNumber`: the officer who raised it (may have been typed on the pop-up and not yet saved). */
  code1Location?(id: string, location: NonNullable<HotHitPayload['location']> & { at: number }, officerNumber?: string): Promise<void>;
  cancelCode1?(id: string, reason: string, officerNumber?: string): Promise<void>;
  /** This officer's open alerts and the branch's Code 1s. */
  liveAlerts?(): Promise<{ own: LiveAlert[]; branch_code1: LiveAlert[] }>;
  /** The officer silenced a branch Code 1 alarm. */
  receiveCode1?(id: string): Promise<void>;
  hotProfile?(plate: string, entryId: string): Promise<HotProfile>;
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
