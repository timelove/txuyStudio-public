# txuyStudio relay(中继)

公网哑管道:按 (user, device) 路由桌面端↔手机的密文帧,暂存密文快照。
**不跑任何业务逻辑,enc 字段永不解密。** 鉴权边界 = hello 帧 token(常时比较)
+ 载荷端到端加密(密钥仅在桌面端与手机,中继永不经手明文)。

## 运行

```bash
cd relay
go build -o relay.exe .          # 或 GOOS=linux GOARCH=amd64 go build 交叉编译
./relay.exe -config relay-config.json
```

- 首次启动自动生成样例 `relay-config.json`(随机 token)并退出;改好后重启。
- `relay-config.json` 含 token,**不入库**(gitignore);泄露处置 = 换 token 重启,旧连接全失效。
- 监听 `:8787`,`GET /healthz` 健康检查,`GET /ws` WebSocket。
- 生产部署务必置于 TLS 之后(Caddy/nginx 反代 wss),或在 relay 前挂 Cloudflare。

## 部署(systemd)

```ini
# /etc/systemd/system/txuy-relay.service
[Service]
WorkingDirectory=/opt/txuy-relay
ExecStart=/opt/txuy-relay/relay -config relay-config.json
Restart=always
```

## 本地联调

```bash
./relay.exe -config relay-config.json &   # 起 relay
bun sim/sim.ts                            # 模拟桌面端+手机端双客户端,15 场景全跑
```

## 依赖选型

- `github.com/coder/websocket` — gorilla 已归档过一轮,不用。
- `modernc.org/sqlite` — 纯 Go 免 CGO,保住单二进制交叉编译(设备元数据 + 快照暂存)。
- 路由就 2 个端点,不引 web 框架。

## 注意事项(实现期踩坑实录)

- coder/websocket 默认单消息上限 **32KB**(`SetReadLimit`),快照大帧会被静默拒读 → Accept 后显式放宽到 4MB。
- 分层限流:传输层 4MB(挡恶意帧,断连);快照密文 2.8MB ≈ 2MB 明文(业务拒绝,连接保持)。
- 踢旧连接的 `bye` 必须经 writePump 退出前排空,否则对端感知不到被顶替。
- **`websocket.Accept` 的默认同源校验会把浏览器打回 403**(2026-10-26 实测):浏览器发起 WS 一定带
  `Origin`(网页端 `http://localhost:8899` ≠ 中继 `127.0.0.1:8787`),而桌面端 / bun 脚本用的原生
  WS 客户端**不带 Origin**,所以只有网页端挂——症状是伴侣网页永远「离线」、每 5s 重连一次,而
  桌面端一切正常,极容易被误判成客户端 bug。修法是
  `AcceptOptions{OriginPatterns: []string{"*"}}`;中继的鉴权边界是 hello 帧的 token(常时比较)
  + 载荷 E2E 加密,Origin 不承担鉴权职责,放开是安全的。
  自检命令:`curl -H "Origin: http://localhost:8899" ... http://127.0.0.1:8787/ws` 应返回 101 而非 403。
