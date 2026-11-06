package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// 传输层单帧上限:挡恶意巨帧(直接断连);快照大小的业务拒绝另走 snapshotEncLimit。
const frameLimit = 4_000_000

// 快照密文上限:2MB 明文 ≈ 2.67MB base64,取 2.8MB 兜(超限业务层拒绝,连接保持)。
const snapshotEncLimit = 2_800_000

// 读静默超时:任意帧都算活,90s 无帧即断(应用层 ping/pong 保活)。
const idleTimeout = 90 * time.Second

// hello 必须在连接后 10s 内完成。
const helloTimeout = 10 * time.Second

// 所有帧的统一信封(中继视角只读路由字段,enc 永不解释)。
type envelope struct {
	Type     string `json:"type"`
	To       string `json:"to,omitempty"`
	From     string `json:"from,omitempty"`
	Enc      string `json:"enc,omitempty"`
	Ts       int64  `json:"ts,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	UserID   string `json:"userId,omitempty"`
	Role     string `json:"role,omitempty"`
	Token    string `json:"token,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Error    string `json:"error,omitempty"`
	ServerTs int64  `json:"serverTs,omitempty"`
	OK       *bool  `json:"ok,omitempty"`
}

type client struct {
	conn     *websocket.Conn
	userID   string
	deviceID string
	send     chan []byte
	done     chan struct{} // writePump 退出信号
	once     sync.Once
}

type hub struct {
	mu      sync.RWMutex
	devices map[string]*client // key: deviceID(全局唯一,deviceId 冲突由踢旧保证)
	store   *store
	cfg     *config
	limiter loginLimiter // /login 爆破限速(内存桶)
}

func newHub(st *store, cfg *config) *hub {
	return &hub{devices: make(map[string]*client), store: st, cfg: cfg}
}

func (h *hub) online() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.devices)
}

// isOnline:设备当前是否连着(GET /devices 实时状态)。
func (h *hub) isOnline(deviceID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, ok := h.devices[deviceID]
	return ok
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	// OriginPatterns 必须放开:浏览器发起的 WS 一定带 Origin(网页端在 :8899,
	// 中继在 :8787 → 跨源),coder/websocket 默认只允许同源,会把网页端握手
	// 直接 403 打回(症状:伴侣网页端永远「离线」,而桌面端/bun 脚本正常——
	// 因为原生 WS 客户端不带 Origin 头)。
	//
	// 安全性说明:中继的鉴权边界是 hello 帧里的 token(常时比较)+ 载荷 E2E 加密,
	// Origin 不承担鉴权职责——没有 token 的页面即使连上也发不出任何业务帧。
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	// coder/websocket 默认单消息上限 32KB,会拒读快照大帧;放宽到传输层上限。
	conn.SetReadLimit(frameLimit)
	h.runSession(r, conn)
}

func (h *hub) runSession(r *http.Request, conn *websocket.Conn) {
	ctx, cancel := context.WithTimeout(r.Context(), helloTimeout)
	_, data, err := conn.Read(ctx)
	cancel()
	if err != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "hello timeout")
		return
	}
	var hello envelope
	if err := json.Unmarshal(data, &hello); err != nil || hello.Type != "hello" {
		_ = conn.Close(websocket.StatusPolicyViolation, "expect hello first")
		return
	}
	if !h.checkToken(hello.UserID, hello.Token) {
		ack, _ := json.Marshal(envelope{Type: "hello_ack", OK: boolPtr(false), Error: "bad token"})
		ctx2, cancel2 := context.WithTimeout(context.Background(), 3*time.Second)
		_ = conn.Write(ctx2, websocket.MessageText, ack)
		cancel2()
		_ = conn.Close(websocket.StatusPolicyViolation, "bad token")
		return
	}
	if hello.DeviceID == "" {
		_ = conn.Close(websocket.StatusPolicyViolation, "missing deviceId")
		return
	}
	role := hello.Role
	if role != "desktop" && role != "phone" {
		role = "phone"
	}

	c := &client{
		conn:     conn,
		userID:   hello.UserID,
		deviceID: hello.DeviceID,
		send:     make(chan []byte, 64),
		done:     make(chan struct{}),
	}

	// 注册 + 踢旧(同 deviceId 新连接顶替)。
	h.mu.Lock()
	if old, ok := h.devices[c.deviceID]; ok {
		old.post(envelope{Type: "bye", Reason: "replaced"})
		old.shutdown()
		delete(h.devices, c.deviceID)
	}
	h.devices[c.deviceID] = c
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if cur, ok := h.devices[c.deviceID]; ok && cur == c {
			delete(h.devices, c.deviceID)
		}
		h.mu.Unlock()
	}()

	if err := h.store.upsertDevice(c.deviceID, c.userID, role); err != nil {
		log.Printf("relay: devices upsert: %v", err)
	}
	log.Printf("relay: %s(%s) 上线,在线 %d", c.deviceID, role, h.online())
	ack, _ := json.Marshal(envelope{Type: "hello_ack", OK: boolPtr(true), ServerTs: time.Now().Unix()})
	select {
	case c.send <- ack:
	default:
	}
	go c.writePump()
	c.readPump(h)
}

