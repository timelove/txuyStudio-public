/**
 * 中继联调脚本(模拟桌面端+手机端,验证 protocol-v1 全场景)。
 * v4:传输层唯一身份 = 账号 session;开头登录 simtest 拿 userId/token。
 * 前置:relay.exe 已在 :8787 监听 + `relay -adduser simtest -password simpass123`。
 * 运行:bun relay/sim/sim.ts
 */
const URL_ = "ws://127.0.0.1:8787/ws";
const HTTP = "http://127.0.0.1:8787";
let USER = "";
let TOKEN = "";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
}

/** 浏览器风格 WebSocket → Promise 化消息等待器 */
class TestWS {
  ws: WebSocket;
  private waiters: { pred: (m: any) => boolean; res: (m: any) => void; timer: any }[] = [];
  /** 最近帧缓存:waitFor 挂上之前已到达的帧不再丢失(观测 race)。 */
  private recent: any[] = [];
  closed = false;
  onBye: ((reason: string) => void) | null = null;

  constructor() {
    this.ws = new WebSocket(URL_);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      this.recent.push(m);
      if (this.recent.length > 64) this.recent.shift();
      if (m.type === "bye") { this.closed = true; this.onBye?.(m.reason ?? ""); }
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const [w] = this.waiters.splice(i, 1); clearTimeout(w.timer); w.res(m); }
    };
    this.ws.onclose = () => { this.closed = true; };
  }

  opened(): Promise<void> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("connect timeout")), 3000);
      this.ws.onopen = () => { clearTimeout(t); res(); };
    });
  }

  send(o: unknown) { this.ws.send(JSON.stringify(o)); }

  /** 等到满足 pred 的帧:先查历史缓存(命中即消费移除),再挂等待器。 */
  waitFor(pred: (m: any) => boolean, ms = 3000): Promise<any> {
    const i = this.recent.findIndex(pred);
    if (i >= 0) { const [m] = this.recent.splice(i, 1); return Promise.resolve(m); }
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("waitFor timeout")), ms);
      this.waiters.push({ pred, res: (m) => { clearTimeout(t); res(m); }, timer: t });
    });
  }

  async hello(deviceId: string, role: string, token = TOKEN) {
    this.send({ type: "hello", userId: USER, deviceId, role, token });
    return this.waitFor((m) => m.type === "hello_ack");
  }

  close() { this.ws.close(); }
}

