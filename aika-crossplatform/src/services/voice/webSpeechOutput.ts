import type { SpeechOutputEngine, SpeechOutputEvents, SpeechOutputRequest } from "./contracts";

/**
 * 分句已经在 domain/sentences.ts 做完，这里只清掉念出来是杂音的记号。
 * 不能按换行截断：那样多行回复会被悄悄念掉一半。
 */
function speakableText(text: string) {
  return text.replace(/\s*\n+\s*/g, " ").replace(/[*_#>`]/g, "").trim();
}

/**
 * 她换语言说话时不能换成另一个人。
 * 三种语言各挑一个常见的女声，挑不到再退回该语言的任意音色。
 */
const FEMALE_VOICE_NAMES = /nanami|haruka|ayumi|mayu|xiaoxiao|huihui|yaoyao|xiaoyi|zira|aria|jenny|michelle|female/i;

function pickVoice(language: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  const tag = language.toLowerCase();
  const exact = voices.filter((voice) => voice.lang.toLowerCase().replace("_", "-") === tag);
  const sameLanguage = voices.filter((voice) => voice.lang.toLowerCase().startsWith(tag.slice(0, 2)));
  const candidates = exact.length ? exact : sameLanguage;
  return candidates.find((voice) => FEMALE_VOICE_NAMES.test(voice.name)) ?? candidates[0] ?? null;
}

export const webSpeechOutput: SpeechOutputEngine = {
  id: "system-japanese-voice",
  kind: "web-speech",

  isAvailable() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  },

  speak(request: SpeechOutputRequest, events: SpeechOutputEvents = {}) {
    const text = speakableText(request.text);
    if (!text) {
      events.onEnd?.();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = pickVoice(request.language);
    utterance.lang = request.language;
    utterance.rate = request.rate ?? 1;
    utterance.pitch = request.pitch ?? 1;
    utterance.onstart = () => events.onStart?.();
    utterance.onend = () => events.onEnd?.();
    utterance.onerror = (event) => events.onError?.(event.error);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  },

  stop() {
    window.speechSynthesis.cancel();
  },
};
