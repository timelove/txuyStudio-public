/**
 * 手机端模拟器:模拟 Flutter app 扫码配对后的完整首连流程。
 * 凭证来源 = 桌面端 relay.json(等价于扫了二维码)。
 * 前置:relay.exe 在跑 + 桌面端(txuyStudio dev)已上线。
 * 运行:bun relay/sim/phone-sim.ts
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const relayDir = join(dirname(fileURLToPath(import.meta.url)), "..");
// 桌面端(dev)的 relay.json:身份字段(deviceId/pairKey)由桌面端 load_or_init 生成。
const desktop = JSON.parse(readFileSync(process.env.APPDATA + "/com.txuystudio.terminal/txuyStudio-dev/relay.json", "utf8"));

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
}

// ---- E2E 加密(与 Rust crypto.rs 同格式:base64(nonce[12]||ct+tag));
// Bun webcrypto 不支持 ChaCha20-Poly1305,用 @noble/ciphers 纯 JS 实现(跨运行时稳) ----
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
const keyBytes = Uint8Array.from(atob(desktop.pairKey), (c) => c.charCodeAt(0));

function seal(plain: string): string {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = chacha20poly1305(keyBytes, nonce).encrypt(new TextEncoder().encode(plain));
  const buf = new Uint8Array(12 + ct.length);
  buf.set(nonce); buf.set(ct, 12);
  return btoa(String.fromCharCode(...buf));
}
function openB64(b64: string): string {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pt = chacha20poly1305(keyBytes, raw.slice(0, 12)).decrypt(raw.slice(12));
  return new TextDecoder().decode(pt);
}

// ---- WS 帧收发 ----
const ws = new WebSocket(desktop.url);
let reqId = 0;
const pending = new Map<string, (v: any) => void>();
const events: any[] = [];
ws.onmessage = async (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "recv") {
    const plain = JSON.parse(openB64(m.enc));
    if (plain.id && pending.has(plain.id)) { pending.get(plain.id)!(plain); pending.delete(plain.id); }
    else if (plain.ev) events.push(plain);
  }
};
await new Promise((res) => { ws.onopen = res; });

ws.send(JSON.stringify({ type: "hello", userId: desktop.userId, deviceId: "dev-phone-sim", role: "phone", token: desktop.token }));
console.log("场景A: 配对握手 + 项目/用量/会话(密文全链路)");
{
  const ask = async (method: string, params: Record<string, unknown> = {}) => {
    const id = `req-${++reqId}`;
    const enc = seal(JSON.stringify({ id, method, params }));
    ws.send(JSON.stringify({ type: "send", to: desktop.deviceId, enc }));
    return await new Promise<any>((res) => pending.set(id, res));
  };

  const pair = await ask("pair.hello", { deviceId: "dev-phone-sim" });
  check("pair.hello ok + 返回本机名", pair.ok === true && typeof pair.result?.name === "string", pair);

  const projects = await ask("projects.list");
  check("projects.list ok + 结构", projects.ok === true && Array.isArray(projects.result?.projects), projects);
  if (projects.ok) console.log(`    项目数: ${projects.result.projects.length},示例:`, projects.result.projects[0]?.name ?? "(无)");

  const usage = await ask("usage.summary", { days: 7 });
  check("usage.summary ok", usage.ok === true && Array.isArray(usage.result?.rollups), usage);

  const sessions = await ask("sessions.list", { kind: "claude" });
  check("sessions.list ok", sessions.ok === true && Array.isArray(sessions.result), sessions);

  const bad = await ask("commands.run", { tabId: "x", text: "echo hi" });
  check("未实现方法显式回错(不超时)", bad.ok === false && /not implemented/.test(bad.error), bad);
}

console.log("场景B: 拉取离线快照(桌面端上线即推)");
{
  ws.send(JSON.stringify({ type: "snapshot_get", from: desktop.deviceId }));
  const snapFrame: any = await new Promise((res) => {
    const t = setTimeout(() => res(null), 5000);
    const orig = ws.onmessage;
    ws.onmessage = async (e: any) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "snapshot_data") { clearTimeout(t); ws.onmessage = orig; orig?.(e); res(m); }
      else { orig?.(e); }
    };
  });
  check("快照存在", !!snapFrame?.enc && snapFrame.ts > 0, snapFrame);
  if (snapFrame?.enc) {
    const snap = JSON.parse(openB64(snapFrame.enc));
    check("快照解密 v=1 + 含 projects/usage", snap.v === 1 && !!snap.projects && !!snap.usage, Object.keys(snap));
    console.log(`    快照生成于: ${snap.generatedAt}`);
  }
}

ws.close();
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
