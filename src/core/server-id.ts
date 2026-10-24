/**
 * 服务器身份判定：判断两个 CalDAV 地址是不是「同一台服务器」。
 *
 * ## 为什么需要它
 *
 * 切服务器后，本地会留下一堆旧服务器的条目（2026-10-24 实测：从 iCloud 换到
 * 自建 Baïkal 后残留 40 条）。它们既不显示也不同步，却一直占着本地存储，
 * 换回去时又「诈尸」出现。要清理就得先能判断「这条属于哪台服务器」。
 *
 * ## 判定口径：origin（协议 + 主机 + 端口），不是地址字符串
 *
 * - 同一台服务器的多个日历集合（`/dav.php/calendars/x/`、`/dav.php/calendars/y/`）
 *   origin 相同 → 一起保留。**绝不能按整串地址比**，否则同一台服务器上
 *   第二个日历的条目会被当成「别的服务器」误删。
 * - 端口不同视为不同实例（`nas:5232` 与 `nas:5808` 是两套服务）。
 * - iCloud 的节点主机名（`caldav.icloud.com` / `p12-caldav.icloud.com`）
 *   归一到同一个身份 —— 它们是同一服务的不同入口，按主机名比会把
 *   iCloud 自己的条目判成「其他服务器」。
 */

/** iCloud 及其节点主机名的判定：主域名或任意子域 */
function isIcloudHost(host: string): boolean {
  return host === "icloud.com" || host.endsWith(".icloud.com");
}

/**
 * 取地址的「服务器身份」。
 *
 * 返回形如 `http://nas.bonebear.cn:5808`、`https://caldav.icloud.com`（iCloud 归一为 `icloud`）。
 * 空地址返回空串（调用方据此判定「还没配服务器」，不做任何清理）。
 *
 * 解析不了的地址（缺协议的裸主机名等）退化成「去掉尾部斜杠的小写字符串」，
 * 宁可粗一点也不要抛错 —— 这个函数要能在任意历史数据上安全跑。
 */
export function serverOriginOf(url: string): string {
  const raw = (url || "").trim();
  if (!raw) return "";
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.hostname) {
    // 不是绝对 URL（或缺协议被 URL 当成 scheme 解析了，如 `nas.bonebear.cn:5232`
    // ——此时 hostname 是空的）。统一退化成「去掉协议头与尾部斜杠的小写字符串」。
    //
    // ⚠️ 退化的必须是**带端口**的裸串：若这里只留主机名，`nas:5232` 与 `nas:5808`
    //    会归成同一个身份 → 旧服务器的条目永远清不掉（用户看不到效果）。
    return raw.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/+$/, "");
  }
  const host = parsed.hostname.toLowerCase();
  if (isIcloudHost(host)) return "icloud";
  const proto = parsed.protocol.toLowerCase();
  // URL 会把默认端口（80/443）归一掉，非默认端口保留 —— 这正是要的粒度
  return parsed.port ? `${proto}//${host}:${parsed.port}` : `${proto}//${host}`;
}

/** 两个地址是不是同一台服务器 */
export function isSameServer(a: string, b: string): boolean {
  const oa = serverOriginOf(a);
  const ob = serverOriginOf(b);
  return !!oa && oa === ob;
}

/**
 * 服务器地址是否「换了一台」。
 *
 * 只有两边都非空、且身份不同才算换了服务器：
 * - 两边相同 → 没换；
 * - 原来为空 → 是首次配置，不是「切换」，不该触发清理；
 * - 新的为空 → 用户正在清空地址，还没配上新服务器，更不该清理。
 */
export function serverChanged(oldUrl: string, newUrl: string): boolean {
  const o = serverOriginOf(oldUrl);
  const n = serverOriginOf(newUrl);
  return !!o && !!n && o !== n;
}
