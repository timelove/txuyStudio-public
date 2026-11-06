// 中继账密登录系统(protocol v2):用户表 + 会话表 + Argon2id 密码哈希 + /login /logout。
// 设计:.work/design/20261027-local-pairing-relay-auth/。
//
// 安全口径:
//   - 密码哈希 Argon2id(m=64MiB,t=3,p=4,salt16B,key32B),存 PHC 标准串(自描述,将来调参旧哈希仍可验);
//   - 校验常时比较;密码与哈希不进日志、不落盘明文;
//   - session token 随机 32B hex,TTL 30 天,登出即删行;
//   - 登录限速:每 IP 每分钟 10 次失败 → 429 一分钟(内存桶,抗爆破);
//   - WS hello 的 token 校验顺序:config.json 静态 token(兼容 v1)→ sessions 表(未过期)。
//
// enc 业务负载仍 E2E 加密,登录系统只管传输层鉴权,中继不解密业务内容。
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

const (
	argonTime    = 3
	argonMemoryK = 64 * 1024 // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	argonSaltLen = 16

	sessionTTL      = 30 * 24 * time.Hour
	loginFailLimit  = 10 // 每 IP 每分钟失败上限
	loginFailWindow = time.Minute
)

// ---------- Argon2id(PHC 串自描述:$argon2id$v=19$m=65536,t=3,p=4$salt$hash) ----------

func hashPassword(pw string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(pw), salt, argonTime, argonMemoryK, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemoryK, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

// verifyPassword 常时比较(pwHash 为 PHC 串;参数取自串内,与哈希生成解耦)。
func verifyPassword(pwHash, pw string) bool {
	parts := strings.Split(pwHash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false
	}
	var m uint32
	var t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &m, &t, &p); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, t, m, p, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ---------- 存储(users / sessions) ----------

func (s *store) ensureAuthSchema() error {
	// is_admin:手机端管理端权限(v3);老库 CREATE IF NOT EXISTS 不会补列,走 ALTER 迁移。
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS users(
		id TEXT PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		pw_hash TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		is_admin INTEGER NOT NULL DEFAULT 0)`); err != nil {
		return err
	}
	hasAdmin, err := s.columnExists("users", "is_admin")
	if err != nil {
		return err
	}
	if !hasAdmin {
		if _, err := s.db.Exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS sessions(
		token TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		note TEXT)`); err != nil {
		return err
	}
	// 老库 sessions 无 note 列(CREATE IF NOT EXISTS 不补列),PRAGMA 检查迁移。
	hasNote, err := s.columnExists("sessions", "note")
	if err != nil {
		return err
	}
	if !hasNote {
		if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN note TEXT`); err != nil {
			return err
		}
	}
	// v4:登录分客户端(desktop/mobile),sessions 记 client 供设备/审计区分。
	hasClient, err := s.columnExists("sessions", "client")
	if err != nil {
		return err
	}
	if !hasClient {
		if _, err := s.db.Exec(`ALTER TABLE sessions ADD COLUMN client TEXT`); err != nil {
			return err
		}
	}
	// vault:密码保险箱(桌面端用账号密码派生密钥加密的 pairKey 包,中继只见密文)。
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS vault(
		user_id TEXT NOT NULL,
		device_id TEXT NOT NULL,
		blob TEXT NOT NULL,
		ts INTEGER NOT NULL,
		PRIMARY KEY (user_id, device_id))`); err != nil {
		return err
	}
	// invites:注册邀请码(准入门槛;一次性/限次/限期;org=用该码注册自动进组)。
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS invites(
		code TEXT PRIMARY KEY,
		note TEXT,
		created_by TEXT,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL DEFAULT 0,
		max_uses INTEGER NOT NULL DEFAULT 1,
		uses INTEGER NOT NULL DEFAULT 0,
		org TEXT)`); err != nil {
		return err
	}
	// 老库 invites 无 org 列(CREATE IF NOT EXISTS 不补列),PRAGMA 检查迁移。
	hasOrg, err := s.columnExists("invites", "org")
	if err != nil {
		return err
	}
	if !hasOrg {
		if _, err := s.db.Exec(`ALTER TABLE invites ADD COLUMN org TEXT`); err != nil {
			return err
		}
	}
	// orgs:组织(管理分组维度;不影响传输隔离——设备/快照仍按 user 路由)。
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS orgs(
		id TEXT PRIMARY KEY,
		name TEXT UNIQUE NOT NULL,
		note TEXT,
		created_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	// 老库 users 无 org 列,同样迁移(搬迁段引用该列,必须先补上)。
	hasUserOrg, err := s.columnExists("users", "org")
	if err != nil {
		return err
	}
	if !hasUserOrg {
		if _, err := s.db.Exec(`ALTER TABLE users ADD COLUMN org TEXT`); err != nil {
			return err
		}
	}
	// v5:用户↔组织多对多(一个用户可属多个组织);管理员角色 = 管理员组织成员关系,
	// users.is_admin/org 单值列退役(搬入后清零,写路径不再触碰)。
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS user_orgs(
		user_id TEXT NOT NULL,
		org_id TEXT NOT NULL,
		PRIMARY KEY (user_id, org_id))`); err != nil {
		return err
	}
	// 管理员组织:内置自建(永不可删),用户进组即管理员。
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO orgs(id, name, note, created_at) VALUES(?,?,?,?)`,
		adminOrgID, adminOrgName, "内置管理员角色组织:成员即管理员", time.Now().Unix()); err != nil {
		return err
	}
	// 一次性搬迁(幂等:搬完列清零,下次启动 0 行不回搬):
	// users.org → user_orgs;is_admin=1 → admins 成员。
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO user_orgs(user_id, org_id)
		SELECT id, org FROM users WHERE org IS NOT NULL AND org != ''`); err != nil {
		return err
	}
	if _, err := s.db.Exec(`INSERT OR IGNORE INTO user_orgs(user_id, org_id)
		SELECT id, ? FROM users WHERE is_admin != 0`, adminOrgID); err != nil {
		return err
	}
	if _, err := s.db.Exec(`UPDATE users SET org = NULL, is_admin = 0`); err != nil {
		return err
	}
	// v6:session token 哈希化落盘(库文件泄漏无可冒充的凭证)。存量明文 token 一律失效
	// (重新登录即可恢复;桌面/手机各一次)。meta 表标记只跑一次。
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		return err
	}
	var hashed string
	if s.db.QueryRow(`SELECT value FROM meta WHERE key='token_hashed'`).Scan(&hashed) != nil {
		if _, err := s.db.Exec(`DELETE FROM sessions`); err != nil {
			return err
		}
		if _, err := s.db.Exec(`INSERT OR REPLACE INTO meta(key, value) VALUES('token_hashed','1')`); err != nil {
			return err
		}
	}
	return nil
}

