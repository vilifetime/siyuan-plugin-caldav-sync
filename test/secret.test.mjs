/**
 * 凭据存储回归测试（对应「不管手机端还是 PC 端总是丢密码」那一轮）
 *
 * 真机证据：密文存在 data/storage/petal/（**参与思源云同步**），而旧版密钥派生自 conf/
 * （不参与同步）→ 手机写入的密文 PC 解不开、PC 写入的手机解不开，两端互相把对方的密文
 * 覆盖成空串。修复后：主密钥随数据走（enc:v3），且「解不开」绝不允许覆盖磁盘上的密文。
 *
 * 这里锁死四条不许再犯的规矩：
 *   1. 换设备（只有数据、没有本机密钥）时，拿到 keyring 就能解开；
 *   2. 「密钥未就绪」是 unavailable（可重试），不是「密码损坏」；
 *   3. 解密失败时 persist() 必须原样写回密文，绝不写空串；
 *   4. 旧 v2 密文仍要能解，并自动升级为 v3。
 */
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, ".test-secret");

execSync(
  `npx tsc src/core/types.ts src/core/secret.ts src/core/store.ts --outDir "${outDir}" --rootDir src/core ` +
    `--module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck --strict false`,
  { cwd: root, stdio: "inherit" }
);
// 仓库 package.json 声明了 "type": "module"，这里给编译产物划一个 CommonJS 作用域
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "commonjs" }));

const require = createRequire(import.meta.url);
const secret = require(path.join(outDir, "secret.js"));
const { CalStore } = require(path.join(outDir, "store.js"));

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log("  ✓ " + name);
    passed++;
  } catch (e) {
    console.error("  ✗ " + name + "\n      " + (e?.message || e));
    process.exitCode = 1;
  }
}

/** 模拟「换一台设备 / 换一次安装」：本机不残留任何密钥 */
function freshDevice() {
  secret.resetSecretKey();
}

/** 手工造一份 v2 密文（旧版 = PBKDF2(设备标识)），用于验证向后兼容与自动升级 */
async function makeV2(plain, seedStr) {
  const enc = new TextEncoder();
  const base = await webcrypto.subtle.importKey("raw", enc.encode(seedStr), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("siyuan-caldav-sync-v2"), iterations: 100000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plain)));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv, 0);
  joined.set(ct, iv.length);
  return "enc:v2:" + Buffer.from(joined).toString("base64");
}

/** 一把与本机无关的随机密钥（模拟「另一台设备写入的密文」） */
function strangeKey() {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

console.log("---- 凭据存储：密钥随数据走 + 永不覆盖密文 ----");

await t("v3：主密钥随数据走 —— 换设备后拿到 keyring 就能解开", async () => {
  freshDevice();
  const cipher = await secret.encryptSecret("跨设备密码-pass");
  assert.ok(cipher.startsWith("enc:v3:"), "应为 v3 密文: " + cipher.slice(0, 10));
  const keyring = secret.getKeyring();
  assert.ok(keyring.length > 0, "加密时应生成主密钥");

  freshDevice();
  assert.strictEqual(await secret.decryptSecret(cipher), "", "新设备尚无密钥，此时解不开是正常的");

  secret.adoptKeyring(keyring); // 云同步把 keyring 一起带过来了
  assert.strictEqual(await secret.decryptSecret(cipher), "跨设备密码-pass", "密钥到位后必须能解开");
});

await t("v3：本机没有密钥时是 unavailable（可重试），不能被当成密码损坏", async () => {
  freshDevice();
  const cipher = await secret.encryptSecret("待解密"); // 生成密钥后再丢掉
  freshDevice();
  const r = await secret.decryptSecretEx(cipher);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unavailable", "密钥未就绪 ≠ 密码损坏");
});

await t("v3：密钥不匹配时是 mismatch（才需要用户重输）", async () => {
  freshDevice();
  const cipher = await secret.encryptSecret("别人的密码");
  freshDevice();
  secret.adoptKeyring(strangeKey());
  const r = await secret.decryptSecretEx(cipher);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "mismatch");
});

