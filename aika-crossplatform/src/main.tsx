import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { createAikaKernel } from "./app/composition";

/**
 * 先装配再渲染。
 *
 * 界面里的存储、密钥、通知、请求出口都由宿主插件提供，装配没完成就渲染的话，
 * 桌面端会先用上浏览器默认实现——记忆写进 localStorage 而不是 SQLite，
 * 而且没有任何报错。所以这里等内核 ready 再挂载。
 *
 * 装配失败也照样渲染：界面本身能显示存储故障，白屏什么都告诉不了用户。
 */
function render() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void createAikaKernel()
  .then(({ report }) => {
    if (!report.ok) console.error("[aika] kernel failed to start", report.failed);
  })
  .catch((error) => console.error("[aika] composition threw", error))
  .finally(render);
