/** Identity carried by records and work tickets. Product admission is narrower than storage identity. */
export type CharacterId = string;
export const COMPANION_ID = 'companion' as const;
export const COMPANION_LABEL = '青梅竹马' as const;
export const PRODUCT_CHARACTERS = Object.freeze([{ id: COMPANION_ID, label: COMPANION_LABEL }]);
/** Validate opaque identity syntax without substituting the currently active product identity. */
export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}
/** HTTP/native product entry points accept only the new companion. */
export function isProductCharacter(value: unknown): value is typeof COMPANION_ID { return value === COMPANION_ID; }

/** Fictional opening is presentation-only: never a real conversation or memory source. */
export interface CompanionIntroduction { readonly id: string; readonly text: string }
export interface CompanionProfilePort {
  introduction(): CompanionIntroduction | null;
  acknowledgeIntroduction(id: string): void;
}
