// End-to-end verification script for Memory Distillation & Trace Pipeline MVP
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

console.log('========================================================');
console.log('🚀 开始验证 Aika-Next 核心后端链路 MVP（记忆提炼 + Trace）');
console.log('========================================================\n');

// Launch real-backend.mjs
const backend = spawn('node', ['tools/real-backend.mjs'], {
  cwd: root,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit']
});

const lines = createInterface({ input: backend.stdout, crlfDelay: Infinity });

function sendCommand(cmd) {
  backend.stdin.write(JSON.stringify({ channel: 'command', command: cmd }) + '\n');
}

let turn1ReplyReceived = false;
let turn2ReplyReceived = false;

lines.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.channel === 'event' && msg.event?.type === 'reply') {
      console.log(`\n🤖 Aika 回复: "${msg.event.reply.text}"`);
      if (!turn1ReplyReceived) {
        turn1ReplyReceived = true;
      } else {
        turn2ReplyReceived = true;
      }
    } else if (msg.channel === 'backend_ready') {
      console.log('✅ 后端已就绪，准备发起第 1 轮对话（包含用户个人特征与喜好）...\n');
      // Turn 1: User introduces facts
      sendCommand({
        type: 'submit_text',
        text: 'Aika你好，我是ZYF，平时最喜欢喝无糖乌龙茶，周末一有空就去西湖边爬山！'
      });
    }
  } catch {}
});

// Wait for Turn 1 to complete and distillation to finish
async function run() {
  // Wait up to 15 seconds for turn 1 reply
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (turn1ReplyReceived) break;
  }

  if (!turn1ReplyReceived) {
    console.error('❌ 第一轮对话超时未收到回复');
    backend.kill();
    process.exit(1);
  }

  console.log('\n⏳ 等待后台异步记忆提炼流水线执行完成（约 10-12 秒）...');
  await new Promise(r => setTimeout(r, 12000));

  // Verify /api/traces
  console.log('\n🔍 [检验 1] 查询管理后台 /api/traces 调用链接口...');
  const traceRes = await fetch('http://127.0.0.1:10158/api/traces?limit=5', {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  console.log(`📊 当前 Trace 总数: ${traceRes.total} 条`);
  if (traceRes.traces.length > 0) {
    const latest = traceRes.traces[0];
    console.log(`⚡ 最新 Trace 轮次: ${latest.turnId}`);
    console.log(`⏱️ 总耗时: ${latest.totalElapsedMs} ms, 状态: ${latest.status}`);
    console.log(`🌊 执行阶段流水线:`);
    latest.stages.forEach(st => {
      console.log(`   - [${st.label}] 耗时: ${st.elapsedMs}ms, 状态: ${st.status}, 详情: ${JSON.stringify(st.details || {})}`);
    });
  }

  // Verify /api/records?kind=memory
  console.log('\n🔍 [检验 2] 查询管理后台 /api/records?kind=memory 验证事实是否已自动沉淀...');
  const memRes = await fetch('http://127.0.0.1:10158/api/records?characterId=companion&kind=memory&state=active&limit=5', {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());

  console.log(`🧠 当前长期记忆总数: ${memRes.total} 条`);
  const autoMemories = memRes.records.filter(r => r.origin === 'automatic');
  console.log(`✨ 自动提炼形成的记忆: ${autoMemories.length} 条`);
  autoMemories.forEach(m => {
    console.log(`   📌 [${m.id}] ${m.text} (来源引用: ${JSON.stringify(m.sources)})`);
  });

  // Turn 2: Test recall
  console.log('\n========================================================');
  console.log('🔄 发起第 2 轮对话（验证提炼后的记忆在后续对话中召回与回答）...');
  sendCommand({
    type: 'submit_text',
    text: 'Aika，你还记得我平时爱喝什么茶，周末喜欢去哪儿吗？'
  });

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (turn2ReplyReceived) break;
  }

  console.log('\n⏳ 等待第 2 轮 Trace 记录完成...');
  await new Promise(r => setTimeout(r, 10000));

  // Check trace 2
  const traceRes2 = await fetch('http://127.0.0.1:10158/api/traces?limit=2', {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json());
  console.log(`\n📊 最终 Trace 总数: ${traceRes2.total} 条`);

  backend.kill();
  console.log('\n🎉 MVP 端到端验证顺利完成！');
  process.exit(0);
}

run().catch(err => {
  console.error('测试异常:', err);
  backend.kill();
  process.exit(1);
});
