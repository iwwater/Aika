import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // onnxruntime-web 默认把 wasm 内联进 bundle，其中 WebGPU(jsep) 那份就有 27 MB。
  // 这个 resolve 条件切到「wasm 走外部文件」的构建，配合 sileroVad.ts 里的
  // `wasmPaths = "/ort/"`，运行时从 public/ort 加载——由 npm run sync:ort 生成。
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
