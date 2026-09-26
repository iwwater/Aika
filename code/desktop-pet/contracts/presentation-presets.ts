export interface PresentationPreset {
  readonly id: string; readonly label: string;
  readonly category: 'expression' | 'pose' | 'appearance' | 'idle';
  readonly source: 'model-expression' | 'model-motion' | 'procedural';
  readonly availability: 'automatic' | 'manual' | 'unavailable';
  readonly defaultEnabled: boolean; readonly previewable: boolean;
  readonly reason?: string; readonly expressionName?: string;
  readonly motionGroup?: string; readonly motionIndex?: number; readonly procedure?: string;
  readonly emotions?: readonly string[]; readonly gestures?: readonly string[];
}
export interface PresentationCatalog {
  readonly schemaVersion: 1; readonly modelId: string; readonly modelFingerprint: string;
  readonly items: readonly PresentationPreset[];
}
export interface PresentationPolicy {
  readonly modelId: string; readonly revision: number; readonly enabledIds: readonly string[];
}
export interface PresentationControls {
  readonly catalog: PresentationCatalog;
  snapshot(): PresentationPolicy;
  save(modelId: string, expectedRevision: number, enabledIds: unknown): Promise<PresentationPolicy>;
  allowedIntent(): { emotions: readonly string[]; gestures: readonly string[]; presets: readonly { id: string; label: string }[] };
}