// tokenHash:session token 只落 SHA-256(64 hex)。token 是 32B 高熵随机,原文只在
// 客户端与登录响应里流转,服务器不需要回查原文——校验端现算哈希比对即可。
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (s *store) columnExists(table, col string) (bool, error) {
	rows, err := s.db.Query(`SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, err
		}
		if name == col {
			return true, nil
		}
	}
	return false, rows.Err()
}

// createUser:建号 + 加入给定组织(含 admins 即管理员角色);同一事务。
func (s *store) createUser(username, pw string, orgIDs []string) (string, error) {
	hash, err := hashPassword(pw)
	if err != nil {
		return "", err
	}
	id := "u_" + username
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`INSERT INTO users(id, username, pw_hash, created_at) VALUES(?,?,?,?)`,
		id, username, hash, time.Now().Unix()); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return "", errUserTaken
		}
		return "", err
	}
	for _, oid := range orgIDs {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO user_orgs(user_id, org_id) VALUES(?,?)`, id, oid); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return id, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *store) setUserPassword(username, pw string) error {
	hash, err := hashPassword(pw)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(`UPDATE users SET pw_hash=? WHERE username=?`, hash, username)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("user %q not found", username)
	}
	return nil
}

func (s *store) deleteUser(username string) error {
	id, err := s.userIDByName(username)
	if err != nil {
		return err
	}
	// 会话、保险箱、组织成员关系一并级联(号没了身份不残留)。
	for _, q := range []string{
		`DELETE FROM sessions WHERE user_id=?`,
		`DELETE FROM vault WHERE user_id=?`,
		`DELETE FROM user_orgs WHERE user_id=?`,
		`DELETE FROM users WHERE id=?`,
	} {
		if _, err := s.db.Exec(q, id); err != nil {
			return err
		}
	}
	return nil
}

