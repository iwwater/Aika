import { useEffect, useState, type FormEvent } from "react";
import type { LocalTasks } from "../services/runtime/localTasks";

const labels = { pending: "等待到期", paused: "已暂停", done: "已完成", missed: "已错过", skipped: "已跳过", cancelled: "已取消", unknown: "结果未知，不自动重试", failed: "失败" };
export function LocalTasksPanel({ service }: { service: LocalTasks }) {
  const [tasks, setTasks] = useState(() => service.list());
  const [text, setText] = useState("");
  const [at, setAt] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { const timer = setInterval(() => setTasks(service.list()), 1000); return () => clearInterval(timer); }, [service]);
  async function run(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); setTasks(service.list()); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void run(async () => { await service.create(text, new Date(at).getTime()); setText(""); }); }
  return <section id="settings-tasks" className="settings-anchor">
    <div className="modal-heading"><div><p className="eyebrow">Tasks</p><h3>定时任务</h3></div></div>
    <p className="settings-note">创建一次本地提醒。Aika 关闭时不能执行；错过超过一分钟不补发。创建即允许在到期时显示这条提醒并尝试系统通知。</p>
    <form onSubmit={submit}>
      <label>提醒内容<input aria-label="提醒内容" maxLength={500} value={text} onChange={e => setText(e.target.value)} required /></label>
      <label>到期时间（本地）<input aria-label="到期时间" type="datetime-local" step="1" value={at} onChange={e => setAt(e.target.value)} required /></label>
      <button disabled={busy} type="submit">创建提醒</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {service.error() && <p role="alert">{service.error()}</p>}
    {tasks.length === 0 && <p>暂无任务</p>}
    {tasks.map(task => <article key={task.taskId} className="side-card">
      <p>{task.text}</p><p>{new Date(task.trigger.kind === "time" ? task.trigger.at : task.nextRunAt).toLocaleString()} · {labels[task.state]}</p>
      {task.state === "done" && <p>{task.notification ? "系统通知已发送" : "提醒已记录，系统通知未发送"}</p>}
      <small>任务 ID：{task.taskId}</small>
      {task.state === "pending" && <button disabled={busy} onClick={() => void run(() => service.update(task.taskId, "pause"))}>暂停</button>}
      {task.state === "paused" && <button disabled={busy} onClick={() => void run(() => service.update(task.taskId, "resume"))}>恢复</button>}
      {["pending", "paused"].includes(task.state) && <button disabled={busy} onClick={() => void run(() => service.update(task.taskId, "cancel"))}>取消</button>}
    </article>)}
  </section>;
}