async function main() {
  console.log("场景0: 账密登录(v4 唯一身份)");
  {
    const resp = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "simpass123", client: "desktop" }),
    });
    if (resp.status === 401) {
      console.error("  ✗ 未创建测试用户:先跑  relay -adduser simtest -password simpass123");
      process.exit(1);
    }
    const j: any = await resp.json();
    check("login ok + client=desktop 回显", j.token && j.userId && j.client === "desktop", j);
    USER = j.userId;
    TOKEN = j.token;
    // mobile 端登录(同一账号,client 区分)→ 也应成功。
    const mob = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "simpass123", client: "mobile" }),
    });
    const mj: any = await mob.json();
    check("mobile 登录 ok + client=mobile 回显", mj.token && mj.client === "mobile", mj);
  }

  console.log("场景1: 错误 token 被拒");
  {
    const bad = new TestWS(); await bad.opened();
    const ack = await bad.hello("dev-bad", "phone", "wrong-token");
    check("hello_ack ok:false", ack.ok === false && ack.error === "bad token", ack);
    await new Promise((r) => setTimeout(r, 300));
    check("连接被断开", bad.closed);
  }

  console.log("场景2: 双端 hello");
  const desktop = new TestWS(); await desktop.opened();
  const phone = new TestWS(); await phone.opened();
  const dAck = await desktop.hello("dev-desktop", "desktop");
  const pAck = await phone.hello("dev-phone", "phone");
  check("desktop hello_ack ok", dAck.ok === true, dAck);
  check("phone hello_ack ok", pAck.ok === true, pAck);

  console.log("场景3: 手机 → 桌面端 密文透传");
  {
    const enc = "bm9uY2V8Y2lwaGVydGV4dA==";
    desktop.send({ type: "send", to: "dev-phone", enc: "ping-from-desktop" });
    const got = await phone.waitFor((m) => m.type === "recv");
    check("recv from=dev-desktop", got.from === "dev-desktop" && got.enc === "ping-from-desktop", got);

    phone.send({ type: "send", to: "dev-desktop", enc });
    const got2 = await desktop.waitFor((m) => m.type === "recv");
    check("recv enc 原样透传", got2.enc === enc, got2);
  }

  console.log("场景4: 离线设备 send_result");
  {
    phone.send({ type: "send", to: "dev-ghost", enc: "x" });
    const r = await phone.waitFor((m) => m.type === "send_result");
    check("offline 回执", r.ok === false && r.reason === "offline", r);
  }

  console.log("场景5: 快照 put/get");
  {
    desktop.send({ type: "snapshot_put", enc: "c2VuZA==" });
    const put = await desktop.waitFor((m) => m.type === "snapshot_result");
    check("put ok", put.ok === true, put);

    phone.send({ type: "snapshot_get", from: "dev-desktop" });
    const snap = await phone.waitFor((m) => m.type === "snapshot_data");
    check("get enc 匹配 + ts>0", snap.enc === "c2VuZA==" && snap.ts > 0, snap);

    phone.send({ type: "snapshot_get", from: "dev-ghost" });
    const none = await phone.waitFor((m) => m.type === "snapshot_data" && m.from === "dev-ghost");
    check("无快照 ts=0", none.ts === 0 && !none.enc, none);
  }

  console.log("场景6: 超 2MB 快照被拒");
  {
    // frameLimit=2.8MB(base64),构造 2.9MB enc。
    desktop.send({ type: "snapshot_put", enc: "A".repeat(2_900_000) });
    const r = await desktop.waitFor((m) => m.type === "snapshot_result" && m.ok === false, 6000);
    check("超大被拒", r.ok === false && /size limit/.test(r.reason ?? ""), r);
  }

  console.log("场景7: ping/pong");
  {
    phone.send({ type: "ping" });
    const r = await phone.waitFor((m) => m.type === "pong");
    check("pong", true, r);
  }

  console.log("场景8: 同 deviceId 顶替");
  {
    const replaced = new TestWS(); await replaced.opened();
    const ack = await replaced.hello("dev-desktop", "desktop");
    check("新连接 hello ok", ack.ok === true);
    const bye = await desktop.waitFor((m) => m.type === "bye", 3000).catch(() => null);
    check("旧连接收 bye(replaced)", bye?.reason === "replaced", bye);
    // 用 replaced 顶替者收一条消息验证它接管了路由
    phone.send({ type: "send", to: "dev-desktop", enc: "to-new-owner" });
    const got = await replaced.waitFor((m) => m.type === "recv");
    check("路由已切到新连接", got.enc === "to-new-owner", got);
    replaced.close();
  }

  // ---------- v2 账密登录场景 ----------
  // 前置:先建测试用户 —— relay -adduser simtest -password simpass123
  const HTTP = "http://127.0.0.1:8787";
  console.log("场景9: 账密登录 → session token hello");
  let sessionOk = false;
  {
    const r = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "simpass123" }),
    });
    if (r.status === 401) {
      console.log("  ⚠ 未创建测试用户:先跑  relay -adduser simtest -password simpass123  再跑本脚本");
    } else {
      const body = await r.json();
      check("login 200 + token/userId/expiresAt", r.ok && body.token && body.userId && body.expiresAt > 0, body);
      // hello 用登录返回的 userId + session token(会话归属与 config 静态 token 二选一)。
      const sess = new TestWS(); await sess.opened();
      sess.send({ type: "hello", userId: body.userId, deviceId: "dev-sess-phone", role: "phone", token: body.token });
      const ack = await sess.waitFor((m: any) => m.type === "hello_ack");
      check("session token hello ok", ack.ok === true, ack);
      sess.close();
      sessionOk = true;

      console.log("场景10: logout 后 session 失效");
      const out = await fetch(`${HTTP}/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.token }),
      });
      check("logout 204", out.status === 204, out.status);
      const sess2 = new TestWS(); await sess2.opened();
      const ack2b = await sess2.hello("dev-sess-phone", "phone", body.token);
      check("吊销后 hello 拒", ack2b.ok === false, ack2b);
      sess2.close();
    }
  }

  console.log("场景11: 错误密码 401");
  {
    const r = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "wrong-password" }),
    });
    if (r.status === 401) check("错密码 401", true);
    else if (!sessionOk) console.log("  ⚠ 跳过(未创建测试用户)");
    else check("错密码 401", false, r.status);
  }

  console.log("场景12: 伪造 session token 被拒");
  {
    const fake = "f".repeat(64);
    const ws = new TestWS(); await ws.opened();
    const ack = await ws.hello("dev-fake-sess", "phone", fake);
    check("伪造 token hello 拒", ack.ok === false, ack);
    ws.close();
  }

  // ---------- v3 vault / 管理端场景 ----------
  // 前置:管理员账号 —— relay -adduser simadmin -password simadmin123 -admin
  console.log("场景13: vault PUT/GET 往返(密文透传,中继不解释)");
  if (sessionOk) {
    const r = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "simpass123" }),
    });
    const body = await r.json();
    const auth = { Authorization: `Bearer ${body.token}` };
    const blob = JSON.stringify({ kdf: "pbkdf2-sha256", iter: 60000, salt: "c2FsdA==", data: "bm9uY2VjaXBoZXJ0ZXh0" });
    const put = await fetch(`${HTTP}/vault/dev-sim-desktop`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ blob }),
    });
    check("vault PUT 204", put.status === 204, put.status);
    const noAuth = await fetch(`${HTTP}/vault`, { headers: {} });
    check("vault GET 无 Bearer 401", noAuth.status === 401, noAuth.status);
    const got = await fetch(`${HTTP}/vault`, { headers: auth });
    const list = await got.json();
    check("vault GET 回读一致", Array.isArray(list) && list.some((v: any) => v.deviceId === "dev-sim-desktop" && v.blob === blob), list);
    const dev = await fetch(`${HTTP}/devices`, { headers: auth });
    const devList = await dev.json();
    check("devices 列表含 hello 过的设备", Array.isArray(devList) && devList.some((d: any) => d.deviceId === "dev-sess-phone"), devList);
  } else {
    console.log("  ⚠ 跳过(未创建测试用户)");
  }

  console.log("场景14: admin API(管理员通 / 普通用户 403)");
  {
    const loginAdmin = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simadmin", password: "simadmin123" }),
    });
    if (loginAdmin.status === 401) {
      console.log("  ⚠ 未创建管理员:先跑  relay -adduser simadmin -password simadmin123 -admin  再跑本脚本");
    } else {
      const admin = await loginAdmin.json();
      check("login 返回 isAdmin", admin.isAdmin === true, admin);
      const aAuth = { Authorization: `Bearer ${admin.token}`, "content-type": "application/json" };
      const users = await fetch(`${HTTP}/admin/users`, { headers: aAuth });
      const userList = await users.json();
      check("admin GET /users", users.ok && Array.isArray(userList) && userList.some((u: any) => u.username === "simadmin" && u.isAdmin === true), userList);
      // 普通用户访问 admin API → 403
      const uLogin = await fetch(`${HTTP}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "simtest", password: "simpass123" }),
      });
      const plain = await uLogin.json();
      check("普通用户 login isAdmin=false", plain.isAdmin === false, plain);
      const forbidden = await fetch(`${HTTP}/admin/users`, { headers: { Authorization: `Bearer ${plain.token}` } });
      check("普通用户 admin API 403", forbidden.status === 403, forbidden.status);
      // 新建用户 + 删除(管理端闭环,用完即清)
      const create = await fetch(`${HTTP}/admin/users`, {
        method: "POST",
        headers: aAuth,
        body: JSON.stringify({ username: "simtemp2", password: "simtemp2345", orgs: [] }),
      });
      check("admin 建用户 201", create.status === 201, create.status);
      const kill = await fetch(`${HTTP}/admin/sessions/kill`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ username: "simtemp2" }),
      });
      check("admin 吊销会话", kill.ok, kill.status);
      const del = await fetch(`${HTTP}/admin/users/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ username: "simtemp2" }),
      });
      check("admin 删用户 204", del.status === 204, del.status);
      // 短密码被拒(密码策略)
      const weak = await fetch(`${HTTP}/admin/users`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ username: "simweak", password: "123", orgs: [] }),
      });
      check("短密码创建被拒 400", weak.status === 400, weak.status);
    }
  }

  console.log("场景15: 注册开关 + 自助改密闭环");
  if (sessionOk) {
    // 注册:默认 config 无 allowRegister → 403(私有部署不开放)。
    const reg = await fetch(`${HTTP}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simreg", password: "simregpass1" }),
    });
    check("register 默认 403(未开放)", reg.status === 403, reg.status);
    // 自助改密:login → account/password → 旧密码 401 新密码 200 → 再改回(供下次跑)。
    const l1 = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "simpass123" }),
    });
    const b1 = await l1.json();
    const auth = { Authorization: `Bearer ${b1.token}`, "content-type": "application/json" };
    const bad = await fetch(`${HTTP}/account/password`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ oldPassword: "wrong-password", newPassword: "newpass12345" }),
    });
    check("改密旧密码错 401", bad.status === 401, bad.status);
    const short = await fetch(`${HTTP}/account/password`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ oldPassword: "simpass123", newPassword: "123" }),
    });
    check("新密码过短 400", short.status === 400, short.status);
    const chg = await fetch(`${HTTP}/account/password`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ oldPassword: "simpass123", newPassword: "simpass456" }),
    });
    check("改密 204", chg.status === 204, chg.status);
    const oldLogin = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "simpass123" }),
    });
    check("旧密码登录 401", oldLogin.status === 401, oldLogin.status);
    const newLogin = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simtest", password: "simpass456" }),
    });
    check("新密码登录 200", newLogin.status === 200, newLogin.status);
    // 改回(保证脚本可重复跑;用新会话)。
    const b2 = await newLogin.json();
    await fetch(`${HTTP}/account/password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${b2.token}`, "content-type": "application/json" },
      body: JSON.stringify({ oldPassword: "simpass456", newPassword: "simpass123" }),
    });
  } else {
    console.log("  ⚠ 跳过(未创建测试用户)");
  }

  console.log("场景16: 邀请码管理(admin)与 off 模式注册");
  {
    const loginAdmin = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simadmin", password: "simadmin123" }),
    });
    if (loginAdmin.status === 401) {
      console.log("  ⚠ 未创建管理员,跳过");
    } else {
      const admin = await loginAdmin.json();
      const aAuth = { Authorization: `Bearer ${admin.token}`, "content-type": "application/json" };
      // 生成(默认一次性 7 天)→ 列表可见 → 作废 → 列表消失。
      const gen = await fetch(`${HTTP}/admin/invites`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ note: "sim" }),
      });
      const inv = await gen.json();
      check("生成邀请码 201 + code 10 位", gen.status === 201 && typeof inv.code === "string" && inv.code.length === 10, inv);
      const list = await fetch(`${HTTP}/admin/invites`, { headers: aAuth });
      const invList = await list.json();
      check("列表含新码且 uses=0", Array.isArray(invList) && invList.some((x: any) => x.code === inv.code && x.uses === 0), invList);
      const del = await fetch(`${HTTP}/admin/invites/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ code: inv.code }),
      });
      check("作废 204", del.status === 204, del.status);
      const list2 = await fetch(`${HTTP}/admin/invites`, { headers: aAuth });
      const invList2 = await list2.json();
      check("列表已无该码", !invList2.some((x: any) => x.code === inv.code));
      // off 模式(sim config 未配 registerMode):带码注册仍 403(准入看模式,不看码)。
      const reg = await fetch(`${HTTP}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "simreg2", password: "simreg2pass", inviteCode: inv.code }),
      });
      check("off 模式带码仍 403", reg.status === 403, reg.status);
      // 普通用户无权管理邀请码。
      const uLogin = await fetch(`${HTTP}/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "simtest", password: "simpass123" }),
      });
      if (uLogin.status === 200) {
        const plain = await uLogin.json();
        const forbidden = await fetch(`${HTTP}/admin/invites`, { headers: { Authorization: `Bearer ${plain.token}` } });
        check("普通用户管理邀请码 403", forbidden.status === 403, forbidden.status);
      } else {
        console.log("  ⚠ 未创建测试用户,跳过普通用户权限检查");
      }
    }
  }

  console.log("场景17: 组织管理(admin):建组/挂组/注册进组/空组删除");
  {
    const loginAdmin = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simadmin", password: "simadmin123" }),
    });
    if (loginAdmin.status === 401) {
      console.log("  ⚠ 未创建管理员,跳过");
    } else {
      const admin = await loginAdmin.json();
      const aAuth = { Authorization: `Bearer ${admin.token}`, "content-type": "application/json" };
      // 建组(幂等清理上次残留)→ 重复 409 → 建用户挂组 → 码挂组 → 列表成员数。
      const delPre = await fetch(`${HTTP}/admin/orgs/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ name: "simorg" }),
      });
      const create = await fetch(`${HTTP}/admin/orgs`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ name: "simorg", note: "sim" }),
      });
      check("建组 201", create.status === 201 || delPre.status === 404, create.status);
      const dup = await fetch(`${HTTP}/admin/orgs`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ name: "simorg" }),
      });
      check("重复建组 409", dup.status === 409, dup.status);
      // 挂组邀请码 → 列表回显 org 名。
      const gen = await fetch(`${HTTP}/admin/invites`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ note: "org-sim", org: "simorg" }),
      });
      const inv = await gen.json();
      const invList = await (await fetch(`${HTTP}/admin/invites`, { headers: aAuth })).json();
      check("邀请码挂组回显 org", Array.isArray(invList) && invList.some((x: any) => x.code === inv.code && x.org === "simorg"), inv.org);
      // 非空组删除 409;建用户挂组后成员数 +1。
      const mkUser = await fetch(`${HTTP}/admin/users`, {
        method: "POST", headers: aAuth,
        body: JSON.stringify({ username: "simorguser", password: "simorguser123", orgs: ["simorg"] }),
      });
      check("建用户挂组 201", mkUser.status === 201, mkUser.status);
      const orgList = await (await fetch(`${HTTP}/admin/orgs`, { headers: aAuth })).json();
      check("orgs 列表成员数", Array.isArray(orgList) && orgList.some((o: any) => o.name === "simorg" && o.members >= 1), orgList);
      const delBusy = await fetch(`${HTTP}/admin/orgs/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ name: "simorg" }),
      });
      check("非空组删除 409", delBusy.status === 409, delBusy.status);
      // 清理:删挂组用户 → 删组 204 → 再删 404;作废挂组码。
      await fetch(`${HTTP}/admin/users/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ username: "simorguser" }),
      });
      await fetch(`${HTTP}/admin/invites/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ code: inv.code }),
      });
      const del = await fetch(`${HTTP}/admin/orgs/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ name: "simorg" }),
      });
      check("空组删除 204", del.status === 204, del.status);
      const delAgain = await fetch(`${HTTP}/admin/orgs/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ name: "simorg" }),
      });
      check("删不存在的组 404", delAgain.status === 404, delAgain.status);
    }
  }

  console.log("场景18: v5 多组织 + 管理员组织(admins)");
  {
    const loginAdmin = await fetch(`${HTTP}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "simadmin", password: "simadmin123" }),
    });
    if (loginAdmin.status === 401) {
      console.log("  ⚠ 未创建管理员,跳过");
    } else {
      const admin = await loginAdmin.json();
      check("admin 登录 isAdmin 来自 admins 组", admin.isAdmin === true, admin);
      const aAuth = { Authorization: `Bearer ${admin.token}`, "content-type": "application/json" };
      // admins 内置存在且不可删。
      const orgList = await (await fetch(`${HTTP}/admin/orgs`, { headers: aAuth })).json();
      const adminsOrg = Array.isArray(orgList) && orgList.find((o: any) => o.name === "admins");
      check("内置 admins 组织存在", !!adminsOrg, orgList);
      const protect = await fetch(`${HTTP}/admin/orgs/delete`, {
        method: "POST", headers: aAuth, body: JSON.stringify({ name: "admins" }),
      });
      check("删 admins 组织 403", protect.status === 403, protect.status);
      // 建用户挂双组织(含 admins)→ listUsers orgs + isAdmin 派生。
      const mk = await fetch(`${HTTP}/admin/users`, {
        method: "POST", headers: aAuth,
        body: JSON.stringify({ username: "simv5", password: "simv5pass123", orgs: ["admins", "simorg2"] }),
      });
      if (mk.status === 400) {
        console.log("  ⚠ simorg2 不存在,先建:  relay -addorg simorg2  (场景前置)");
      } else {
        check("建用户 orgs=[admins,simorg2] 201", mk.status === 201, mk.status);
        const users = await (await fetch(`${HTTP}/admin/users`, { headers: aAuth })).json();
        const row = users.find((u: any) => u.username === "simv5");
        check("simv5 orgs 含双组织且 isAdmin", row && Array.isArray(row.orgs) && row.orgs.includes("admins") && row.orgs.includes("simorg2") && row.isAdmin === true, row);
        // 编辑组织移出 admins → 降为普通用户。
        const demote = await fetch(`${HTTP}/admin/users/orgs`, {
          method: "POST", headers: aAuth, body: JSON.stringify({ username: "simv5", orgs: ["simorg2"] }),
        });
        check("setOrgs 移出 admins 204", demote.status === 204, demote.status);
        const users2 = await (await fetch(`${HTTP}/admin/users`, { headers: aAuth })).json();
        const row2 = users2.find((u: any) => u.username === "simv5");
        check("simv5 已降为普通", row2 && row2.isAdmin === false && !row2.orgs.includes("admins"), row2);
        // 自己移出 admins → 400(防自锁)。
        const self = await fetch(`${HTTP}/admin/users/orgs`, {
          method: "POST", headers: aAuth, body: JSON.stringify({ username: "simadmin", orgs: [] }),
        });
        check("自降管理员被拒 400", self.status === 400, self.status);
        // 邀请码挂 admins → 400。
        const invAdm = await fetch(`${HTTP}/admin/invites`, {
          method: "POST", headers: aAuth, body: JSON.stringify({ org: "admins" }),
        });
        check("邀请码挂 admins 被拒 400", invAdm.status === 400, invAdm.status);
        // 清理。
        await fetch(`${HTTP}/admin/users/delete`, { method: "POST", headers: aAuth, body: JSON.stringify({ username: "simv5" }) });
      }
    }
  }

  desktop.close(); phone.close();
  await new Promise((r) => setTimeout(r, 300));
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("脚本异常:", e); process.exit(1); });