await t("store：解密失败时 persist() 必须原样写回密文，绝不写空串", async () => {
  freshDevice();
  secret.adoptKeyring(strangeKey()); // 有密钥，但对不上
  const cipher = "enc:v3:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 无法解开的密文
  let saved = null;
  const st = new CalStore({
    loadData: async () => ({ settings: { password: cipher }, items: [], sync: {} }),
    saveData: async (d) => {
      saved = d;
    }
  });
  await st.load();
  assert.strictEqual(st.secretBroken, true, "应提示用户重新输入密码");
  await st.persist();
  assert.strictEqual(
    saved.settings.accounts[0].password,
    cipher,
    "解密失败时落盘仍是原密文（曾经这里写空串，把密码永久抹掉了）"
  );
});

await t("store：密钥未就绪时不判定损坏，也不动磁盘上的密文", async () => {
  freshDevice();
  const cipher = await secret.encryptSecret("等密钥到位");
  freshDevice();
  let saved = null;
  const st = new CalStore({
    loadData: async () => ({ settings: { password: cipher }, items: [], sync: {} }),
    saveData: async (d) => {
      saved = d;
    }
  });
  await st.load();
  assert.strictEqual(st.secretBroken, false, "密钥未就绪不能判定密码损坏");
  assert.strictEqual(st.pendingUnlock, true, "应处于待解密状态，等 retryUnlock()");
  await st.persist();
  assert.strictEqual(saved.settings.accounts[0].password, cipher, "待解密期间也必须保留原密文");
});

await t("store：主密钥随数据落盘，换实例只靠数据就能解开（模拟重启/换端口/换设备）", async () => {
  freshDevice();
  let saved = null;
  const a = new CalStore({
    loadData: async () => ({ settings: {}, items: [], sync: {} }),
    saveData: async (d) => {
      saved = d;
    }
  });
  await a.load();
  // 多账户后密码在 accounts[0] 上；空 settings 迁不出账户，先补一个
  if (!a.settings.accounts.length) {
    a.settings.accounts.push({
      id: "t1", name: "t", enabled: true, serverUrl: "", username: "", password: "",
      calendarPath: "", serverType: "caldav", channel: "auto", conflict: "server",
      pastDays: 90, futureDays: 370, calendars: []
    });
  }
  a.settings.accounts[0].password = "重启后仍可用";
  await a.persist();
  assert.ok(saved.keyring && saved.keyring.length > 0, "主密钥必须随数据落盘");
  assert.ok(String(saved.settings.accounts[0].password).startsWith("enc:v3:"), "密码应是 v3 密文");

  freshDevice(); // 清掉进程内的密钥，逼新实例只靠落盘数据
  const b = new CalStore({ loadData: async () => saved, saveData: async () => {} });
  await b.load();
  assert.strictEqual(b.settings.accounts[0].password, "重启后仍可用", "仅凭落盘数据即可恢复密码");
  assert.strictEqual(b.secretBroken, false);
});

await t("兼容：v2 旧密文仍能解开，并自动升级为 v3", async () => {
  const SEED = "sysid-abc|D:/SiYuan";
  secret.setSecretSeed(SEED);
  const v2 = await makeV2("旧版密码", SEED);
  assert.strictEqual(await secret.decryptSecret(v2), "旧版密码", "旧密文必须还能解");

  freshDevice();
  secret.setSecretSeed(SEED);
  let saved = null;
  const st = new CalStore({
    loadData: async () => ({ settings: { password: v2 }, items: [], sync: {} }),
    saveData: async (d) => {
      saved = d;
    }
  });
  await st.load();
  assert.strictEqual(st.settings.accounts[0].password, "旧版密码");
  assert.strictEqual(st.secretBroken, false);
  await st.persist();
  assert.ok(String(saved.settings.accounts[0].password).startsWith("enc:v3:"), "保存时应自动升级为 v3");
  assert.ok(saved.keyring, "升级的同时落盘 v3 主密钥");
});

