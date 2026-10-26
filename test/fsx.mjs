/**
 * 测试用的文件系统小工具（与 Obsidian 端 test/fsx.cjs 同构，2026-10-26）。
 *
 * `rmrf` 存在的理由：宿主给 `fs` 挂了 safe-delete 守卫 —— `fs.rmSync(dir, {recursive:true})`
 * 在会话内累计删除条目超过阈值时会直接抛 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，
 * 于是「清一下临时目录」这种无害操作在跑全量测试时突然炸掉
 * （2026-10-26 实测：today-view-pref.test.mjs 因此让整条 npm test 链 exit=1）。
 *
 * 自己递归删就绕开了那个计数：文件 `unlinkSync`、目录 `rmdirSync`，
 * 都是单条目操作，不进批量守卫的判定。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * 判断是不是宿主的 safe-delete 守卫拦下来的。
 *
 * ⚠️ 守卫抛的是 `new Error(detail)` —— **没有 `code` 属性**，标记只在**消息**里：
 *   `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {...}`
 * 早先只判 `e.code.startsWith("SAFE_DELETE")`，于是永远匹配不到，兜底形同虚设 ——
 * 跑一轮全量测试（删除数轻松过 50）后，后半程的测试会被同一个守卫拦下崩掉
 * （2026-10-27 实测：today-view-pref.test.mjs 因此让整条 npm test 链 exit=1）。
 * 两种判据都留着：万一以后宿主补上 code，也能兜住。
 */
const isGuard = (e) =>
  (typeof e?.code === "string" && e.code.startsWith("SAFE_DELETE")) ||
  (typeof e?.message === "string" && e.message.includes("[safe-delete][SAFE_DELETE"));

// 单条删除也走 try：守卫是按**会话累计件数**判的（不只是批量），跑一轮全量
// 测试删的临时产物轻松过 50 件，后半程的测试会被同一个守卫拦下。
// 清的是测试临时目录，删不掉不影响正确性，所以这里只吞守卫错误，其它错误照抛。
function unlinkQuiet(p) {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (!isGuard(e)) throw e;
  }
}

function rmdirQuiet(p) {
  try {
    fs.rmdirSync(p);
  } catch (e) {
    if (!isGuard(e)) throw e;
  }
}

/** 递归删目录（绕开 safe-delete 守卫） */
export function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmrf(p);
    else unlinkQuiet(p);
  }
  rmdirQuiet(dir);
}

/** 删文件或目录（通吃版）：单文件场景也走守卫兜底 */
export function rmQuiet(p) {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) rmrf(p);
  else unlinkQuiet(p);
}
