import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PriceEntryV1 } from "../domain/usageStats";
import { useOps } from "../hooks/useOps";

/**
 * F9 Ops 成本页（FE-26）。
 *
 * 数据源是用量台账（LLM-12），不是 turn_end 估算值。页面上每一个数字都要能
 * 回答「你是谁」：unknown 显示未知、未采集的用途显示未采集、金额一律标注
 * 「估算费用」——它不是官方账单。
 */

const PURPOSE_LABELS: Record<string, string> = {
  foreground: "前台对话",
  maintenance: "记忆维护",
  summary: "滚动摘要",
  proactive: "主动发起",
  unknown: "未声明",
};

const COVERAGE_LABELS: Record<string, string> = {
  reported: "完整上报",
  partial: "部分上报",
  unknown: "未知",
};

const STATUS_LABELS: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  unfinished: "无终态",
};

function emptyDraft(): Omit<PriceEntryV1, "id"> {
  return { model: "", providerId: "", currency: "USD", effectiveFrom: "", inputPerMillion: 0, outputPerMillion: 0 };
}

function tokensOf(tokens: { prompt: number | null; completion: number | null; total: number | null }): string {
  if (tokens.prompt === null && tokens.completion === null && tokens.total === null) return "未知";
  return `入 ${tokens.prompt ?? "未知"} / 出 ${tokens.completion ?? "未知"} / 总 ${tokens.total ?? "未知"}`;
}

function costsOf(costs: Record<string, number>): string {
  const entries = Object.entries(costs);
  if (!entries.length) return "未知（无价目或缺分项）";
  return entries.map(([currency, amount]) => `${amount.toFixed(6)} ${currency}`).join(" + ");
}

