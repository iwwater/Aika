import type { CompanionIntroduction } from '../contracts/character.js';

/** Presentation only. Never pass this text to append, summarization, or memory maintenance. */
export const COMPANION_INTRODUCTION: Readonly<CompanionIntroduction> = Object.freeze({
  id: 'companion-first-meeting',
  text: '……好像刚从一场奇怪的梦里醒来，好多往事都模糊了。可一见到你，那种熟悉、亲近的感觉还在。想不起来的事就先不硬想啦。你今天过得怎么样？',
});
