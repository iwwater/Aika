/// <reference types="vite/client" />

// pixi.js 8.20.1 的 exports 没有给 `./unsafe-eval` 子路径挂 types 条件（上游打包
// 疏漏），尽管 lib/unsafe-eval/init.d.ts 是存在的。Live2D renderer 需要动态导入它，
// 才能在禁 eval 的 CSP 下渲染（见 live2dRenderer.ts），这里补上模块声明。
declare module 'pixi.js/unsafe-eval';
