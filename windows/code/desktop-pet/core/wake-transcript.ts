/** Only a backend-bound KWS turn may remove one leading wake phrase.
 * No audio trimming, fuzzy matching, replacement within the utterance, or old-data edits.
 */
export function cleanWakeTranscript(transcript: string, keyword: string): string {
  const text=transcript.trim();
  // One observed ASR spelling, scoped to this exact configured wake word.
  const prefixes=keyword==='乐正绫'?[keyword,'岳正宁']:[keyword];
  const prefix=prefixes.find(value=>text.startsWith(value));
  const body=prefix?text.slice(prefix.length).replace(/^[\s，,。.!！?？、:：;；]+/u,''):text;
  return /^[\s\p{P}]*$/u.test(body)?'':body;
}
