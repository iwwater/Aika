import { speechLanguageFor } from "../../domain/language";
import type { SpeechOutputEngine } from "./contracts";

/**
 * 逐句播放队列。
 *
 * 为什么不整段丢给引擎：
 * 1. 第一句先出声，不等整段。模型流式吐字时句子边到边入队，队列不必知道文本从哪来。
 * 2. 逐句选音色。她一句日语一句中文时，整段用一个音色念就换了个人。
 * 3. 打断要干净。stop() 之后即使引擎迟到的 onEnd 才回来，也不会接着念下一句。
 */

export interface SpeechQueueEvents {
  /** 第一句真的出声了。用来把界面切到「正在说话」。 */
  onStart?(): void;
  onSentence?(index: number, text: string): void;
  /** 全部念完，且调用方已经说过不会再有新句子。被 stop() 打断时不触发。 */
  onDrained?(): void;
  onError?(message: string): void;
}

export interface SpeechQueue {
  /** 开一轮新的播放，打断上一轮。 */
  begin(events?: SpeechQueueEvents): void;
  /** 往当前这一轮追加句子。已经念完在等的话会立刻续上。 */
  enqueue(sentences: readonly string[]): void;
  /** 声明不会再有新句子了。念完最后一句才算 drained。 */
  end(): void;
  /** 一次性播放已经完整的一段，等于 begin + enqueue + end。 */
  speak(sentences: readonly string[], events?: SpeechQueueEvents): void;
  stop(): void;
  isSpeaking(): boolean;
}

export interface SpeechQueueOptions {
  rate?: number;
  pitch?: number;
}

export function createSpeechQueue(
  engine: SpeechOutputEngine,
  options: SpeechQueueOptions = {},
): SpeechQueue {
  let sentences: string[] = [];
  let cursor = 0;
  /** 调用方说过不会再有新句子了吗。没说就算念完也要等着。 */
  let closed = false;
  /** 有一句正在念。 */
  let running = false;
  let drained = false;
  /** stop() 之后不再收句子。流式回调比打断晚一步到时，靠这个挡住。 */
  let accepting = false;
  /** 每次 begin/stop 都换一代，用来丢弃上一代迟到的回调。 */
  let generation = 0;
  let events: SpeechQueueEvents = {};

  function pump(epoch: number) {
    if (epoch !== generation || running) return;

    if (cursor >= sentences.length) {
      // 还没 end()，说明后面可能还有句子在生成，安静等着。
      if (!closed || drained) return;
      drained = true;
      events.onDrained?.();
      return;
    }

    const index = cursor;
    const text = sentences[index];
    cursor += 1;
    running = true;
    events.onSentence?.(index, text);

    engine.speak(
      {
        text,
        // 她用哪种语言说的就用哪种语言念，逐句判断。
        language: speechLanguageFor(text),
        rate: options.rate ?? 1.03,
        pitch: options.pitch ?? 1.08,
      },
      {
        onStart: () => {
          if (epoch === generation && index === 0) events.onStart?.();
        },
        onEnd: () => {
          if (epoch !== generation) return;
          running = false;
          pump(epoch);
        },
        onError: (message) => {
          if (epoch !== generation) return;
          running = false;
          events.onError?.(message);
          // 一句念不出来不该让整轮哑掉，继续下一句。
          pump(epoch);
        },
      },
    );
  }

  function reset(nextEvents: SpeechQueueEvents) {
    generation += 1;
    sentences = [];
    cursor = 0;
    closed = false;
    running = false;
    drained = false;
    accepting = true;
    events = nextEvents;
    engine.stop();
  }

  return {
    begin(nextEvents = {}) {
      reset(nextEvents);
    },

    enqueue(next) {
      if (!accepting || !next.length) return;
      sentences.push(...next);
      pump(generation);
    },

    end() {
      if (!accepting) return;
      closed = true;
      pump(generation);
    },

    speak(next, nextEvents = {}) {
      reset(nextEvents);
      sentences.push(...next);
      closed = true;
      pump(generation);
    },

    stop() {
      reset({});
      closed = true;
      drained = true;
      accepting = false;
    },

    isSpeaking() {
      return running || cursor < sentences.length;
    },
  };
}
