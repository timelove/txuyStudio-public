// txuyStudio 中继(哑管道):按 (user, device) 路由密文帧 + 密文快照暂存。
// 业务逻辑一概不在本服务;enc 字段永不解密。协议见 .work/design/20261023-mobile-relay/protocol-v1.md。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

type config struct {
	Listen string `json:"listen"`
	DB     string `json:"db"`
	// 注册准入三态:"off"(默认,私有部署紧闭)| "invite"(注册须携带有效邀请码,推荐)|
	// "open"(无门槛全开放,自担风险)。自助注册恒非管理员(首个 admin 走 CLI 自举)。
	RegisterMode string `json:"registerMode"`
}

// 首次启动生成样例后退出;用户体系走 CLI(-adduser)/注册接口,config 只管监听/库/准入。
func loadConfig(path string) (*config, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		sample := config{Listen: ":8787", DB: "relay.db"}
		b, _ := json.MarshalIndent(sample, "", "  ")
		if err := os.WriteFile(path, b, 0o600); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("config 不存在,已生成样例 %s,改好后重启", path)
	}
	if err != nil {
		return nil, err
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", path, err)
	}
	if cfg.Listen == "" {
		cfg.Listen = ":8787"
	}
	if cfg.DB == "" {
		cfg.DB = "relay.db"
	}
	switch cfg.RegisterMode {
	case "invite", "open":
		// 合法模式原样保留
	default:
		cfg.RegisterMode = "off" // 空值/未知值一律按紧闭处理
	}
	return &cfg, nil
}

