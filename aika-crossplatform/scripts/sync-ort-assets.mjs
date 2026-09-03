/**
 * 把 onnxruntime-web 的 wasm 运行时复制到 public/ort/。
 *
 * 为什么不直接提交进仓库：那是 14 MB 的依赖构建产物，版本必须和 node_modules 里
 * 装的那个严格一致，提交进去只会带来「装了新版本但 wasm 还是旧的」这类问题。
 * 所以 public/ort/ 走 ignore，由 predev / prebuild 每次生成。
 *
 * 只取非 jsep 的那一份：Silero VAD 才 2 MB，用不上 WebGPU，
 * 而 jsep 版本大了将近一倍。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "onnxruntime-web", "dist");
const to = join(root, "public", "ort");
const files = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];

if (!existsSync(from)) {
  console.error("找不到 onnxruntime-web，请先 npm install");
  process.exit(1);
}

mkdirSync(to, { recursive: true });
for (const file of files) copyFileSync(join(from, file), join(to, file));
console.log(`已同步 ${files.length} 个 onnxruntime 运行时文件到 public/ort/`);
