import {readFile} from 'node:fs/promises';
import type {TrialConfiguration} from '../app/trial-config.js';
import type {ManagementSnapshot} from '../contracts/management.js';
/** Read-only display; unknown amounts remain estimates, never converted into charges. */
export async function accountingSnapshot(config:TrialConfiguration):Promise<NonNullable<ManagementSnapshot['accounting']>> {
 const ledger=JSON.parse(await readFile(config.budgetFile,'utf8'));
 if(ledger.batchId!==config.budgetBatchId||ledger.limitMicros!==config.limitMicros||!Array.isArray(ledger.entries)||(config.budgetMode==='unlimited')!==(ledger.budgetMode==='unlimited'))throw Error('Accounting mode mismatch');
 return {mode:config.budgetMode??'bounded',limitMicros:config.limitMicros,
  knownMicros:ledger.entries.reduce((n:number,e:{actualMicros:number|null})=>n+(e.actualMicros??0),0),
  unknownReservedMicros:ledger.entries.filter((e:{status:string})=>e.status==='unknown').reduce((n:number,e:{reservedMicros:number})=>n+e.reservedMicros,0),
  pendingReservedMicros:ledger.entries.filter((e:{status:string})=>e.status==='reserved').reduce((n:number,e:{reservedMicros:number})=>n+e.reservedMicros,0)};
}
