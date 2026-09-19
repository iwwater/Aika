import type Database from 'better-sqlite3';
import type { TurnScope } from '../contracts/index.js';
import type { SourceVersion } from '../contracts/memory-lifecycle.js';
import type { MemoryRecord } from './ledger.js';

export interface SourceNode {
  id: string; kind: MemoryRecord['kind']; state: MemoryRecord['state']; version: number;
  sources: readonly SourceVersion[]; eligible: boolean; order: number; parent: string | null;
}
export function sourceGraph(db: Database.Database, scope: TurnScope): Map<string, SourceNode> {
  const rows = db.prepare('SELECT id,kind,state,version,sources_json,evidence_eligible,logical_order,fragment_json FROM memory_records WHERE character_id=?').all(scope.characterId) as {id:string;kind:MemoryRecord['kind'];state:MemoryRecord['state'];version:number;sources_json:string;evidence_eligible:number;logical_order:number;fragment_json:string|null}[];
  return new Map(rows.map(row => [row.id, {id:row.id,kind:row.kind,state:row.state,version:row.version,sources:JSON.parse(row.sources_json),eligible:row.evidence_eligible===1,order:row.logical_order,parent:row.fragment_json ? JSON.parse(row.fragment_json).parent.id : null}]));
}
export const readable = (node: SourceNode): boolean => node.state === 'active' && node.eligible && ['transcript','summary','memory'].includes(node.kind);
/** Candidate evidence is not the undirected chat component. Keep ancestors as metadata,
 * add related long-term records and direct supports, never walk an assistant's whole context backwards. */
export function related(graph: Map<string, SourceNode>, seed: string): Set<string> {
  const found=new Set([seed]);
  for(let changed=true;changed;){
    changed=false;
    const add=(id:string)=>{if(!found.has(id)){found.add(id);changed=true;}};
    for(const id of [...found]){
      const node=graph.get(id);if(!node)continue;
      if(node.kind==='memory'||node.kind==='summary'){
        const supports=node.sources.filter(ref=>ref.id!==id&&graph.get(ref.id)?.version===ref.version&&readable(graph.get(ref.id)!));
        // Flattened provenance includes transitive metadata. Only maximal direct supports need text.
        for(const ref of supports)if(!supports.some(other=>other.id!==ref.id&&graph.get(other.id)!.sources.some(parent=>parent.id===ref.id&&parent.version===ref.version)))add(ref.id);
      }
      const lineage=new Set([node.id,...node.sources.map(ref=>ref.id)]);
      for(const candidate of graph.values())if(candidate.kind==='memory'&&readable(candidate)&&
        (lineage.has(candidate.id)||candidate.sources.some(ref=>lineage.has(ref.id))))add(candidate.id);
    }
  }
  return found;
}
/** Optional preflight enrichment. Submission recomputes this against the actual mutation plan. */
export function effectCandidates(graph:Map<string,SourceNode>,seeds:Iterable<string>):Set<string>{
  const roots=new Set(seeds);
  for(let changed=true;changed;){changed=false;for(const id of descendants(graph,roots)){
    const node=graph.get(id);if(node?.kind==='summary')for(const ref of node.sources){
      const source=graph.get(ref.id);if(source?.kind==='transcript'&&source.state==='active'&&!roots.has(ref.id)){roots.add(ref.id);changed=true;}
    }
  }}
  return descendants(graph,roots);
}
export function descendants(graph: Map<string, SourceNode>, roots: Iterable<string>): Set<string> {
  const found = new Set(roots);
  for (let changed=true;changed;) {
    changed=false;
    for (const node of graph.values()) if (!found.has(node.id) && node.sources.some(source=>found.has(source.id))) {found.add(node.id);changed=true;}
  }
  return found;
}
