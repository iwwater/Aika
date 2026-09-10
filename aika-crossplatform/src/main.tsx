import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { createAikaKernel } from "./app/composition";
import { KernelProvider } from "./app/kernelContext";
import type { AikaKernel } from "./kernel";
import type { PresentationServices } from "./presentation/fallback";

/**
 * 先装配再渲染。
 *
 * 界面里的存储、密钥、通知、请求出口都由宿主插件提供，装配没完成就渲染的话，
 * 桌面端会先用上浏览器默认实现——记忆写进 localStorage 而不是 SQLite，
 * 而且没有任何报错。所以这里等内核 ready 再挂载。
 *
 * 装配失败也照样渲染：界面本身能显示存储故障，白屏什么都告诉不了用户。
 * 这时内核不可用，展示层服务由组合根返回的同一批 Presenter 兜底。
 */
async function boot() {
  let kernel: AikaKernel | null = null;
  let presentation: PresentationServices | null = null;
  try {
    const composition = await createAikaKernel();
    kernel = composition.kernel;
    presentation = composition.presentation;
    if (!composition.report.ok) console.error("[aika] kernel failed to start", composition.report.failed);
  } catch (error) {
    console.error("[aika] composition threw", error);
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <KernelProvider kernel={kernel} presentation={presentation}>
        <App />
      </KernelProvider>
    </React.StrictMode>,
  );
}

void boot();