// setUserOrgs:全量替换该用户的组织成员关系(admins 在列即管理员;空列表 = 全移出)。
func (s *store) setUserOrgs(username string, orgIDs []string) error {
	id, err := s.userIDByName(username)
	if err != nil {
		return err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`DELETE FROM user_orgs WHERE user_id=?`, id); err != nil {
		return err
	}
	for _, oid := range orgIDs {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO user_orgs(user_id, org_id) VALUES(?,?)`, id, oid); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type userRow struct {
	ID        string   `json:"userId"`
	Username  string   `json:"username"`
	IsAdmin   bool     `json:"isAdmin"` // 管理员组织成员(派生,与 orgs 含 admins 等价)
	Orgs      []string `json:"orgs"`    // 组织名列表(可含 admins;空 = 无组织)
	CreatedAt int64    `json:"createdAt"`
	Sessions  int64    `json:"sessions"` // 有效会话数(活跃度展示)
}

func (s *store) listUsers() ([]userRow, error) {
	rows, err := s.db.Query(`SELECT u.id, u.username, u.created_at,
		EXISTS(SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.org_id = ?),
		(SELECT COUNT(*) FROM sessions x WHERE x.user_id = u.id AND x.expires_at > ?),
		COALESCE((SELECT group_concat(o.name, ',') FROM user_orgs uo JOIN orgs o ON o.id = uo.org_id WHERE uo.user_id = u.id), '')
		FROM users u ORDER BY u.username`, adminOrgID, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []userRow
	for rows.Next() {
		var u userRow
		var admin int
		var orgsCSV string
		if err := rows.Scan(&u.ID, &u.Username, &u.CreatedAt, &admin, &u.Sessions, &orgsCSV); err != nil {
			return nil, err
		}
		u.IsAdmin = admin != 0
		u.Orgs = []string{}
		if orgsCSV != "" {
			u.Orgs = strings.Split(orgsCSV, ",")
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *store) userIDByName(username string) (string, error) {
	var id string
	err := s.db.QueryRow(`SELECT id FROM users WHERE username=?`, username).Scan(&id)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("user %q not found", username)
	}
	return id, err
}

// usernameByID:uid → 用户名(超管判定用)。
func (s *store) usernameByID(id string) (string, error) {
	var name string
	err := s.db.QueryRow(`SELECT username FROM users WHERE id=?`, id).Scan(&name)
	return name, err
}

// isUserAdmin:管理员角色 = 管理员组织成员(派生;用户 is_admin 列已退役)。
func (s *store) isUserAdmin(id string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM user_orgs WHERE user_id=? AND org_id=?`, id, adminOrgID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// ---------- vault(密码保险箱:中继只存密文) ----------

type vaultRow struct {
	DeviceID string `json:"deviceId"`
	Blob     string `json:"blob"`
	Ts       int64  `json:"ts"`
}

func (s *store) putVault(userID, deviceID, blob string) error {
	_, err := s.db.Exec(`INSERT INTO vault(user_id, device_id, blob, ts) VALUES(?,?,?,?)
ON CONFLICT(user_id, device_id) DO UPDATE SET blob=excluded.blob, ts=excluded.ts`,
		userID, deviceID, blob, time.Now().Unix())
	return err
}

func (s *store) listVaults(userID string) ([]vaultRow, error) {
	rows, err := s.db.Query(`SELECT device_id, blob, ts FROM vault WHERE user_id=? ORDER BY ts DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []vaultRow
	for rows.Next() {
		var v vaultRow
		if err := rows.Scan(&v.DeviceID, &v.Blob, &v.Ts); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// ---------- 设备列表(同账号;手机端挑桌面用) ----------

type deviceRow struct {
	DeviceID string `json:"deviceId"`
	Role     string `json:"role"`
	LastSeen int64  `json:"lastSeen"`
	Online   bool   `json:"online"` // hub 在线状态(实时,非库内历史)
}

func (s *store) listUserDevices(userID string) ([]deviceRow, error) {
	rows, err := s.db.Query(`SELECT device_id, role, last_seen FROM devices WHERE user_id=? ORDER BY last_seen DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []deviceRow
	for rows.Next() {
		var d deviceRow
		if err := rows.Scan(&d.DeviceID, &d.Role, &d.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// login 校验账密,成功签发新 session(单次失败不泄露「用户不存在/密码错」区别)。
func (s *store) login(username, pw, client, note string) (userID, token string, expiresAt int64, isAdmin bool, err error) {
	var id, hash string
	var admin int
	qerr := s.db.QueryRow(`SELECT u.id, u.pw_hash,
		EXISTS(SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.org_id = ?)
		FROM users u WHERE u.username=?`, adminOrgID, username).Scan(&id, &hash, &admin)
	if qerr == sql.ErrNoRows || (qerr == nil && !verifyPassword(hash, pw)) {
		return "", "", 0, false, errBadCredentials
	}
	if qerr != nil {
		return "", "", 0, false, qerr
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", 0, false, err
	}
	token = hex.EncodeToString(raw)
	exp := time.Now().Add(sessionTTL).Unix()
	_, err = s.db.Exec(`INSERT INTO sessions(token, user_id, created_at, expires_at, client, note) VALUES(?,?,?,?,?,?)`,
		tokenHash(token), id, time.Now().Unix(), exp, client, note)
	return id, token, exp, admin != 0, err
}

// sessionUser 校验 session token(未过期)→ 所属 userId。hello 兼容路径。
// 库里存的是哈希:查询侧现算比对。
func (s *store) sessionUser(token string) (string, bool) {
	if token == "" {
		return "", false
	}
	var uid string
	var exp int64
	err := s.db.QueryRow(`SELECT user_id, expires_at FROM sessions WHERE token=?`, tokenHash(token)).Scan(&uid, &exp)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}
	return uid, true
}

func (s *store) killSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token=?`, tokenHash(token))
	return err
}

func (s *store) killUserSessions(username string) (int64, error) {
	id, err := s.userIDByName(username)
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec(`DELETE FROM sessions WHERE user_id=?`, id)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ---------- 登录限速(内存桶) ----------

type failBucket struct {
	count  int
	window time.Time // 窗口起点
	banned time.Time // 429 到期
}

type loginLimiter struct {
	mu sync.Mutex
	m  map[string]*failBucket
}

func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b := l.m[ip]
	if b == nil {
		if l.m == nil {
			l.m = make(map[string]*failBucket)
		}
		b = &failBucket{}
		l.m[ip] = b
	}
	if now.Before(b.banned) {
		return false
	}
	return true
}

func (l *loginLimiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.m[ip]
	now := time.Now()
	if now.Sub(b.window) > loginFailWindow {
		b.window = now
		b.count = 0
	}
	b.count++
	if b.count >= loginFailLimit {
		b.banned = now.Add(loginFailWindow)
		b.count = 0
	}
}

// ---------- HTTP handlers ----------

func (h *hub) serveLogin(w http.ResponseWriter, r *http.Request) {
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	if !h.limiter.allow(ip) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, `{"error":"rate limited"}`, http.StatusTooManyRequests)
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Client   string `json:"client"` // "desktop"|"mobile"(缺省按 desktop;设备/审计区分)
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil ||
		body.Username == "" || body.Password == "" {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if body.Client != "mobile" {
		body.Client = "desktop"
	}
	uid, token, exp, admin, err := h.store.login(body.Username, body.Password, body.Client, "login-api")
	if err != nil {
		if err != errBadCredentials {
			// 存储错误(缺列/磁盘)不伪装成账密错,否则误导排查方向。
			log.Printf("relay: login store error for %q: %v", body.Username, err)
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		h.limiter.fail(ip)
		log.Printf("relay: login failed for %q from %s", body.Username, ip)
		http.Error(w, `{"error":"bad credentials"}`, http.StatusUnauthorized)
		return
	}
	log.Printf("relay: login ok %q from %s", body.Username, ip)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"userId": uid, "token": token, "expiresAt": exp, "isAdmin": admin, "client": body.Client})
}

func (h *hub) serveLogout(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Token == "" {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	_ = h.store.killSession(body.Token)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- 邀请码(注册准入) ----------

// base32 无易混字符(去 0O1ILU):可直接口头/截图转达,10 位 ≈ 3e14 组合不可爆破。
const inviteAlphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
const inviteCodeLen = 10

type inviteRow struct {
	Code      string `json:"code"`
	Note      string `json:"note"`
	Org       string `json:"org"` // 组织名(子查询换出);空 = 注册者无组织
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"` // 0 = 永不过期
	MaxUses   int    `json:"maxUses"`
	Uses      int    `json:"uses"`
	Expired   bool   `json:"expired"`   // 展示派生
	Exhausted bool   `json:"exhausted"` // 展示派生
}

func (r inviteRow) valid(now int64) bool {
	return (r.ExpiresAt == 0 || r.ExpiresAt > now) && r.Uses < r.MaxUses
}

func (s *store) createInvite(createdBy, note, org string, maxUses, expiresInHours int) (inviteRow, error) {
	if maxUses < 1 {
		maxUses = 1
	}
	var exp int64
	if expiresInHours > 0 {
		exp = time.Now().Add(time.Duration(expiresInHours) * time.Hour).Unix()
	}
	var orgVal any
	if org != "" {
		orgVal = org
	}
	raw := make([]byte, inviteCodeLen)
	for attempt := 0; ; attempt++ {
		if _, err := rand.Read(raw); err != nil {
			return inviteRow{}, err
		}
		code := make([]byte, inviteCodeLen)
		for i, b := range raw {
			code[i] = inviteAlphabet[int(b)%len(inviteAlphabet)]
		}
		row := inviteRow{
			Code: string(code), Note: note, Org: org,
			CreatedAt: time.Now().Unix(), ExpiresAt: exp,
			MaxUses: maxUses,
		}
		_, err := s.db.Exec(`INSERT INTO invites(code, note, created_by, created_at, expires_at, max_uses, uses, org) VALUES(?,?,?,?,?,?,0,?)`,
			row.Code, row.Note, createdBy, row.CreatedAt, row.ExpiresAt, row.MaxUses, orgVal)
		if err == nil {
			return row, nil
		}
		if !strings.Contains(err.Error(), "UNIQUE") || attempt >= 5 {
			return inviteRow{}, err // 非冲突错误 / 连撞 5 次(概率天文级)放弃
		}
	}
}

func (s *store) listInvites() ([]inviteRow, error) {
	rows, err := s.db.Query(`SELECT i.code, i.note, IFNULL((SELECT o.name FROM orgs o WHERE o.id = i.org), ''),
		i.created_at, i.expires_at, i.max_uses, i.uses FROM invites i ORDER BY i.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	now := time.Now().Unix()
	var out []inviteRow
	for rows.Next() {
		var r inviteRow
		if err := rows.Scan(&r.Code, &r.Note, &r.Org, &r.CreatedAt, &r.ExpiresAt, &r.MaxUses, &r.Uses); err != nil {
			return nil, err
		}
		r.Expired = r.ExpiresAt != 0 && r.ExpiresAt <= now
		r.Exhausted = r.Uses >= r.MaxUses
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *store) deleteInvite(code string) error {
	_, err := s.db.Exec(`DELETE FROM invites WHERE code=?`, code)
	return err
}

// registerWithInvite:invite 模式注册——建用户(带码上挂的组织)与消耗邀请码同一事务,
// 码无效或用户名冲突任一失败整体回滚(不出现「码被烧了但号没建成」/「号建了码没扣」)。
func (s *store) registerWithInvite(username, pw, inviteCode string) (string, error) {
	hash, err := hashPassword(pw)
	if err != nil {
		return "", err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }() // 已 Commit 后的 Rollback 是 no-op
	// 先读码上的组织(码本身的效用在 UPDATE 里原子校验,这里只取 org)。
	var inviteOrg any // nil 或 org id
	var orgScan any
	if err := tx.QueryRow(`SELECT org FROM invites WHERE code=?`, inviteCode).Scan(&orgScan); err == nil && orgScan != nil {
		inviteOrg = orgScan
	}
	id := "u_" + username
	if _, err := tx.Exec(`INSERT INTO users(id, username, pw_hash, created_at) VALUES(?,?,?,?)`,
		id, username, hash, time.Now().Unix()); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return "", errUserTaken
		}
		return "", err
	}
	// 码挂组织 → 成员关系(多组织体系下单码进一组;管理员组织不敞开邀请码通道,handler 侧已拒)。
	if inviteOrg != nil {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO user_orgs(user_id, org_id) VALUES(?,?)`, id, inviteOrg); err != nil {
			return "", err
		}
	}
	res, err := tx.Exec(`UPDATE invites SET uses=uses+1 WHERE code=? AND (expires_at=0 OR expires_at>?) AND uses<max_uses`,
		inviteCode, time.Now().Unix())
	if err != nil {
		return "", err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", errBadInvite
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return id, nil
}

// 管理员组织(v5 角色真源):内置自建、永不可删;用户进组即管理员。
// users.is_admin 单值列已退彸(启动搬迁进成员关系后清零),一切 admin 判断走派生查询。
const (
	adminOrgName = "admins"
	adminOrgID   = "o_admins"
	// 超级账号(v6,用户 2026-10-30):管理员组织的授予/收回、超管自身的改密/删除、
	// 删除其他管理员,只放行给用户名 "admin" 的账号(CLI -adduser admin -admin 自举)。
	// 其他管理员无权再造管理员,防权限扩散与接管(改超管密码 = 接管,一并拦)。
	superAdminName = "admin"
)

const superOnlyMsg = `{"error":"super admin only (admins org is reserved for user \"admin\")"}`

// isSuperAdmin:操作者是否超级账号(uid → username == "admin")。
func (h *hub) isSuperAdmin(uid string) bool {
	name, err := h.store.usernameByID(uid)
	return err == nil && name == superAdminName
}

// 哨兵错误:handler 按类型映射 HTTP 码,不字符串嗅探。
var (
	errUserTaken      = fmt.Errorf("username taken")
	errBadCredentials = fmt.Errorf("bad credentials")
	errBadInvite      = fmt.Errorf("invalid invite code")
	errOrgTaken       = fmt.Errorf("org exists")
	errOrgNotEmpty    = fmt.Errorf("org not empty")
	errOrgNotFound    = fmt.Errorf("org not found")
	errOrgProtected   = fmt.Errorf("admin org protected")
)

// ---------- 组织(管理分组;传输隔离仍按 user,组织不改变可见性) ----------

// 组织名规则与用户名同款(进 id o_<name> 与日志,防怪字符)。
var orgNameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,32}$`)

type orgRow struct {
	ID        string `json:"orgId"`
	Name      string `json:"name"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"createdAt"`
	Members   int64  `json:"members"`
}

func (s *store) createOrg(name, note string) (orgRow, error) {
	id := "o_" + name
	row := orgRow{ID: id, Name: name, Note: note, CreatedAt: time.Now().Unix()}
	_, err := s.db.Exec(`INSERT INTO orgs(id, name, note, created_at) VALUES(?,?,?,?)`,
		id, name, note, row.CreatedAt)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return orgRow{}, errOrgTaken
	}
	return row, err
}

func (s *store) listOrgs() ([]orgRow, error) {
	rows, err := s.db.Query(`SELECT o.id, o.name, IFNULL(o.note,''), o.created_at,
		(SELECT COUNT(*) FROM user_orgs uo WHERE uo.org_id = o.id)
		FROM orgs o ORDER BY o.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []orgRow
	for rows.Next() {
		var r orgRow
		if err := rows.Scan(&r.ID, &r.Name, &r.Note, &r.CreatedAt, &r.Members); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// deleteOrg 仅空组织可删(有成员 409,提示先转移);内置管理员组织永不可删
// (角色真源,删了没人能再进管理端);挂到该组的邀请码一并清 org 引用。
func (s *store) deleteOrg(name string) error {
	if name == adminOrgName {
		return errOrgProtected
	}
	id, err := s.orgIDByName(name)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(`DELETE FROM orgs WHERE id=? AND NOT EXISTS(SELECT 1 FROM user_orgs WHERE org_id=?)`, id, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errOrgNotEmpty
	}
	// 历史邀请码上的 org 引用一并清(码仍可用,注册者进无组织)。
	_, err = s.db.Exec(`UPDATE invites SET org=NULL WHERE org=?`, id)
	return err
}

func (s *store) orgIDByName(name string) (string, error) {
	var id string
	err := s.db.QueryRow(`SELECT id FROM orgs WHERE name=?`, name).Scan(&id)
	if err == sql.ErrNoRows {
		return "", errOrgNotFound
	}
	return id, err
}

// changePassword 自助改密:校验旧密码后更新(不吊销会话,保持与 CLI/admin 改密同口径)。
func (s *store) changePassword(uid, oldPw, newPw string) error {
	var hash string
	err := s.db.QueryRow(`SELECT pw_hash FROM users WHERE id=?`, uid).Scan(&hash)
	if err == sql.ErrNoRows || (err == nil && !verifyPassword(hash, oldPw)) {
		return fmt.Errorf("bad credentials")
	}
	if err != nil {
		return err
	}
	newHash, err := hashPassword(newPw)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`UPDATE users SET pw_hash=? WHERE id=?`, newHash, uid)
	return err
}

// ---------- 自助注册 / 自助改密(v3 追加) ----------

// 用户名白名单(防注入/防怪字符进 id:u_<name> 与日志;1-32 位字母数字_.-)。
var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,32}$`)

// passwordOK:强密码口径(注册/自助改密/管理员建号与改密共用)——长度 8~128,
// 且必须**同时包含字母与数字**(符号可选)。纯数字/纯字母/短口令一律拒。
func passwordOK(pw string) bool {
	if len(pw) < 8 || len(pw) > 128 {
		return false
	}
	var hasLetter, hasDigit bool
	for _, r := range pw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			hasLetter = true
		case r >= '0' && r <= '9':
			hasDigit = true
		}
	}
	return hasLetter && hasDigit
}

const weakPasswordMsg = `{"error":"weak password (8-128 chars, must contain letters AND digits)"}`

// POST /register {username, password, inviteCode?}:自助注册(恒非管理员,首个 admin 走
// CLI -adduser -admin 自举——自助通道永远造不出管理员)。准入按 config.registerMode 三态:
// off=403;invite=必须携带有效邀请码(建号与烧码同事务);open=无门槛(自担风险)。
func (h *hub) serveRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	switch h.cfg.RegisterMode {
	case "open", "invite":
	default:
		http.Error(w, `{"error":"registration disabled"}`, http.StatusForbidden)
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	if !h.limiter.allow(ip) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, `{"error":"rate limited"}`, http.StatusTooManyRequests)
		return
	}
	var body struct {
		Username   string `json:"username"`
		Password   string `json:"password"`
		InviteCode string `json:"inviteCode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil ||
		!usernameRe.MatchString(body.Username) {
		http.Error(w, `{"error":"bad request (username 1-32 [A-Za-z0-9_.-])"}`, http.StatusBadRequest)
		return
	}
	if !passwordOK(body.Password) {
		http.Error(w, weakPasswordMsg, http.StatusBadRequest)
		return
	}
	if h.cfg.RegisterMode == "invite" && strings.TrimSpace(body.InviteCode) == "" {
		http.Error(w, `{"error":"invite code required"}`, http.StatusBadRequest)
		return
	}
	var id string
	var err error
	if h.cfg.RegisterMode == "invite" {
		id, err = h.store.registerWithInvite(body.Username, body.Password, strings.TrimSpace(body.InviteCode))
	} else {
		id, err = h.store.createUser(body.Username, body.Password, nil) // open 模式注册无组织
	}
	if err != nil {
		switch err {
		case errUserTaken:
			h.limiter.fail(ip)
			http.Error(w, `{"error":"username taken"}`, http.StatusConflict)
		case errBadInvite:
			h.limiter.fail(ip)
			http.Error(w, `{"error":"invalid invite code"}`, http.StatusForbidden)
		default:
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
		}
		return
	}
	log.Printf("relay: self-registered %q from %s (mode=%s)", body.Username, ip, h.cfg.RegisterMode)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"userId": id})
}

