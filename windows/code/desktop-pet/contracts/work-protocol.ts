import type { WorkProtocol, WorkReceipt, WorkRequest } from './perception.js';

export interface WorkProtocolProfile {
  readonly executorId: string;
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly trustedToolPolicies?: Readonly<Record<string, { readonly readOnly: boolean; readonly requiredGrant?: string }>>;
}

export interface WorkProtocolProfiles {
  readonly revision: number;
  readonly acp?: WorkProtocolProfile;
  readonly mcp?: WorkProtocolProfile;
}

export interface WorkProtocolProfileView extends Omit<WorkProtocolProfile, 'env'> {
  readonly environmentKeys: readonly string[];
}
export interface WorkProtocolProfilesView {
  readonly revision: number;
  readonly acp?: WorkProtocolProfileView;
  readonly mcp?: WorkProtocolProfileView;
}

export interface WorkProtocolTool {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly requiredGrant?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface WorkProtocolRecord {
  readonly request: WorkRequest;
  readonly receipt?: WorkReceipt;
  readonly dispatchStarted: boolean;
  readonly eventPublished: boolean;
  readonly forgotten: boolean;
}

export interface WorkProtocolManagement {
  snapshot(): { readonly profiles: WorkProtocolProfilesView; readonly requests: readonly WorkProtocolRecord[] };
  saveProfiles(expectedRevision: number, profiles: unknown): Promise<WorkProtocolProfilesView>;
  listTools(): Promise<readonly WorkProtocolTool[]>;
  prepare(input: Omit<WorkRequest, 'operationId' | 'revision' | 'requestedAt' | 'executorRevision'>): WorkRequest;
  revise(operationId: string, expectedRevision: number,
    updates: Partial<Omit<WorkRequest, 'operationId' | 'revision' | 'requestedAt'>>): WorkRequest;
  confirm(operationId: string, expectedRevision: number): Promise<WorkReceipt>;
  cancel(operationId: string, expectedRevision: number): Promise<WorkReceipt>;
  forget(operationId: string): void;
  close(): Promise<void>;
}

export type ConfigurableWorkProtocol = Extract<WorkProtocol, 'acp' | 'mcp'>;
