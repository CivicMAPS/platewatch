/**
 * Issue Infringement hand-off (WF-S31, `PlateWatch - Issue Infringement Requirements`). PlateWatch
 * is the entry point: it builds a pre-fill payload from the sighting and hands it to the
 * EnforcementMAPS wizard, which allocates the infringement number on the handset, takes the officer
 * through the four steps and issues. PlateWatch stores the result back. Nothing is issued from an
 * OCR read alone (IR-1); the development build has no wizard and hides Issue (IR-3).
 */
export interface InfringementHandoff {
  schemaVersion: '1.0';
  handoffId: string;
  source: 'platewatch';
  officerNumber: string;
  device?: string;
  location: Record<string, unknown>;
  vehicle: Record<string, unknown>;
  offence: Record<string, unknown>;
  times: Record<string, unknown>;
  payment?: Record<string, unknown>;
  evidence: Record<string, unknown>[];
  notesTemplate?: string;
  sighting: Record<string, unknown>;
}

/** What the wizard returns (requirements §11). */
export interface InfringementResult {
  status: 'issued' | 'cancelled';
  number?: string;
  offenceCode?: string;
  timeFrom?: number;
  timeTo?: number;
  issuedAt?: number;
  sync?: 'pending' | 'synced' | 'rejected';
}