// ---------- 管理端邀请码 API(is_admin) ----------

// POST /admin/invites {maxUses?, expiresInHours?, note?} 生成;GET 列表。
func (h *hub) serveAdminInvites(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		rows, err := h.store.listInvites()
		if err != nil {
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		if rows == nil {
			rows = []inviteRow{}
		}
		writeJSONList(w, rows)
	case http.MethodPost:
		var body struct {
			MaxUses        int    `json:"maxUses"`
			ExpiresInHours int    `json:"expiresInHours"`
			Note           string `json:"note"`
			Org            string `json:"org"` // 组织名(可空):用该码注册自动进组
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil ||
			body.MaxUses < 0 || body.MaxUses > 1000 || body.ExpiresInHours < -1 || len(body.Note) > 128 {
			// expiresInHours:0=默认 7 天,-1=永不过期。
			http.Error(w, `{"error":"bad request (maxUses 0-1000 default 1, expiresInHours -1/0+/note <= 128)"}`, http.StatusBadRequest)
			return
		}
		if body.MaxUses == 0 {
			body.MaxUses = 1
		}
		if body.ExpiresInHours == 0 {
			body.ExpiresInHours = 168 // 默认 7 天;显式永不过期传 -1(见下方分支)
		}
		var orgID string
		if body.Org != "" {
			// 管理员组织不经邀请码发放:码会被转发/捡用,拿到码不应等于拿到管理员。
			if body.Org == adminOrgName {
				http.Error(w, `{"error":"admin org not allowed for invites"}`, http.StatusBadRequest)
				return
			}
			var err error
			orgID, err = h.store.orgIDByName(body.Org)
			if err != nil {
				http.Error(w, `{"error":"org not found"}`, http.StatusBadRequest)
				return
			}
		}
		uid, _ := h.bearerUser(r)
		inv, err := h.store.createInvite(uid, body.Note, orgID, body.MaxUses, body.ExpiresInHours)
		if err != nil {
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		log.Printf("relay: admin created invite %s (%d uses)", inv.Code, inv.MaxUses)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(inv)
	default:
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
	}
}

// POST /admin/invites/delete {code}:作废(未用完的剩余次数一并作废)。
func (h *hub) serveAdminInviteDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Code == "" {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if err := h.store.deleteInvite(body.Code); err != nil {
		http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
		return
	}
	log.Printf("relay: admin deleted invite %s", body.Code)
	w.WriteHeader(http.StatusNoContent)
}

// POST /account/password {oldPassword, newPassword}:自助改密(Bearer 鉴权,验旧密码)。
// 改密不自动吊销会话(泄露处置走登出/管理页吊销);客户端改密成功后应用新密码重发布 vault。
func (h *hub) serveAccountPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	uid, ok := h.bearerUser(r)
	if !ok {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	var body struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil ||
		body.OldPassword == "" {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if !passwordOK(body.NewPassword) {
		http.Error(w, weakPasswordMsg, http.StatusBadRequest)
		return
	}
	if err := h.store.changePassword(uid, body.OldPassword, body.NewPassword); err != nil {
		log.Printf("relay: change-password failed (user=%s)", uid)
		http.Error(w, `{"error":"bad credentials"}`, http.StatusUnauthorized)
		return
	}
	log.Printf("relay: password changed (user=%s, sessions kept)", uid)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- 组织管理 API(is_admin) ----------

// GET /admin/orgs 列表(带成员数);POST /admin/orgs {name, note?} 新建。
func (h *hub) serveAdminOrgs(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		rows, err := h.store.listOrgs()
		if err != nil {
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		if rows == nil {
			rows = []orgRow{}
		}
		writeJSONList(w, rows)
	case http.MethodPost:
		var body struct {
			Name string `json:"name"`
			Note string `json:"note"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil ||
			!orgNameRe.MatchString(body.Name) || len(body.Note) > 128 {
			http.Error(w, `{"error":"bad request (name 1-32 [A-Za-z0-9_.-], note <= 128)"}`, http.StatusBadRequest)
			return
		}
		org, err := h.store.createOrg(body.Name, body.Note)
		if err != nil {
			if err == errOrgTaken {
				http.Error(w, `{"error":"org exists"}`, http.StatusConflict)
				return
			}
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		log.Printf("relay: admin created org %q", body.Name)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(org)
	default:
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
	}
}

// POST /admin/orgs/delete {name}:仅空组织可删(有成员 409,先转移);该组邀请码的 org 引用一并清。
func (h *hub) serveAdminOrgDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	if _, ok := h.requireAdmin(w, r); !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Name == "" {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if err := h.store.deleteOrg(body.Name); err != nil {
		switch err {
		case errOrgNotEmpty:
			http.Error(w, `{"error":"org not empty"}`, http.StatusConflict)
		case errOrgProtected:
			http.Error(w, `{"error":"admin org protected"}`, http.StatusForbidden)
		case errOrgNotFound:
			http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		default:
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
		}
		return
	}
	log.Printf("relay: admin deleted org %q", body.Name)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- Bearer 鉴权 + CORS ----------

// bearerUser:Authorization: Bearer <sessionToken> → (userId, ok)。
func (h *hub) bearerUser(r *http.Request) (string, bool) {
	const p = "Bearer "
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, p) {
		return "", false
	}
	return h.store.sessionUser(strings.TrimPrefix(auth, p))
}

// requireAdmin:Bearer + users.is_admin;失败时已写好响应,调用方直接 return。
func (h *hub) requireAdmin(w http.ResponseWriter, r *http.Request) (string, bool) {
	uid, ok := h.bearerUser(r)
	if !ok {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return "", false
	}
	admin, err := h.store.isUserAdmin(uid)
	if err != nil || !admin {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return "", false
	}
	return uid, true
}

// withCORS:手机**网页端**(:8899)调中继 HTTP API(:8787)跨源,必须放开预检;
// 鉴权边界是 Bearer session token + 载荷 E2E 加密,Origin 不承担鉴权职责(与 WS 侧同口径)。
func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

func writeJSONList(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// ---------- vault(密码保险箱) ----------
//
// PUT /vault/{desktopDeviceId} {"blob"}:桌面端登录后发布(pairKey 的密文包);
// GET /vault:手机端登录后拉取列表,同账号密码解密即免扫码配对。中继不解释 blob。

// blob 上限:pairKey 密文包 ~1KB,64KB 富余;顺带挡滥用。
const vaultBlobLimit = 64 << 10

func (h *hub) serveVault(w http.ResponseWriter, r *http.Request) {
	uid, ok := h.bearerUser(r)
	if !ok {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodGet:
		if r.URL.Path != "/vault" && r.URL.Path != "/vault/" {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		rows, err := h.store.listVaults(uid)
		if err != nil {
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		if rows == nil {
			rows = []vaultRow{}
		}
		writeJSONList(w, rows)
	case http.MethodPut:
		deviceID := strings.TrimPrefix(r.URL.Path, "/vault/")
		if deviceID == "" || strings.Contains(deviceID, "/") {
			http.Error(w, `{"error":"bad device id"}`, http.StatusBadRequest)
			return
		}
		var body struct {
			Blob string `json:"blob"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, vaultBlobLimit)).Decode(&body); err != nil || body.Blob == "" {
			http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
			return
		}
		if err := h.store.putVault(uid, deviceID, body.Blob); err != nil {
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		log.Printf("relay: vault updated (%s, user=%s)", deviceID, uid)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
	}
}

// ---------- 设备列表 ----------

// GET /devices:同账号设备(库内历史 + hub 实时在线);手机端挑桌面/确认在备用。
func (h *hub) serveDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	uid, ok := h.bearerUser(r)
	if !ok {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	rows, err := h.store.listUserDevices(uid)
	if err != nil {
		http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
		return
	}
	for i := range rows {
		rows[i].Online = h.isOnline(rows[i].DeviceID)
	}
	if rows == nil {
		rows = []deviceRow{}
	}
	writeJSONList(w, rows)
}

// ---------- 管理端 API(is_admin;手机端管理页的后端) ----------

// GET /admin/users 列表;POST /admin/users 新建 {username, password, orgs:[组织名]}。
// orgs 含 "admins" 即管理员(v5:角色由管理员组织成员关系派生,不再有独立 isAdmin 字段)。
func (h *hub) serveAdminUsers(w http.ResponseWriter, r *http.Request) {
	uid, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		users, err := h.store.listUsers()
		if err != nil {
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		if users == nil {
			users = []userRow{}
		}
		writeJSONList(w, users)
	case http.MethodPost:
		var body struct {
			Username string   `json:"username"`
			Password string   `json:"password"`
			Orgs     []string `json:"orgs"` // 组织名列表(可空 = 无组织;含 "admins" 即管理员)
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil ||
			!usernameRe.MatchString(body.Username) || len(body.Orgs) > 16 {
			http.Error(w, `{"error":"bad request (username 1-32 [A-Za-z0-9_.-], orgs <= 16)"}`, http.StatusBadRequest)
			return
		}
		if !passwordOK(body.Password) {
			http.Error(w, weakPasswordMsg, http.StatusBadRequest)
			return
		}
		// 建号带 admins = 造管理员:只有超级账号 admin 可以(防权限扩散)。
		for _, name := range body.Orgs {
			if strings.TrimSpace(name) == adminOrgName && !h.isSuperAdmin(uid) {
				http.Error(w, superOnlyMsg, http.StatusForbidden)
				return
			}
		}
		orgIDs := make([]string, 0, len(body.Orgs))
		for _, name := range body.Orgs {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			oid, err := h.store.orgIDByName(name)
			if err != nil {
				http.Error(w, `{"error":"org not found"}`, http.StatusBadRequest)
				return
			}
			orgIDs = append(orgIDs, oid)
		}
		id, err := h.store.createUser(body.Username, body.Password, orgIDs)
		if err != nil {
			if err == errUserTaken {
				http.Error(w, `{"error":"exists or store error"}`, http.StatusConflict)
				return
			}
			http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
			return
		}
		log.Printf("relay: admin created user %q (orgs=%v)", body.Username, body.Orgs)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"userId": id})
	default:
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
	}
}

// POST /admin/users/orgs {username, orgs:[组织名]}:全量替换该用户组织成员关系
// (一个用户可同时在多个组织;勾选 admins 即授予/收回管理员角色,下次调用 admin API 时生效)。
// 防呆:不能把操作者自己移出管理员组织(自锁管理端)。
func (h *hub) serveAdminUsersOrgs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	uid, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	var body struct {
		Username string   `json:"username"`
		Orgs     []string `json:"orgs"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil ||
		body.Username == "" || len(body.Orgs) > 16 {
		http.Error(w, `{"error":"bad request (orgs <= 16)"}`, http.StatusBadRequest)
		return
	}
	orgIDs := make([]string, 0, len(body.Orgs))
	hasAdminOrg := false
	for _, name := range body.Orgs {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		oid, err := h.store.orgIDByName(name)
		if err != nil {
			http.Error(w, `{"error":"org not found"}`, http.StatusBadRequest)
			return
		}
		if oid == adminOrgID {
			hasAdminOrg = true
		}
		orgIDs = append(orgIDs, oid)
	}
	target, err := h.store.userIDByName(body.Username)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	if target == uid && !hasAdminOrg {
		http.Error(w, `{"error":"cannot demote yourself"}`, http.StatusBadRequest)
		return
	}
	// 触碰 admins 的进出(授予或收回任何人的管理员身份)只有超级账号 admin 可以。
	wasAdmin, _ := h.store.isUserAdmin(target)
	if (hasAdminOrg || wasAdmin) && !h.isSuperAdmin(uid) {
		http.Error(w, superOnlyMsg, http.StatusForbidden)
		return
	}
	if err := h.store.setUserOrgs(body.Username, orgIDs); err != nil {
		http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
		return
	}
	log.Printf("relay: admin set orgs of %q to %v", body.Username, body.Orgs)
	w.WriteHeader(http.StatusNoContent)
}

// POST /admin/users/password {username, password}:改密(不自动吊销会话,界面提示手动吊销)。
func (h *hub) serveAdminPassword(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	opUid, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body := adminTargetBody(w, r)
	if body == nil {
		return
	}
	// 超管账号的密码只有超管自己能改(别的管理员改掉 admin 密码 = 接管)。
	if body.Username == superAdminName && !h.isSuperAdmin(opUid) {
		http.Error(w, superOnlyMsg, http.StatusForbidden)
		return
	}
	if !passwordOK(body.Password) {
		http.Error(w, weakPasswordMsg, http.StatusBadRequest)
		return
	}
	if err := h.store.setUserPassword(body.Username, body.Password); err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	log.Printf("relay: admin set password for %q (sessions kept)", body.Username)
	w.WriteHeader(http.StatusNoContent)
}

// POST /admin/users/delete {username}:删用户 + 级联吊销会话/保险箱/成员关系
// + 立即踢其全部在线 WS 连接(桌面与手机同断;重连时 hello 因 session 已删被拒)。
// 防呆:不能删自己。
func (h *hub) serveAdminDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	uid, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body := adminTargetBody(w, r)
	if body == nil {
		return
	}
	target, err := h.store.userIDByName(body.Username)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	if target == uid {
		http.Error(w, `{"error":"cannot delete yourself"}`, http.StatusBadRequest)
		return
	}
	// 删超管 / 删别的管理员,只有超级账号 admin 可以(管理员之间互删互改是接管面)。
	if targetIsAdmin, _ := h.store.isUserAdmin(target); targetIsAdmin || body.Username == superAdminName {
		if !h.isSuperAdmin(uid) {
			http.Error(w, superOnlyMsg, http.StatusForbidden)
			return
		}
	}
	if err := h.store.deleteUser(body.Username); err != nil {
		http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
		return
	}
	if n := h.kickUser(target); n > 0 {
		log.Printf("relay: kicked %d live connections of deleted user %q", n, body.Username)
	}
	log.Printf("relay: admin deleted user %q (sessions revoked)", body.Username)
	w.WriteHeader(http.StatusNoContent)
}

// POST /admin/sessions/kill {username}:吊销该用户全部会话(顶号/泄密处置)。
func (h *hub) serveAdminKillSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method"}`, http.StatusMethodNotAllowed)
		return
	}
	uid, ok := h.requireAdmin(w, r)
	if !ok {
		return
	}
	body := adminTargetBody(w, r)
	if body == nil {
		return
	}
	target, err := h.store.userIDByName(body.Username)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}
	// 吊自己 = 立即登出(允许,前端有确认弹窗兜底)。
	n, err := h.store.killUserSessions(body.Username)
	if err != nil {
		http.Error(w, `{"error":"store"}`, http.StatusInternalServerError)
		return
	}
	// 吊销即下线:不等对端重连自然失败(被踢端 hello 重连被拒后应停止自动重连引导重新登录)。
	if k := h.kickUser(target); k > 0 {
		log.Printf("relay: kicked %d live connections of %q", k, body.Username)
	}
	log.Printf("relay: admin(uid=%s) killed %d sessions of %q", uid, n, body.Username)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"killed": n})
}

// adminTargetBody:{username, password?} 公共解析(空 username → 400 已写响应,返回 nil)。
type adminBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func adminTargetBody(w http.ResponseWriter, r *http.Request) *adminBody {
	var body adminBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.Username == "" {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return nil
	}
	return &body
}
