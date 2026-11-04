import { defineConfig } from "vite";
import path from "path";

/**
 * 内核后端构建配置（档2·真·内核后端）。
 *
 * 把 src/kernel.ts 打成 dist/kernel.js（CJS），运行在思源**内核 Node 进程**里，
 * 与前端 dist/index.js 共存于 dist/（`emptyOutDir:false` 以免清掉 index.js）。
 *
 * - `siyuan` 是内核注入的全局变量（非 import），保持为自由全局引用即可，不 external 也不会被打包；
 *   这里仍把它列入 external 与前端产物保持一致，对未 import 的全局无副作用。
 * - reminder/webhook/i18n/date/ics 等模块均为 Node 安全（无 DOM/window），可安全打进内核包。
 * - **切勿把 `crypto` 列入 external / 切勿在 kernel 里 `require("crypto")`**：思源内核运行在 Go 内置的
 *   goja 解释器（非 Node），`require("crypto")` 这种 Node 内置解析不了 → kernel.js 加载即崩、插件 never running。
 *   钉钉加签的 HMAC-SHA256 改用 src/core/hmac-sha256.ts（纯 JS 实现，已对照 RFC 测试向量验证）。
 * - console / setTimeout / fetch / URL / AbortController 均为 Node 18+ 全局，无需引入；`fetch` 在 goja 内核里也可用。
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false, // 关键：不清理 dist，保留前端的 index.js / index.css
    minify: false,
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, "src/kernel.ts"),
      name: "Kernel",
      fileName: "kernel",
      formats: ["cjs"]
    },
    rollupOptions: {
      external: ["siyuan"],
      output: {
        entryFileNames: "kernel.js"
      }
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  }
});