// checkToken:唯一身份 = sessions 表(账密登录签发,未过期);v4 起静态 config token 已移除。
func (h *hub) checkToken(userID, token string) bool {
	uid, ok := h.store.sessionUser(token)
	return ok && uid == userID
}

// kickUser:踢该用户全部在线连接(删号/吊销会话后立即下线;桌面与手机同账号全断),
// 返回踢掉的连接数。bye(reason=kicked) 先送再断,对端能知道是被主动下线而非网络抖动;
// 重连时 hello 会因 session 已删而被拒(客户端应停止自动重连)。
func (h *hub) kickUser(userID string) int {
	h.mu.Lock()
	kicked := 0
	for id, c := range h.devices {
		if c.userID == userID {
			c.post(envelope{Type: "bye", Reason: "kicked"})
			c.shutdown()
			delete(h.devices, id)
			kicked++
		}
	}
	h.mu.Unlock()
	return kicked
}

func (h *hub) findDevice(deviceID, userID string) *client {
	h.mu.RLock()
	defer h.mu.RUnlock()
	c, ok := h.devices[deviceID]
	if !ok || c.userID != userID { // 跨 user 设备不可见(多租户隔离)
		return nil
	}
	return c
}

func (c *client) post(ev envelope) {
	b, _ := json.Marshal(ev)
	select {
	case c.send <- b:
	default: // 发送缓冲满视为僵死,靠 idleTimeout/重连自愈
	}
}

// postAny:需要显式发零值字段(Ts:0 等,struct omitempty 会吞)时用 map 构帧。
func (c *client) postAny(m map[string]any) {
	b, err := json.Marshal(m)
	if err != nil {
		return
	}
	select {
	case c.send <- b:
	default:
	}
}

func (c *client) shutdown() {
	c.once.Do(func() { close(c.done) })
}

func (c *client) writePump() {
	for {
		select {
		case <-c.done:
			// 退出前排空缓冲:被顶替时的 bye 必须送达,否则对端感知不到。
			for {
				select {
				case b := <-c.send:
					ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
					_ = c.conn.Write(ctx, websocket.MessageText, b)
					cancel()
				default:
					_ = c.conn.CloseNow()
					return
				}
			}
		case b := <-c.send:
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := c.conn.Write(ctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.shutdown()
				return
			}
		}
	}
}

func (c *client) readPump(h *hub) {
	defer func() {
		c.shutdown()
		_ = c.conn.Close(websocket.StatusNormalClosure, "bye")
		log.Printf("relay: %s 下线,在线 %d", c.deviceID, h.online())
	}()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), idleTimeout)
		_, data, err := c.conn.Read(ctx)
		cancel()
		if err != nil {
			return
		}
		if len(data) > frameLimit {
			c.post(envelope{Type: "error", Error: "frame too large"})
			return
		}
		var ev envelope
		if err := json.Unmarshal(data, &ev); err != nil {
			c.post(envelope{Type: "error", Error: "bad json"})
			continue
		}
		h.dispatch(c, ev)
	}
}

func (h *hub) dispatch(c *client, ev envelope) {
	switch ev.Type {
	case "ping":
		c.post(envelope{Type: "pong"})
	case "send":
		target := h.findDevice(ev.To, c.userID)
		if target == nil {
			c.post(envelope{Type: "send_result", To: ev.To, OK: boolPtr(false), Reason: "offline"})
			return
		}
		target.post(envelope{Type: "recv", From: c.deviceID, Enc: ev.Enc})
	case "snapshot_put":
		if ev.Enc == "" || len(ev.Enc) > snapshotEncLimit {
			ok := false
			c.post(envelope{Type: "snapshot_result", OK: &ok, Reason: "size limit (2MB plaintext)"})
			return
		}
		if err := h.store.putSnapshot(c.userID, c.deviceID, ev.Enc, time.Now().Unix()); err != nil {
			ok := false
			c.post(envelope{Type: "snapshot_result", OK: &ok, Reason: "store error"})
			log.Printf("relay: 快照写入失败(%s): %v", c.deviceID, err)
			return
		}
		c.post(envelope{Type: "snapshot_result", OK: boolPtr(true)})
	case "snapshot_get":
		enc, ts, ok := h.store.getSnapshot(c.userID, ev.From)
		if !ok {
			// envelope.Ts 带 omitempty,显式 0 需绕过 struct 直拼(map 无零值省略问题)。
			c.postAny(map[string]any{"type": "snapshot_data", "from": ev.From, "ts": 0})
			return
		}
		c.post(envelope{Type: "snapshot_data", From: ev.From, Enc: enc, Ts: ts})
	default:
		c.post(envelope{Type: "error", Error: "unknown type: " + ev.Type})
	}
}

func boolPtr(b bool) *bool { return &b }
