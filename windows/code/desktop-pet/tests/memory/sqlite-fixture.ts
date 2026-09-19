import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharacterId, ConversationMessage, MemoryChange, MemoryOperation, TurnScope } from '../../contracts/index.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';

export const NOW = '2026-09-06T12:00:00.000Z';
export const scope = (characterId: CharacterId = 'companion', turnId = 'turn-1'): TurnScope => ({ characterId, sessionId: 'session-1', turnId, generation: 1 });
export const message = (id: string, text: string, characterId: CharacterId = 'companion', createdAt = NOW): ConversationMessage => ({ characterId, id, role: 'user', text, createdAt });
export const change = (operation: MemoryOperation, operationId: string, owned = scope()): MemoryChange => ({ scope: owned, operation, operationId, reason: 'controlled test', createdAt: NOW });
export function fixture(maxBytes = CONFIRMED_RETENTION.transcriptMaxBytes, artifactPackage = 'companion-step1-01') {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), `../../../../../.local/${artifactPackage}/tmp`);
  mkdirSync(parent, {recursive:true});
  const directory = mkdtempSync(join(parent, 'case-'));
  const filename = join(directory, 'pet.sqlite');
  let time = NOW;
  const options = { filename, retention: {...CONFIRMED_RETENTION, transcriptMaxBytes:maxBytes}, invitations:confirmedInvitationPolicy('Asia/Shanghai'), clock:()=>time };
  const stores: SqliteMemoryStore[] = [];
  const readers: {close():unknown}[] = [];
  const track = <T extends {close():unknown}>(reader:T):T => {readers.push(reader);return reader;};
  const open = () => { const store = new SqliteMemoryStore(options); stores.push(store); return store; };
  return { directory, filename, options, open, track, setTime:(value:string)=>{time=value;}, cleanup:()=>{for(const reader of readers)reader.close();for(const store of stores) store.close(); rmSync(directory,{recursive:true,force:true});} };
}
export function seed(store: SqliteMemoryStore, owned=scope(), suffix='') {
  store.append(owned,[message(`raw${suffix}`,'我在海风公司工作',owned.characterId)]);
  store.apply(change({type:'add',id:`job${suffix}`,text:'在海风公司工作',sourceIds:[`raw${suffix}`]},`add${suffix}`,owned));
}
