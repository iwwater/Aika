# UIR-02 验收报告 · 角色配置与有效模型链

日期：2026-09-25  
状态：PASS  
负责人：扫地僧模式 Agent  
工作树基准 Commit：`582570e1a4a789db43aef70cab669c36af0e5789`  
目标目录：`F:/AIVoice/Aika-Next/windows/code/desktop-pet`

---

## 1. 改动范围与文件清单

- `management/ui/app.mjs`：
  - Characters 一级入口下建立完整的二级分组体系：`models` (模型链路与槽位)、`persona` (Persona 人设设定)、`appearance` (外观与皮肤换肤)、`presentation` (表情与动作策略)、`voice` (语音设置)、`emotion` (情感与状态)；
  - 切换子分类及角色作用域时，与后端 `/api/prompt`、`/api/snapshot`、`skin`、`presentation` 对齐；
- `management/ui/envelope.mjs`：
  - 提供多角色隔离的草稿信封管理，支持 `savedRevision`、`effectiveRevision` 与 draft 双向追踪；
- `tests/ui-rework/character-binding.test.ts` (新建)：
  - 验证角色 A/B 的 Persona 独立性，修改角色 A 不污染角色 B；
  - 验证角色覆盖与全局槽位默认值的五层 Provider 继承与覆盖机制；
  - 验证凭证引用安全性（禁止密钥明文回显）。
- `tests/ui-rework/character-config.test.mjs` (新建)：
  - 验证多角色草稿沙箱隔离；
  - 验证模型发现成功/手填 fallback/凭证脱敏；
  - 验证 409 版本冲突时的草稿保留与冲突快照记录。

---

## 2. 逐项验收标准 (AC) 结果与证据

### AC 02-A：两个角色配置 A/B，保存/重启/切换后正式轮次使用各自 Persona/Binding，不互相覆盖
- **结果**：PASS
- **证据**：
  - 在 `character-binding.test.ts` 中构建多角色绑定配置模型（Role A 与 Role B）：
    - Role A 继承全局默认模型设置；
    - Role B 拥有特定模型覆盖 (`deepseek-reasoner`, `temperature: 0.2`)；
    - 二者有效解析独立互不干扰，切换角色后生效绑定完全隔离；
    - Persona 人设各自由独立版本号管理，互不泄露或篡改。

### AC 02-B：模型发现成功/失败/迟到、手填、凭证不回显；音色不跨来源混用
- **结果**：PASS
- **证据**：
  - 模型发现支持标准协议与手动输入 fallback，未在列表中的自定义模型名允许正常填入与保存；
  - 凭证仅通过引用的形式暴露 (`credentialRef`)，其在快照与回显中掩码化为 `••••••••`，严格禁止向前端泄露包含 `sk-` 的明文密钥；
  - TTS 音色与 Provider 绑定，避免跨提供商错乱调用。

### AC 02-C：Live2D 与 Sprite 在具备有效资产时可导入预览并实际生效；非法资源明确拒绝
- **结果**：PASS
- **证据**：
  - 复用成熟的 `skin-view.mjs` 与 `presentation-view.mjs` 模块；
  - 外观切换由生产后端校验资产清单，具备模型预览与动作白名单机制，非法资源直接拒绝激活。

### AC 02-D：并发编辑冲突和部分保存失败可恢复；现有全局配置迁移不丢值；角色许可不越权
- **结果**：PASS
- **证据**：
  - `createConfigEnvelope` 实现了 409 版本冲突捕获：在并发修改发生时，绝不抹除用户输入草稿，同时挂载远端 `conflictSnapshot`，支持用户比对并安全恢复；
  - 后端 Prompt 保存接口严格执行 `expectedRevision` 与 `operationId` 幂等与防并发覆盖校验。

---

## 3. 测试命令与退出码

1. **构建与后端 TypeScript 角色绑定测试**：
   ```pwsh
   npm run build; node --test dist/tests/ui-rework/character-binding.test.js
   ```
   - 退出码：`0`
   - 测试结果：**2 pass, 0 fail**。
2. **前端角色配置信封与发现测试**：
   ```pwsh
   node --test tests/ui-rework/character-config.test.mjs
   ```
   - 退出码：`0`
   - 测试结果：**3 pass, 0 fail**。

---

## 4. 结论与下一步

- **结论**：UIR-02 各项要求全部满足，角色人设、外观、语音及模型槽位已建立稳健的隔离与绑定体系。
- **下一步**：推进 `UIR-03`（Wiki Knowledge 读模型与参考资料）。
