package main

import (
	"database/sql"
	"time"

	_ "modernc.org/sqlite" // 纯 Go 驱动,免 CGO,保住单二进制交叉编译
)

type store struct{ db *sql.DB }

func openStore(path string) (*store, error) {
	// busy_timeout 防「database is locked」;WAL 提升读写并发。
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	schema := `
CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'phone',
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  user_id   TEXT NOT NULL,
  device_id TEXT NOT NULL,
  enc       TEXT NOT NULL,
  size      INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (user_id, device_id)
);`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	st := &store{db: db}
	// v2 账密登录系统表(存在旧库时补建,零迁移)。
	if err := st.ensureAuthSchema(); err != nil {
		db.Close()
		return nil, err
	}
	return st, nil
}

func (s *store) close() error { return s.db.Close() }

func (s *store) upsertDevice(deviceID, userID, role string) error {
	now := time.Now().Unix()
	_, err := s.db.Exec(`
INSERT INTO devices (device_id, user_id, role, created_at, last_seen) VALUES (?,?,?,?,?)
ON CONFLICT(device_id) DO UPDATE SET user_id=excluded.user_id, role=excluded.role, last_seen=excluded.last_seen`,
		deviceID, userID, role, now, now)
	return err
}

// putSnapshot:每 (user,device) 只留最新一份,INSERT OR REPLACE。
func (s *store) putSnapshot(userID, deviceID, enc string, ts int64) error {
	_, err := s.db.Exec(`
INSERT INTO snapshots (user_id, device_id, enc, size, ts) VALUES (?,?,?,?,?)
ON CONFLICT(user_id, device_id) DO UPDATE SET enc=excluded.enc, size=excluded.size, ts=excluded.ts`,
		userID, deviceID, enc, len(enc), ts)
	return err
}

func (s *store) getSnapshot(userID, deviceID string) (enc string, ts int64, ok bool) {
	err := s.db.QueryRow(`SELECT enc, ts FROM snapshots WHERE user_id=? AND device_id=?`,
		userID, deviceID).Scan(&enc, &ts)
	return enc, ts, err == nil
}

// purgeStaleSnapshots:删除超过 maxAge 未更新的快照,返回删除份数。
func (s *store) purgeStaleSnapshots(maxAge time.Duration) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM snapshots WHERE ts < ?`, time.Now().Add(-maxAge).Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