await t("过渡期：旧版把 enc:v3 当明文再包一层，新版必须逐层剥回真密码", async () => {
  const SEED = "sysid-transition|D:/SiYuan";
  freshDevice();
  secret.setSecretSeed(SEED);
  const inner = await secret.encryptSecret("过渡期密码"); // 新版写出的 v3 密文
  const keyring = secret.getKeyring();
  assert.ok(inner.startsWith("enc:v3:"));

  // 旧版的 isEncrypted() 不认 enc:v3: → 当成「旧版明文密码」，又加密了一遍
  const wrapped = await makeV2(inner, SEED);
  assert.strictEqual(await secret.decryptSecret(wrapped), inner, "只剥外层得到的是内层密文");

  freshDevice();
  secret.setSecretSeed(SEED);
  secret.adoptKeyring(keyring); // 云同步把主密钥带过来了
  const deep = await secret.decryptSecretDeep(wrapped);
  assert.strictEqual(deep.ok, true);
  assert.strictEqual(deep.value, "过渡期密码", "必须一路剥到真正的明文");
});

await t("过渡期：store.load() 从套娃密文里恢复密码，并重存为 v3", async () => {
  const SEED = "sysid-transition2|D:/SiYuan";
  freshDevice();
  secret.setSecretSeed(SEED);
  const inner = await secret.encryptSecret("套娃密码");
  const keyring = secret.getKeyring();
  const wrapped = await makeV2(inner, SEED);

  freshDevice();
  secret.setSecretSeed(SEED);
  let saved = null;
  const st = new CalStore({
    loadData: async () => ({ settings: { password: wrapped }, items: [], sync: {}, keyring }),
    saveData: async (d) => {
      saved = d;
    }
  });
  await st.load();
  assert.strictEqual(st.secretBroken, false, "这不是「密码损坏」，只是被套了一层");
  assert.strictEqual(st.settings.accounts[0].password, "套娃密码", "不能把内层密文当成密码用");
  await st.persist();
  assert.ok(String(saved.settings.accounts[0].password).startsWith("enc:v3:"), "应重存为新格式");
  assert.strictEqual(await secret.decryptSecret(saved.settings.accounts[0].password), "套娃密码");
});

await t("兼容：v2 密文在 load() 阶段就自动升级为 v3，不必等用户手动保存", async () => {
  const SEED = "sysid-upgrade|D:/SiYuan";
  freshDevice();
  secret.setSecretSeed(SEED);
  const v2 = await makeV2("旧版密码2", SEED);

  freshDevice();
  secret.setSecretSeed(SEED);
  let saved = null;
  const st = new CalStore({
    loadData: async () => ({ settings: { password: v2 }, items: [], sync: {} }),
    saveData: async (d) => {
      saved = d;
    }
  });
  await st.load();
  await new Promise((r) => setTimeout(r, 30)); // 等 load() 里那次异步回写落地
  assert.ok(saved, "本机解得开就应该主动收口回写一次");
  assert.ok(String(saved.settings.accounts[0].password).startsWith("enc:v3:"), "自动升级为 v3");
  assert.ok(saved.keyring, "同时落盘 v3 主密钥，别的设备才解得开");
});

await t("基础：空值、明文、随机 iv 等既有约定不回退", async () => {
  freshDevice();
  assert.strictEqual(await secret.encryptSecret(""), "");
  assert.strictEqual(await secret.decryptSecret(""), "");
  assert.strictEqual(await secret.decryptSecret("legacy-plain-pwd"), "legacy-plain-pwd");
  const a = await secret.encryptSecret("same");
  const b = await secret.encryptSecret("same");
  assert.notStrictEqual(a, b, "同一明文两次加密应因随机 iv 而不同");
  assert.strictEqual(await secret.decryptSecret(a), "same");
  assert.strictEqual(await secret.decryptSecret(b), "same");
});

console.log(`\n[secret] 合计 ${passed} 项通过`);