func main() {
	cfgPath := flag.String("config", "relay-config.json", "配置文件路径")
	adduser := flag.String("adduser", "", "创建用户(账密登录)")
	admin := flag.Bool("admin", false, "配合 -adduser:加入管理员组织 admins(进组即管理员角色)")
	password := flag.String("password", "", "密码(配合 -adduser/-passwd;缺省交互输入,不回显)")
	passwdUser := flag.String("passwd", "", "修改用户密码")
	deluser := flag.String("deluser", "", "删除用户(级联吊销其全部会话)")
	listusers := flag.Bool("listusers", false, "列出全部用户")
	killsessions := flag.String("killsessions", "", "吊销该用户全部会话")
	invite := flag.String("invite", "", "生成邀请码(参数为备注;\"-\" 表示无备注;配合 -uses/-hours/-org)")
	inviteUses := flag.Int("uses", 1, "邀请码可用次数(配合 -invite)")
	inviteHours := flag.Int("hours", 168, "邀请码有效小时数(配合 -invite;0=永不过期)")
	userOrg := flag.String("org", "", "组织名,逗号分隔多组(配合 -adduser/-invite:用户归属/码挂组织)")
	addorg := flag.String("addorg", "", "创建组织(参数为组织名,1-32 位字母数字_.-)")
	orgNote := flag.String("orgnote", "", "组织备注(配合 -addorg)")
	delorg := flag.String("delorg", "", "删除组织(仅空组织可删)")
	listorgs := flag.Bool("listorgs", false, "列出全部组织(带成员数)")
	flag.Parse()

	cfg, err := loadConfig(*cfgPath)
	if err != nil {
		log.Fatalf("relay: %v", err)
	}
	st, err := openStore(cfg.DB)
	if err != nil {
		log.Fatalf("relay: 打开数据库: %v", err)
	}
	defer st.close()

	// CLI 管理分支(处理完即退出,不起服务):账密用户/会话/邀请码/组织管理。
	if *adduser != "" || *passwdUser != "" || *deluser != "" || *killsessions != "" || *listusers || *invite != "" ||
		*addorg != "" || *delorg != "" || *listorgs {
		if *adduser != "" {
			pw, err := readPassword(*password)
			if err != nil {
				log.Fatalf("relay: %v", err)
			}
			// -org 逗号分隔多组;-admin 追加管理员组织(勾上即管理员角色)。
			orgNames := []string{}
			for _, n := range strings.Split(*userOrg, ",") {
				if n = strings.TrimSpace(n); n != "" {
					orgNames = append(orgNames, n)
				}
			}
			if *admin {
				orgNames = append(orgNames, adminOrgName)
			}
			orgIDs := make([]string, 0, len(orgNames))
			for _, n := range orgNames {
				oid, err := st.orgIDByName(n)
				if err != nil {
					log.Fatalf("relay: adduser: 组织 %q 不存在(先 -addorg)", n)
				}
				orgIDs = append(orgIDs, oid)
			}
			id, err := st.createUser(*adduser, pw, orgIDs)
			if err != nil {
				log.Fatalf("relay: adduser: %v", err)
			}
			log.Printf("relay: 用户 %s 已创建(id=%s, orgs=%v)", *adduser, id, orgNames)
		}
		if *passwdUser != "" {
			pw, err := readPassword(*password)
			if err != nil {
				log.Fatalf("relay: %v", err)
			}
			if err := st.setUserPassword(*passwdUser, pw); err != nil {
				log.Fatalf("relay: passwd: %v", err)
			}
			log.Printf("relay: 用户 %s 密码已修改(旧会话保持有效,需要时用 -killsessions 吊销)", *passwdUser)
		}
		if *deluser != "" {
			if err := st.deleteUser(*deluser); err != nil {
				log.Fatalf("relay: deluser: %v", err)
			}
			log.Printf("relay: 用户 %s 已删除(会话一并吊销)", *deluser)
		}
		if *invite != "" {
			note := *invite
			if note == "-" {
				note = ""
			}
			orgID := ""
			if *userOrg != "" {
				if *userOrg == adminOrgName {
					log.Fatalf("relay: invite: 管理员组织不能经邀请码发放(用 -adduser -admin 直接建)")
				}
				var err error
				orgID, err = st.orgIDByName(*userOrg)
				if err != nil {
					log.Fatalf("relay: invite: 组织 %q 不存在(先 -addorg)", *userOrg)
				}
			}
			inv, err := st.createInvite("cli", note, orgID, *inviteUses, *inviteHours)
			if err != nil {
				log.Fatalf("relay: invite: %v", err)
			}
			exp := "永不过期"
			if inv.ExpiresAt > 0 {
				exp = time.Unix(inv.ExpiresAt, 0).Format("2006-01-02 15:04")
			}
			orgTag := ""
			if orgID != "" {
				orgTag = ", org=" + *userOrg
			}
			log.Printf("relay: 邀请码 %s(%d 次,至 %s%s)%s", inv.Code, inv.MaxUses, exp, orgTag, invNoteSuffix(note))
		}
		if *addorg != "" {
			org, err := st.createOrg(*addorg, *orgNote)
			if err != nil {
				log.Fatalf("relay: addorg: %v(重名或存储错误)", err)
			}
			log.Printf("relay: 组织 %s 已创建(id=%s)", org.Name, org.ID)
		}
		if *delorg != "" {
			if err := st.deleteOrg(*delorg); err != nil {
				log.Fatalf("relay: delorg: %v(不存在或仍有成员,先转移)", err)
			}
			log.Printf("relay: 组织 %s 已删除", *delorg)
		}
		if *listorgs {
			orgs, err := st.listOrgs()
			if err != nil {
				log.Fatalf("relay: listorgs: %v", err)
			}
			if len(orgs) == 0 {
				fmt.Println("(无组织)")
			}
			for _, o := range orgs {
				fmt.Printf("%s\t%s\t%d 人%s\n", o.ID, o.Name, o.Members, invNoteSuffix(o.Note))
			}
		}
		if *killsessions != "" {
			n, err := st.killUserSessions(*killsessions)
			if err != nil {
				log.Fatalf("relay: killsessions: %v", err)
			}
			log.Printf("relay: 已吊销 %s 的 %d 个会话", *killsessions, n)
		}
		if *listusers {
			users, err := st.listUsers()
			if err != nil {
				log.Fatalf("relay: listusers: %v", err)
			}
			if len(users) == 0 {
				fmt.Println("(无账密用户;静态 token 用户见 config)")
				return
			}
			for _, u := range users {
				tag := ""
				if u.IsAdmin {
					tag = " [admin]"
				}
				org := ""
				if len(u.Orgs) > 0 {
					org = "\t" + strings.Join(u.Orgs, ",")
				}
				fmt.Printf("%s\t%s\t%s%s%s\n", u.ID, u.Username, time.Unix(u.CreatedAt, 0).Format("2006-01-02"), tag, org)
			}
		}
		return
	}

	// 快照 TTL:启动清一次,之后每 6h 清一次(7 天未推新即过期)。
	purge := func() {
		if n, err := st.purgeStaleSnapshots(7 * 24 * time.Hour); err != nil {
			log.Printf("relay: 快照清理失败: %v", err)
		} else if n > 0 {
			log.Printf("relay: 清理过期快照 %d 份", n)
		}
	}
	purge()
	go func() {
		for range time.Tick(6 * time.Hour) {
			purge()
		}
	}()

	hub := newHub(st, cfg)
	http.HandleFunc("/ws", hub.serveWS)
	// HTTP API 全部过 withCORS:手机网页端跨源调用,预检必须放行(见 auth.go 注释)。
	http.HandleFunc("/login", withCORS(hub.serveLogin))
	http.HandleFunc("/logout", withCORS(hub.serveLogout))
	http.HandleFunc("/register", withCORS(hub.serveRegister))
	http.HandleFunc("/account/password", withCORS(hub.serveAccountPassword))
	// /vault(列表)与 /vault/{deviceId}(发布)都要注册:只注册尾斜杠模式时,
	// 默认 mux 会把 GET /vault 307 重定向到 /vault/,预检/鉴权逻辑全被绕过。
	http.HandleFunc("/vault", withCORS(hub.serveVault))
	http.HandleFunc("/vault/", withCORS(hub.serveVault))
	http.HandleFunc("/devices", withCORS(hub.serveDevices))
	http.HandleFunc("/admin/users", withCORS(hub.serveAdminUsers))
	http.HandleFunc("/admin/users/password", withCORS(hub.serveAdminPassword))
	http.HandleFunc("/admin/users/orgs", withCORS(hub.serveAdminUsersOrgs))
	http.HandleFunc("/admin/users/delete", withCORS(hub.serveAdminDelete))
	http.HandleFunc("/admin/sessions/kill", withCORS(hub.serveAdminKillSessions))
	http.HandleFunc("/admin/invites", withCORS(hub.serveAdminInvites))
	http.HandleFunc("/admin/invites/delete", withCORS(hub.serveAdminInviteDelete))
	http.HandleFunc("/admin/orgs", withCORS(hub.serveAdminOrgs))
	http.HandleFunc("/admin/orgs/delete", withCORS(hub.serveAdminOrgDelete))
	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})

	log.Printf("relay: 监听 %s(设备 %d,快照暂存中;账密用户见 -listusers,准入模式 %s)",
		cfg.Listen, hub.online(), cfg.RegisterMode)
	if err := http.ListenAndServe(cfg.Listen, nil); err != nil {
		log.Fatalf("relay: %v", err)
	}
}

func invNoteSuffix(note string) string {
	if note == "" {
		return ""
	}
	return " 备注:" + note
}

// readPassword:命令行给参用参,否则交互输入(不回显,确认两次)。
func readPassword(flagVal string) (string, error) {
	if flagVal != "" {
		return flagVal, nil
	}
	fmt.Print("password: ")
	b1, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", err
	}
	if len(b1) < 8 {
		return "", fmt.Errorf("密码至少 8 位")
	}
	fmt.Print("confirm : ")
	b2, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return "", err
	}
	if string(b1) != string(b2) {
		return "", fmt.Errorf("两次输入不一致")
	}
	return string(b1), nil
}
