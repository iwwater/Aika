/**
 * MVP-07 AC-C runner: serves the probe page with the project's Vite dev server and
 * loads it in Playwright Chromium (the same engine family as Tauri's WebView2).
 *
 * Usage: node probe/live2d/verify.mjs [--channel msedge|chromium]
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const PORT = 4173;
const PAGE_URL = `http://127.0.0.1:${PORT}/probe/live2d/`;
const channelArg = process.argv.find((value) => value.startsWith("--channel="));
const channel = channelArg ? channelArg.split("=")[1] : undefined;

const server = spawn(
  `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
  { cwd: process.cwd(), shell: true, stdio: "ignore" },
);

async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(PAGE_URL);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(1000);
  }
  return false;
}

let browser;
let exitCode = 0;
try {
  if (!(await waitForServer())) throw new Error(`vite dev server did not serve ${PAGE_URL}`);

  browser = await chromium.launch({
    channel,
    args: [
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 640, height: 760 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("[console.error]", message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) console.log("[http]", response.status(), response.url());
  });

  await page.goto(PAGE_URL, { waitUntil: "load" });
  await page.waitForFunction(() => window.__probe?.done === true, null, { timeout: 90_000 });

  const report = await page.evaluate(() => window.__probe);
  await page.screenshot({ path: "probe/live2d/probe-screenshot.png" });

  console.log(JSON.stringify({ channel: channel ?? "bundled-chromium", report }, null, 2));

  if (report.fatal || report.error) exitCode = 1;
  if (typeof report.frameDuringMotion?.opaquePixels !== "number") exitCode = 1;
} catch (error) {
  console.error("PROBE_FAILED:", error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill();
  process.exitCode = exitCode;
}
