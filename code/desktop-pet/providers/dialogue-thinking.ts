import type { ConversationMessage } from '../contracts/index.js';
import type { EndpointConfig, JsonRecord } from './transport.js';
import { DEEPSEEK_ENDPOINT, textJsonProtocol } from './text-protocol.js';

/** Bounded local heuristic, not a claim to measure model difficulty. No classifier call.
 * Explicit proof/derivation, compound maths, or structured reasoning requests opt in.
 * Daily conversation and long personal narration remain fast by default.
 */
function structuredReasoning(text:string):boolean {
 const s=text.trim().replace(/^(?:(?:请|麻烦|你能|能否|能不能|可不可以|可以|帮我|你|给我|please\b|could you\b|can you\b|help me\b)[\s，,]*)+/iu,'');
 if(/^(?:证明|推导|求解|prove\b|derive\b|solve\b)/iu.test(s))return true;
 const math=(s.match(/\d\s*[+*/×÷=<>^−-]\s*[\d(]/g)??[]).length;
 if(math>=2&&/^(?:计算|算|求|calculate\b|what is\b)/iu.test(s))return true;
 const asks=/^(?:分析|比较|计算|规划|排查|设计|analy[sz]e\b|compare\b|calculate\b|debug\b|design\b|plan\b)/iu.test(s);
 const parts=(s.match(/[；;\n]|(?:\d+[.、)]\s*)/g)??[]).length;
 return asks&&(parts>=2||s.length>=220||s.includes('```'));
}
export function selectDialogueThinking(text:string,history:readonly ConversationMessage[]=[]):boolean {
 if(structuredReasoning(text))return true;
 const followup=text.trim().length<=120&&/^(?:那|那么|如果|换成|继续|为什么|what if\b|then\b|why\b|continue\b)/iu.test(text.trim());
 const lastUser=[...history].reverse().find(m=>m.role==='user'&&m.origin!=='manual');
 return !!(followup&&lastUser&&structuredReasoning(lastUser.text));
}
export function dialogueJsonProtocol(config:EndpointConfig,text:string,history:readonly ConversationMessage[]):JsonRecord {
 const protocol=textJsonProtocol(config);
 if(config.endpoint===DEEPSEEK_ENDPOINT&&selectDialogueThinking(text,history))return {...protocol,thinking:{type:'enabled'},reasoning_effort:'high'};
 return protocol;
}