export function OpsPage() {
  const view = useOps();
  const [draft, setDraft] = useState<Omit<PriceEntryV1, "id">>(emptyDraft());

  if (!view.available) {
    return (
      <div className="devtools-empty">
        <strong>这台机器上没有用量台账</strong>
        <p>
          当前装配没有启用 usagePlugin（LLM-12），所以没有可查询的用量记录。
          这里显示空白不是账单为零。
        </p>
      </div>
    );
  }

  const stats = view.stats;
  const loadingBar = view.loading ? <span className="ops-loading">载入中…</span> : null;

  return (
    <div className="ops-page">
      <div className="memory-toolbar">
        <label className="ops-tz">
          归日时区
          <input
            type="text"
            value={view.timeZone}
            onChange={(event) => view.setTimeZone(event.target.value)}
            placeholder="如 Asia/Shanghai / UTC"
          />
        </label>
        <button type="button" onClick={() => void view.refresh()}>
          <RefreshCw size={13} /> 刷新
        </button>
        {loadingBar}
        <span className="ops-coverage">{view.coverageNote}</span>
      </div>

      {view.error && <p className="ops-error">{view.error}</p>}

      {stats && (
        <>
          <section className="ops-block">
            <h4>
              总览（{stats.records} 条物理尝试
              {stats.duplicatesAbsorbed > 0 ? `，已吸收重复 ${stats.duplicatesAbsorbed} 条` : ""}）
            </h4>
            <table className="ops-table">
              <tbody>
                <tr>
                  <th>状态</th>
                  <td>
                    {Object.entries(stats.statusCounts).map(([status, count]) =>
                      `${STATUS_LABELS[status]} ${count}`).join(" / ")}
                  </td>
                </tr>
                <tr>
                  <th>错误率</th>
                  <td>{stats.errorRate === null
                    ? "未知（没有已完成/失败的记录）"
                    : `${(stats.errorRate * 100).toFixed(2)}%（失败/(完成+失败)，取消与无终态另计）`}</td>
                </tr>
                <tr>
                  <th>上报完整度</th>
                  <td>{Object.entries(stats.coverageCounts).map(([coverage, count]) =>
                    `${COVERAGE_LABELS[coverage]} ${count}`).join(" / ")}</td>
                </tr>
                <tr>
                  <th>最慢物理尝试</th>
                  <td>{stats.slowestAttempt
                    ? `${stats.slowestAttempt.ms} ms（attempt ${stats.slowestAttempt.id}${stats.slowestAttempt.turnId ? `，轮 ${stats.slowestAttempt.turnId}` : ""}；只统计开始/结束都完整观测的尝试）`
                    : "未知（没有完整计时的尝试）"}</td>
                </tr>
                <tr>
                  <th>token 合计</th>
                  <td>{tokensOf(stats.tokens)}</td>
                </tr>
                <tr>
                  <th>估算费用</th>
                  <td>
                    {costsOf(stats.costByCurrency)}
                    {stats.unpricedRecords > 0 ? `（${stats.unpricedRecords} 条未计入：缺价目或缺输入/输出分项）` : ""}
                    <span className="ops-note">非官方账单</span>
                  </td>
                </tr>
                <tr>
                  <th>用途覆盖</th>
                  <td>
                    {stats.purposeCounts.length
                      ? stats.purposeCounts.map((item) => `${PURPOSE_LABELS[item.purpose] ?? item.purpose} ${item.records}`).join(" / ")
                      : "没有已采集的用途"}
                    {stats.missingPurposes.length > 0
                      ? `；未采集：${stats.missingPurposes.map((purpose) => PURPOSE_LABELS[purpose] ?? purpose).join("、")}（未采集不按 0 计）`
                      : ""}
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="ops-block">
            <h4>按日（时区 {view.timeZone}）</h4>
            {stats.days.length === 0
              ? <p className="ops-note">没有记录可分组。</p>
              : (
                <table className="ops-table">
                  <thead>
                    <tr><th>日</th><th>条数</th><th>token</th><th>估算费用</th></tr>
                  </thead>
                  <tbody>
                    {stats.days.map((day) => (
                      <tr key={day.key}>
                        <td>{day.key}</td>
                        <td>{day.records}</td>
                        <td>{tokensOf(day.tokens)}</td>
                        <td>
                          {costsOf(day.costByCurrency)}
                          {day.unpricedRecords > 0 ? `（${day.unpricedRecords} 条未知）` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>

          <section className="ops-block">
            <h4>按 Provider / 模型</h4>
            {stats.models.length === 0
              ? <p className="ops-note">没有记录可分组。</p>
              : (
                <table className="ops-table">
                  <thead>
                    <tr><th>Provider / 模型</th><th>条数</th><th>token</th><th>估算费用</th></tr>
                  </thead>
                  <tbody>
                    {stats.models.map((model) => (
                      <tr key={model.key}>
                        <td>{model.key}</td>
                        <td>{model.records}</td>
                        <td>{tokensOf(model.tokens)}</td>
                        <td>
                          {costsOf(model.costByCurrency)}
                          {model.unpricedRecords > 0 ? `（${model.unpricedRecords} 条未知）` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </section>
        </>
      )}

      <section className="ops-block">
        <h4>价目（每百万 token 单价，显式输入并按版本保存）</h4>
        {view.priceError && <p className="ops-error">{view.priceError}</p>}
        {view.prices.length === 0
          ? <p className="ops-note">还没有价目：金额会显示未知，不会按 0 计。</p>
          : (
            <table className="ops-table">
              <thead>
                <tr><th>Provider / 模型</th><th>币种</th><th>生效日</th><th>输入单价</th><th>输出单价</th><th /></tr>
              </thead>
              <tbody>
                {view.prices.map((price) => (
                  <tr key={price.id}>
                    <td>{price.providerId} / {price.model}</td>
                    <td>{price.currency}</td>
                    <td>{price.effectiveFrom}</td>
                    <td>{price.inputPerMillion}</td>
                    <td>{price.outputPerMillion}</td>
                    <td><button type="button" onClick={() => void view.removePrice(price.id)}>删除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

        <form
          className="ops-price-form"
          onSubmit={(event) => {
            event.preventDefault();
            void view.savePrice({ ...draft, id: "" });
            setDraft(emptyDraft());
          }}
        >
          <input placeholder="providerId" value={draft.providerId} onChange={(e) => setDraft({ ...draft, providerId: e.target.value })} />
          <input placeholder="模型名" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          <input placeholder="币种" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} />
          <input placeholder="生效日 YYYY-MM-DD" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
          <input placeholder="输入单价/百万" type="number" step="any" value={draft.inputPerMillion} onChange={(e) => setDraft({ ...draft, inputPerMillion: Number(e.target.value) })} />
          <input placeholder="输出单价/百万" type="number" step="any" value={draft.outputPerMillion} onChange={(e) => setDraft({ ...draft, outputPerMillion: Number(e.target.value) })} />
          <button type="submit">保存价目</button>
        </form>
        <p className="ops-note">
          不同币种分开合计、不自动换算；只有总 token 的记录不拆分计价；缓存分项当前未采集，费用不含缓存折扣。
        </p>
      </section>

      {view.hasMore && (
        <button type="button" className="ops-more" onClick={() => void view.loadMore()}>
          载入下一页（已载 {view.loadedRecords} 条）
        </button>
      )}
    </div>
  );
}
