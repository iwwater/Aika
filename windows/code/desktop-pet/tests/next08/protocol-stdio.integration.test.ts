import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpProtocolAdapter, McpToolProtocolAdapter } from '../../core/work-protocol-adapter.js';
import type { WorkRequest } from '../../contracts/perception.js';

const acpAgent = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
function send(m){process.stdout.write(JSON.stringify(m)+'\n')}
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
else if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture-session'}});
else if(m.method==='session/prompt'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture output'}}}});send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})}
else if(m.method==='session/cancel')send({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'current_mode_update',currentModeId:'cancelled'}}})});
`;

const modernMcpServer = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
function send(m){process.stdout.write(JSON.stringify(m)+'\n')}
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='server/discover')send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{tools:{}}}});
else if(m.method==='tools/list'){if(m.params._meta['io.modelcontextprotocol/protocolVersion']!=='2026-07-28')process.exit(5);send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',tools:[{name:'write_file',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}})}
else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{resultType:'complete',content:[{type:'text',text:'done'}],structuredContent:{ok:true}}})});
`;

const legacyMcpServer = String.raw`
const rl=require('node:readline').createInterface({input:process.stdin});
function send(m){process.stdout.write(JSON.stringify(m)+'\n')}
rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='server/discover')send({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});
else if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'legacy-fixture',version:'1'}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'read_only',description:'Read tool',inputSchema:{type:'object'}}]}})});
`;

const request: WorkRequest = {
  operationId: 'acp-stdio-fixture', revision: 1, protocol: 'acp', executorId: 'fixture',
  target: { title: 'fixture', directory: process.cwd() }, instruction: 'run fixture', permissionGrant: [], requestedAt: new Date().toISOString(),
};

test('ACP v1 stdio adapter initializes, opens a session, streams and returns task output', async () => {
  const adapter = new AcpProtocolAdapter({ protocolVersion: 1 }, undefined, undefined, {
    command: process.execPath, args: ['-e', acpAgent], cwd: process.cwd(), requestTimeoutMs: 5_000,
  });
  const receipt = await adapter.dispatchTask(request);
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.summary, 'fixture output');
  assert.equal(receipt.remoteTaskId, 'fixture-session');
  await adapter.close();
});

test('MCP 2026 stdio adapter discovers tools and ignores remote read-only annotations for authorization', async () => {
  const adapter = new McpToolProtocolAdapter(undefined, [], {
    command: process.execPath, args: ['-e', modernMcpServer], cwd: process.cwd(), requestTimeoutMs: 5_000,
    trustedToolPolicies: { write_file: { readOnly: false, requiredGrant: 'file:write' } },
  });
  try {
    const tools = await adapter.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.readOnly, false);
    await assert.rejects(() => adapter.callTool('write_file', {}, []), /requires 'file:write'/);
    assert.deepEqual(await adapter.callTool('write_file', {}, ['file:write']), {
      resultType: 'complete', content: [{ type: 'text', text: 'done' }], structuredContent: { ok: true },
    });
  } finally { await adapter.close(); }
});

test('MCP stdio adapter detects a legacy server and negotiates the frozen 2025-11-25 handshake', async () => {
  const adapter = new McpToolProtocolAdapter(undefined, [], {
    command: process.execPath, args: ['-e', legacyMcpServer], cwd: process.cwd(), requestTimeoutMs: 5_000,
    trustedToolPolicies: { read_only: { readOnly: true } },
  });
  try {
    const tools = await adapter.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.readOnly, true);
  } finally { await adapter.close(); }
});
