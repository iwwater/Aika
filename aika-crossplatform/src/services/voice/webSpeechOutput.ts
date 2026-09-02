import type { SpeechOutputEngine, SpeechOutputEvents, SpeechOutputRequest } from "./contracts";

function speakableText(text: string) {
  return text.split("\n")[0].replace(/[*_#>`]/g, "").trim();
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
    const voices = window.speechSynthesis.getVoices();
    const matchingVoices = voices.filter((voice) => voice.lang.toLowerCase().startsWith(request.language.slice(0, 2).toLowerCase()));
    utterance.voice = matchingVoices.find((voice) => /nanami|haruka|ayumi|female/i.test(voice.name)) ?? matchingVoices[0] ?? null;
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
