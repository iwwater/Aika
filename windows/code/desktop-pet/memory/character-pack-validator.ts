// N07-01 / N07-02: Character Pack draft and evidence validator.
// Verifies schema conformity, evidence citations against real source snapshot blocks,
// status classification (explicit / inferred / disputed),
// and rejects ungrounded facts, fabricated/forged IDs, and cutoff violations.

import type {
  CharacterPackDraftPayload,
  DraftValidationResult,
  SourceBlock,
  SourceSnapshot,
} from '../contracts/character-pack.js';

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([
  '0.7-draft-1',
  '0.7.0-draft',
]);

export interface DraftValidationOptions {
  readonly cutoffPoint?: string | undefined;
  /** Set of block IDs permitted under the current cutoff point. If specified, referencing any block outside this set is a cutoff violation. */
  readonly allowedBlockIds?: ReadonlySet<string> | undefined;
}

/**
 * Validates a candidate draft payload against known source snapshots and optional cutoff constraints.
 * Ensures every fact references at least one genuine, in-bounds, pre-cutoff SourceBlock id.
 */
export function validateDraftEvidence(
  payload: unknown,
  sources: readonly SourceSnapshot[] | ReadonlyMap<string, SourceBlock>,
  options?: DraftValidationOptions | undefined,
): DraftValidationResult {
  const errors: string[] = [];
  const validatedAt = new Date().toISOString();

  // Index known blocks
  const knownBlocks = new Map<string, SourceBlock>();
  if (sources instanceof Map) {
    for (const [id, block] of sources.entries()) {
      knownBlocks.set(id, block);
    }
  } else if (Array.isArray(sources)) {
    for (const source of sources) {
      if (source && Array.isArray(source.blocks)) {
        for (const block of source.blocks) {
          knownBlocks.set(block.id, block);
        }
      }
    }
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return Object.freeze({
      valid: false,
      errors: Object.freeze(['草稿负载必须为 JSON 对象。']),
      validatedAt,
    });
  }

  const draft = payload as Partial<CharacterPackDraftPayload>;

  // 1. Schema version
  if (typeof draft.schemaVersion !== 'string' || !draft.schemaVersion.trim()) {
    errors.push('缺少 schemaVersion 声明。');
  } else if (!SUPPORTED_SCHEMA_VERSIONS.includes(draft.schemaVersion.trim())) {
    errors.push(`不支持的 schemaVersion: "${draft.schemaVersion}"，支持的版本: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}。`);
  }

  // 2. Character soul and identity
  const char = draft.character;
  if (!char || typeof char !== 'object' || Array.isArray(char)) {
    errors.push('缺少 character 角色核心对象。');
  } else {
    if (typeof char.name !== 'string' || !char.name.trim()) {
      errors.push('character.name 必须为非空字符串。');
    } else if (char.name.trim().length > 100) {
      errors.push('character.name 长度超出上限（100 字符）。');
    }

    if (typeof char.soul !== 'string' || !char.soul.trim()) {
      errors.push('character.soul 必须为非空字符串。');
    } else if (char.soul.trim().length > 4000) {
      errors.push('character.soul 长度超出上限（4000 字符）。');
    }

    if (char.evidenceIds !== undefined) {
      if (!Array.isArray(char.evidenceIds)) {
        errors.push('character.evidenceIds 必须为字符串数组。');
      } else {
        for (const evId of char.evidenceIds) {
          if (typeof evId !== 'string' || !evId.trim()) {
            errors.push('character.evidenceIds 中包含非字符串或空证据标识。');
          } else {
            const trimmedEvId = evId.trim();
            if (!knownBlocks.has(trimmedEvId)) {
              errors.push(`character.evidenceIds 引用了不存在的来源区块: "${evId}"。`);
            } else if (options?.allowedBlockIds && !options.allowedBlockIds.has(trimmedEvId)) {
              errors.push(`character.evidenceIds 引用了超出剧情截止点 ("${options.cutoffPoint ?? 'specified'}") 的区块: "${trimmedEvId}"。`);
            }
          }
        }
      }
    }
  }

  // 3. Canon facts
  if (!Array.isArray(draft.canonFacts)) {
    errors.push('canonFacts 必须为数组。');
  } else if (draft.canonFacts.length === 0) {
    errors.push('canonFacts 不能为空；草稿必须包含至少一条有据事实。');
  } else {
    const seenFactIds = new Set<string>();

    for (const [index, fact] of draft.canonFacts.entries()) {
      const factPrefix = `canonFacts[${index}]`;
      if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
        errors.push(`${factPrefix} 必须为对象。`);
        continue;
      }

      if (typeof fact.id !== 'string' || !fact.id.trim()) {
        errors.push(`${factPrefix}.id 必须为非空字符串。`);
      } else {
        const trimmedId = fact.id.trim();
        if (seenFactIds.has(trimmedId)) {
          errors.push(`${factPrefix}.id "${trimmedId}" 重复。`);
        }
        seenFactIds.add(trimmedId);
      }

      if (typeof fact.text !== 'string' || !fact.text.trim()) {
        errors.push(`${factPrefix}.text 必须为非空字符串。`);
      } else if (fact.text.trim().length > 1000) {
        errors.push(`${factPrefix}.text 长度超出上限（1000 字符）。`);
      }

      // Validate fact status classification
      if (fact.status !== undefined) {
        if (typeof fact.status !== 'string' || !['explicit', 'inferred', 'disputed'].includes(fact.status)) {
          errors.push(`${factPrefix}.status "${String(fact.status)}" 无效，仅允许 explicit, inferred, disputed。`);
        }
      }

      if (!Array.isArray(fact.evidenceIds)) {
        errors.push(`${factPrefix}.evidenceIds 必须为数组。`);
      } else if (fact.evidenceIds.length === 0) {
        // Ungrounded fact: rejection rule
        errors.push(`${factPrefix} 无引用证据；无依据事实不能成为有效草稿。`);
      } else {
        for (const evId of fact.evidenceIds) {
          if (typeof evId !== 'string' || !evId.trim()) {
            errors.push(`${factPrefix}.evidenceIds 包含无效的证据 ID 格式。`);
          } else {
            const trimmedEvId = evId.trim();
            const block = knownBlocks.get(trimmedEvId);
            if (!block) {
              // Fake / forged evidence ID
              errors.push(`${factPrefix} 引用了未登记或伪造的证据区块 "${trimmedEvId}"。`);
            } else {
              // Verify locator integrity
              if (
                typeof block.locator.start !== 'number' ||
                typeof block.locator.end !== 'number' ||
                block.locator.start < 0 ||
                block.locator.end < block.locator.start
              ) {
                errors.push(`${factPrefix} 所引用的区块 "${trimmedEvId}" 定位越界或无效: [${block.locator.start}, ${block.locator.end}]。`);
              }

              // Cutoff point boundary check
              if (options?.allowedBlockIds && !options.allowedBlockIds.has(trimmedEvId)) {
                errors.push(`${factPrefix} 引用了超出剧情截止点 ("${options.cutoffPoint ?? 'specified'}") 的证据区块 "${trimmedEvId}"。`);
              }
            }
          }
        }
      }
    }
  }

  // 4. Gaps (optional)
  if (draft.gaps !== undefined) {
    if (!Array.isArray(draft.gaps)) {
      errors.push('gaps 字段必须为字符串数组。');
    } else {
      for (const [index, gap] of draft.gaps.entries()) {
        if (typeof gap !== 'string') {
          errors.push(`gaps[${index}] 必须为字符串。`);
        }
      }
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    validatedAt,
  });
}

/**
 * Computes the set of allowed block IDs for a specified cutoff point.
 * Matches cutoffPoint against chapter headings or block textual markers.
 * If a block's chapter or text matches cutoffPoint, blocks up to that point are included;
 * blocks in subsequent chapters or after the cutoff marker are excluded.
 */
export function computeCutoffAllowedBlockIds(
  sources: readonly SourceSnapshot[],
  cutoffPoint: string,
): ReadonlySet<string> {
  const allowed = new Set<string>();
  const normalizedCutoff = cutoffPoint.trim().toLowerCase();

  for (const source of sources) {
    let cutoffReachedInSource = false;

    for (const block of source.blocks) {
      if (cutoffReachedInSource) {
        // Blocks past the cutoff point in this source are excluded
        continue;
      }

      allowed.add(block.id);

      // Check if this block marks the cutoff point
      const chapter = (block.locator.chapter || '').toLowerCase();
      const text = block.text.toLowerCase();

      if (chapter.includes(normalizedCutoff) || text.includes(normalizedCutoff)) {
        // Cutoff point reached at the end of this block/chapter
        cutoffReachedInSource = true;
      }
    }
  }

  return allowed;
}
