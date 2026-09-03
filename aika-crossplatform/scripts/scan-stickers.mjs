/**
 * 把 public/stickers/ 里还没登记的图片补进 manifest.json。
 *
 * 只补 id 和 file，`when` 留空给人填——什么时候该用这张图，脚本猜不出来，
 * 猜错了她就会在错的时候发错的表情。**`when` 空着的条目不会进提示词**，
 * 所以留白是安全的：她看不见，也就选不到。
 *
 * 已经登记过的条目一个字都不动，重复跑没有副作用。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "stickers");
const manifestPath = join(dir, "manifest.json");
const IMAGE_TYPES = new Set([".png", ".gif", ".webp", ".jpg", ".jpeg"]);

if (!existsSync(dir)) {
  console.log("public/stickers/ 不存在，先建这个目录再把图片放进去。");
  process.exit(0);
}

let manifest = { stickers: [] };
if (existsSync(manifestPath)) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest = Array.isArray(parsed) ? { stickers: parsed } : parsed;
    if (!Array.isArray(manifest.stickers)) manifest.stickers = [];
  } catch (error) {
    // 手写坏了的清单不能被脚本一把覆盖掉：里面的 when 是人写的，重打一遍很烦。
    console.error(`manifest.json 解析不了，先修一下再跑：${error.message}`);
    process.exit(1);
  }
}

const known = new Set(manifest.stickers.map((sticker) => sticker?.file));
const files = readdirSync(dir).filter((file) => IMAGE_TYPES.has(extname(file).toLowerCase()));
const added = [];

for (const file of files.sort()) {
  if (known.has(file)) continue;
  const id = file.slice(0, file.length - extname(file).length).replace(/\s+/g, "-").toLowerCase();
  manifest.stickers.push({ id, file, when: "" });
  added.push(id);
}

const missing = manifest.stickers.filter((sticker) => !sticker.when?.trim()).map((sticker) => sticker.id);
const orphans = manifest.stickers.filter((sticker) => !files.includes(sticker.file)).map((sticker) => sticker.file);

if (added.length) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`新登记 ${added.length} 张：${added.join("、")}`);
} else {
  console.log(`目录里的 ${files.length} 张图片都已经登记过了。`);
}

if (missing.length) {
  console.log(`\n还没写 when 的（她看不见这些，等于没放）：\n  ${missing.join("\n  ")}`);
  console.log("在 manifest.json 里给每张写一句「什么时候该用它」。");
}
if (orphans.length) {
  console.log(`\n清单里有、目录里找不到文件的：\n  ${orphans.join("\n  ")}`);
}
