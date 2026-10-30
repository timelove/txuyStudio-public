// 账号登录 + 密码保险箱(vault)+ 管理端 API 封装(协议 v3)。
//
// 登录 ≠ 配对:登录只拿传输层会话(Bearer session token);手机怎么拿 E2E pairKey
// = vault 保险箱——桌面端登录后用「账号密码派生密钥」把 pairKey 加密上传中继,
// 手机同账号登录拉密文 → 同一密码解密 → 构造**账号版 PairCredentials**
// (token = session token,中继 hello 已兼容),与扫码路径汇合,client 零改动。
// 中继只见密文(E2E 对中继保持);blob 自描述 kdf 参数,调参后旧包仍可解。

import 'dart:convert';
import 'dart:math';

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import 'credentials.dart';
import 'crypto.dart' as e2e;

/// 内置管理员组织(v5 角色真源):用户进组即管理员角色;永不可删、不经邀请码发放。
const adminOrgName = "admins";

/// 超级账号(与服务端 superAdminName 同口径):管理员组织的授予/收回、超管改密/删除
/// 只放行给它;其他管理员(包括它拉进 admins 的)无权再造管理员。
const superAdminName = "admin";

/// 登录会话(传输层身份;与配对凭证独立,登出不清配对)。
class AccountSession {
  final String url; // 中继 ws(s):// 原始地址(配对凭证复用它)
  final String userId;
  final String token; // Bearer session token
  final String username;
  final bool isAdmin;
  final int expiresAt;

  const AccountSession({
    required this.url,
    required this.userId,
    required this.token,
    required this.username,
    required this.isAdmin,
    required this.expiresAt,
  });

  bool get expired => DateTime.now().millisecondsSinceEpoch ~/ 1000 > expiresAt;

  Map<String, dynamic> toJson() => {
        "url": url, "userId": userId, "token": token,
        "username": username, "isAdmin": isAdmin, "expiresAt": expiresAt,
      };

  factory AccountSession.fromJson(Map<String, dynamic> j) => AccountSession(
        url: j["url"] ?? "", userId: j["userId"] ?? "", token: j["token"] ?? "",
        username: j["username"] ?? "", isAdmin: j["isAdmin"] == true,
        expiresAt: (j["expiresAt"] as num?)?.toInt() ?? 0,
      );
}

class AccountStore {
  static const _k = "txuy.account";
  static const _kRelayUrl = "txuy.relayUrl";

  /// 本次进程内的账号密码(**仅内存,不落盘**):登录时输过一次,「切换电脑」解保险箱
  /// 直接复用,不再重复弹框;app 重启/退出登录即失效。
  static String? sessionPassword;

  /// 上次使用的中继地址(登录页回填用)。与登录会话独立:输入即存,
  /// 登录失败/密码错也不丢——测试期(defaultRelayUrl 为空,地址必填)
  /// 用户不必每次重开 app 都重新敲地址。
  static Future<String> lastRelayUrl() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getString(_kRelayUrl) ?? "";
  }

  static Future<void> saveRelayUrl(String url) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kRelayUrl, url);
  }

  static Future<AccountSession?> load() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_k);
    if (raw == null) return null;
    try {
      return AccountSession.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  static Future<void> save(AccountSession s) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_k, jsonEncode(s.toJson()));
  }

  static Future<void> clear() async {
    sessionPassword = null;
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_k);
  }
}

// ---------- HTTP API ----------

/// 线上默认中继地址(登录页默认用它,不显示地址输入;**上线部署后改成真实地址**,
/// 测试期留空 = 登录页默认展开「测试模式」让用户自填)。
const defaultRelayUrl = "";

/// ws(s)://host[/prefix]/ws → http(s)://host[/prefix](只去尾部 /ws,**路径前缀保留**:
/// 反代前缀场景(nginx 挂 /txuy)登录/注册/vault 等 HTTP API 在同一前缀下;
/// 直接给 http(s):// 也接受;尾部多余斜杠去掉;非法格式返回 null)。
String? relayHttpBase(String url) {
  var u = url.trim();
  var scheme = "http";
  if (u.startsWith("wss://")) {
    scheme = "https";
    u = u.substring(6);
  } else if (u.startsWith("ws://")) {
    u = u.substring(5);
  } else if (u.startsWith("https://")) {
    scheme = "https";
    u = u.substring(8);
  } else if (u.startsWith("http://")) {
    u = u.substring(7);
  } else {
    return null;
  }
  // 去尾部 /ws(填的是 WS 端点时),前缀(如 /txuy)保留。
  if (u.endsWith("/ws")) u = u.substring(0, u.length - 3);
  while (u.endsWith("/")) {
    u = u.substring(0, u.length - 1);
  }
  final host = u.split("/").first;
  if (host.isEmpty) return null;
  return "$scheme://$u";
}

Map<String, String> _bearer(AccountSession s) => {"Authorization": "Bearer ${s.token}"};

/// POST /login → 会话(401 账密错 / 429 限速,message 已是可读中文提示)。
Future<AccountSession> relayLogin(String wsUrl, String username, String password) async {
  final base = relayHttpBase(wsUrl);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/login"),
    headers: {"Content-Type": "application/json"},
    body: jsonEncode({"username": username, "password": password, "client": "mobile"}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode == 401) throw "账号或密码错误";
  if (resp.statusCode == 429) throw "尝试过于频繁,请一分钟后再试";
  if (resp.statusCode != 200) throw "登录失败(HTTP ${resp.statusCode})";
  final j = jsonDecode(resp.body) as Map<String, dynamic>;
  return AccountSession(
    url: wsUrl.trim(),
    userId: j["userId"] ?? "",
    token: j["token"] ?? "",
    username: username,
    isAdmin: j["isAdmin"] == true,
    expiresAt: (j["expiresAt"] as num?)?.toInt() ?? 0,
  );
}

/// 登出(吊销当前 session;配对凭证不动)。
Future<void> relayLogout(AccountSession s) async {
  final base = relayHttpBase(s.url);
  if (base == null) return;
  try {
    await http.post(
      Uri.parse("$base/logout"),
      headers: {"Content-Type": "application/json"},
      body: jsonEncode({"token": s.token}),
    ).timeout(const Duration(seconds: 5));
  } catch (_) {/* 网络失败也算登出(本地会话已清) */}
}

/// vault 条目(blob 已解析为对象;失败条目跳过)。
class VaultEntry {
  final String deviceId;
  final Map<String, dynamic> blob;
  final int ts;
  const VaultEntry({required this.deviceId, required this.blob, required this.ts});
}

/// GET /vault → 该账号名下全部桌面端密文包(按发布时间倒序)。
Future<List<VaultEntry>> fetchVault(AccountSession s) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.get(
    Uri.parse("$base/vault"),
    headers: _bearer(s),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode == 401) throw "会话已过期,请重新登录";
  if (resp.statusCode != 200) throw "读取保险箱失败(HTTP ${resp.statusCode})";
  final list = jsonDecode(resp.body) as List;
  return [
    for (final item in list)
      if (item is Map<String, dynamic>)
        VaultEntry(
          deviceId: item["deviceId"] ?? "",
          blob: _parseBlob(item["blob"]),
          ts: (item["ts"] as num?)?.toInt() ?? 0,
        ),
  ];
}

Map<String, dynamic> _parseBlob(dynamic raw) {
  // 中继存的是 JSON 字符串(桌面端 serde_json::to_string)。
  if (raw is String) {
    try {
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return const {};
    }
  }
  if (raw is Map<String, dynamic>) return raw;
  return const {};
}

/// 解密 vault 条目 → 账号版配对凭证。
/// 失败抛异常:密码与桌面端发布时不一致,或密文损坏(桌面端改密后未重新登录)。
Future<PairCredentials> openVaultEntry(
  VaultEntry entry,
  AccountSession s,
  String password,
) async {
  final kdfName = entry.blob["kdf"];
  if (kdfName != "pbkdf2-sha256") throw "未知的加密方案 $kdfName";
  final iterations = (entry.blob["iter"] as num?)?.toInt() ?? 60000;
  final salt = base64Decode(entry.blob["salt"] as String? ?? "");
  final keyBytes = await deriveVaultKey(password, salt, iterations);
  final payload = await e2e.open(keyBytes, entry.blob["data"] as String? ?? "");
  final j = jsonDecode(utf8.decode(payload)) as Map<String, dynamic>;
  final cred = PairCredentials(
    url: s.url,
    userId: s.userId,
    token: s.token, // 账号版:token = session token(中继 hello 兼容)
    desktopDeviceId: j["deviceId"] ?? entry.deviceId,
    pairKeyB64: j["pairKey"] ?? "",
  );
  if (!cred.valid) throw "密文内容不完整";
  return cred;
}

/// PBKDF2-HMAC-SHA256 派生 vault 密钥(与 Rust 端同参;解密按 blob.iter 自描述)。
Future<List<int>> deriveVaultKey(String password, List<int> salt, int iterations) async {
  final kdf = Pbkdf2(macAlgorithm: Hmac.sha256(), iterations: iterations, bits: 256);
  final key = await kdf.deriveKey(
    secretKey: SecretKey(utf8.encode(password)),
    nonce: salt,
  );
  return (await key.extract()).bytes;
}

/// vault 新发布用的 KDF 轮数(与 Rust VAULT_KDF_ITER 同步;旧 blob 自描述不受影响)。
const vaultKdfIterations = 200000;

/// 用新密码**重发布** vault(手机端持有 pairKey,改密后直接覆盖当前桌面的桶,
/// 保证之后手机端仍能用新密码免扫码配对)。失败不回滚改密(密文已是新密码的)。
Future<void> republishVaultWithNewPassword(
  AccountSession s,
  PairCredentials cred,
  String newPassword,
) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final random = Random.secure();
  final salt = List<int>.generate(32, (_) => random.nextInt(256));
  final keyBytes = await deriveVaultKey(newPassword, salt, vaultKdfIterations);
  final data = await e2e.seal(
    keyBytes,
    utf8.encode(jsonEncode({"pairKey": cred.pairKeyB64, "deviceId": cred.desktopDeviceId})),
  );
  final blob = jsonEncode({
    "kdf": "pbkdf2-sha256", "iter": vaultKdfIterations,
    "salt": base64Encode(salt), "data": data,
  });
  final resp = await http.put(
    Uri.parse("$base/vault/${cred.desktopDeviceId}"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"blob": blob}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 204) throw "保险箱重发布失败(HTTP ${resp.statusCode})";
}

/// POST /account/password:自助改密(Bearer 当前会话,验旧密码)。
/// 改密不吊销会话;调用方成功后应再 [republishVaultWithNewPassword]。
Future<void> relayChangePassword(AccountSession s, String oldPassword, String newPassword) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/account/password"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"oldPassword": oldPassword, "newPassword": newPassword}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode == 401) throw "当前密码错误";
  if (resp.statusCode == 400) throw weakPasswordTip;
  if (resp.statusCode != 204) throw "修改失败(HTTP ${resp.statusCode})";
}

/// GET /devices → 同账号设备(挑桌面时显示在线状态)。
class DeviceInfo {
  final String deviceId;
  final String role;
  final int lastSeen;
  final bool online;
  const DeviceInfo({required this.deviceId, required this.role, required this.lastSeen, required this.online});
}

Future<List<DeviceInfo>> fetchDevices(AccountSession s) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.get(
    Uri.parse("$base/devices"),
    headers: _bearer(s),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 200) return const [];
  final list = jsonDecode(resp.body) as List;
  return [
    for (final item in list)
      if (item is Map<String, dynamic>)
        DeviceInfo(
          deviceId: item["deviceId"] ?? "",
          role: item["role"] ?? "",
          lastSeen: (item["lastSeen"] as num?)?.toInt() ?? 0,
          online: item["online"] == true,
        ),
  ];
}

// ---------- 管理端 API(is_admin;失败抛可读消息) ----------

class AdminUser {
  final String userId;
  final String username;
  final bool isAdmin; // = orgs 含 admins(服务端派生回显,渲染徽标用)
  final List<String> orgs; // 组织名列表(可含 admins;一个用户可在多个组织)
  final int createdAt;
  final int sessions;
  const AdminUser({required this.userId, required this.username, required this.isAdmin, required this.orgs, required this.createdAt, required this.sessions});
  bool get inAdminOrg => isAdmin || orgs.contains(adminOrgName);
}

String _errOf(http.Response r, String fallback) {
  try {
    final j = jsonDecode(r.body) as Map<String, dynamic>;
    if (j["error"] is String) {
      final e = j["error"] as String;
      return {
        "unauthorized": "会话已过期,请重新登录",
        "forbidden": "需要管理员权限",
        "weak password (8-128 chars, must contain letters AND digits)": weakPasswordTip,
        "exists or store error": "用户已存在",
        "not found": "用户不存在",
        "cannot delete yourself": "不能删除当前登录的账号",
        "org exists": "组织已存在",
        "org not empty": "组织内仍有成员,先转移或移出",
        "org not found": "组织不存在",
        "admin org protected": "内置管理员组织不可删除",
        "cannot demote yourself": "不能移除自己的管理员身份",
        "admin org not allowed for invites": "管理员组织不能经邀请码发放",
        'super admin only (admins org is reserved for user "admin")': "仅超级账号 admin 可设置管理员组织/操作该账号",
      }[e] ?? e;
    }
  } catch (_) {/* 非 JSON 响应用 fallback */}
  return fallback;
}

/// 强密码口径(与中继 passwordOK 一致):8~128 位,且**同时包含字母与数字**。
/// 注册/改密/管理员建号改密在提交前先本地拦一道,别等服务器 400。
bool isStrongPassword(String s) {
  if (s.length < 8 || s.length > 128) return false;
  return s.contains(RegExp(r'[A-Za-z]')) && s.contains(RegExp(r'[0-9]'));
}

const weakPasswordTip = "密码太简单:8~128 位,且需同时包含字母和数字";

Future<List<AdminUser>> adminListUsers(AccountSession s) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.get(Uri.parse("$base/admin/users"), headers: _bearer(s))
      .timeout(const Duration(seconds: 10));
  if (resp.statusCode != 200) throw _errOf(resp, "获取用户列表失败");
  final list = jsonDecode(resp.body) as List;
  return [
    for (final item in list)
      if (item is Map<String, dynamic>)
        AdminUser(
          userId: item["userId"] ?? "",
          username: item["username"] ?? "",
          isAdmin: item["isAdmin"] == true,
          orgs: [for (final o in (item["orgs"] as List? ?? const [])) if (o is String) o],
          createdAt: (item["createdAt"] as num?)?.toInt() ?? 0,
          sessions: (item["sessions"] as num?)?.toInt() ?? 0,
        ),
  ];
}

/// [orgs] 组织名列表(可空 = 无组织;含 admins 即管理员角色);任一不存在时中继 400。
Future<void> adminCreateUser(AccountSession s, String username, String password, List<String> orgs) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/users"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"username": username, "password": password, "orgs": orgs}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 201) throw _errOf(resp, "创建用户失败");
}

/// 全量替换该用户的组织成员关系(勾选 admins 即授予/收回管理员角色,下次调用 admin API 生效)。
Future<void> adminSetUserOrgs(AccountSession s, String username, List<String> orgs) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/users/orgs"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"username": username, "orgs": orgs}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 204) throw _errOf(resp, "更新组织失败");
}

Future<void> adminSetPassword(AccountSession s, String username, String password) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/users/password"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"username": username, "password": password, "client": "mobile"}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 204) throw _errOf(resp, "修改密码失败");
}

Future<void> adminDeleteUser(AccountSession s, String username) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/users/delete"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"username": username}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 204) throw _errOf(resp, "删除用户失败");
}

/// 吊销某用户全部会话;返回吊销数。
Future<int> adminKillSessions(AccountSession s, String username) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/sessions/kill"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"username": username}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 200) throw _errOf(resp, "吊销会话失败");
  final j = jsonDecode(resp.body) as Map<String, dynamic>;
  return (j["killed"] as num?)?.toInt() ?? 0;
}

// ---------- 邀请码(注册准入) ----------

class AdminInvite {
  final String code;
  final String note;
  final String org; // 组织名;空 = 注册者不进组
  final int createdAt;
  final int expiresAt; // 0 = 永不过期
  final int maxUses;
  final int uses;
  final bool expired;
  final bool exhausted;
  const AdminInvite({
    required this.code, required this.note, required this.org, required this.createdAt,
    required this.expiresAt, required this.maxUses, required this.uses,
    required this.expired, required this.exhausted,
  });
  bool get available => !expired && !exhausted;
  int get remaining => maxUses - uses;
  String? get expiresLabel {
    if (expiresAt == 0) return "永久";
    final d = DateTime.fromMillisecondsSinceEpoch(expiresAt * 1000);
    String two(int v) => v.toString().padLeft(2, "0");
    return "${d.year}-${two(d.month)}-${two(d.day)}";
  }
}

Future<List<AdminInvite>> adminListInvites(AccountSession s) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.get(Uri.parse("$base/admin/invites"), headers: _bearer(s))
      .timeout(const Duration(seconds: 10));
  if (resp.statusCode != 200) throw _errOf(resp, "获取邀请码列表失败");
  final list = jsonDecode(resp.body) as List;
  return [
    for (final item in list)
      if (item is Map<String, dynamic>)
        AdminInvite(
          code: item["code"] ?? "",
          note: item["note"] ?? "",
          org: item["org"] ?? "",
          createdAt: (item["createdAt"] as num?)?.toInt() ?? 0,
          expiresAt: (item["expiresAt"] as num?)?.toInt() ?? 0,
          maxUses: (item["maxUses"] as num?)?.toInt() ?? 1,
          uses: (item["uses"] as num?)?.toInt() ?? 0,
          expired: item["expired"] == true,
          exhausted: item["exhausted"] == true,
        ),
  ];
}

/// 生成邀请码。[expiresInHours] 0=默认 7 天,-1=永不过期;[maxUses] 0=默认 1。
/// [org] 组织名(可空):用该码注册自动进组。
Future<AdminInvite> adminCreateInvite(
  AccountSession s, {
  int maxUses = 1,
  int expiresInHours = 168,
  String note = "",
  String org = "",
}) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/invites"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"maxUses": maxUses, "expiresInHours": expiresInHours, "note": note, "org": org}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 201) throw _errOf(resp, "生成邀请码失败");
  final j = jsonDecode(resp.body) as Map<String, dynamic>;
  return AdminInvite(
    code: j["code"] ?? "",
    note: j["note"] ?? "",
    org: j["org"] ?? "",
    createdAt: (j["createdAt"] as num?)?.toInt() ?? 0,
    expiresAt: (j["expiresAt"] as num?)?.toInt() ?? 0,
    maxUses: (j["maxUses"] as num?)?.toInt() ?? 1,
    uses: (j["uses"] as num?)?.toInt() ?? 0,
    expired: j["expired"] == true,
    exhausted: j["exhausted"] == true,
  );
}

Future<void> adminDeleteInvite(AccountSession s, String code) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/invites/delete"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"code": code}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 204) throw _errOf(resp, "作废邀请码失败");
}

// ---------- 组织(管理分组维度;不影响传输隔离) ----------

class AdminOrg {
  final String orgId;
  final String name;
  final String note;
  final int createdAt;
  final int members;
  const AdminOrg({required this.orgId, required this.name, required this.note, required this.createdAt, required this.members});
}

AdminOrg _orgOf(Map<String, dynamic> j) => AdminOrg(
      orgId: j["orgId"] ?? "",
      name: j["name"] ?? "",
      note: j["note"] ?? "",
      createdAt: (j["createdAt"] as num?)?.toInt() ?? 0,
      members: (j["members"] as num?)?.toInt() ?? 0,
    );

Future<List<AdminOrg>> adminListOrgs(AccountSession s) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.get(Uri.parse("$base/admin/orgs"), headers: _bearer(s))
      .timeout(const Duration(seconds: 10));
  if (resp.statusCode != 200) throw _errOf(resp, "获取组织列表失败");
  final list = jsonDecode(resp.body) as List;
  return [for (final item in list) if (item is Map<String, dynamic>) _orgOf(item)];
}

Future<AdminOrg> adminCreateOrg(AccountSession s, String name, String note) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/orgs"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"name": name, "note": note}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 201) throw _errOf(resp, "创建组织失败");
  return _orgOf(jsonDecode(resp.body) as Map<String, dynamic>);
}

/// 仅空组织可删(有成员 409,先转移)。
Future<void> adminDeleteOrg(AccountSession s, String name) async {
  final base = relayHttpBase(s.url);
  if (base == null) throw "无效的中继地址";
  final resp = await http.post(
    Uri.parse("$base/admin/orgs/delete"),
    headers: {..._bearer(s), "Content-Type": "application/json"},
    body: jsonEncode({"name": name}),
  ).timeout(const Duration(seconds: 10));
  if (resp.statusCode != 204) throw _errOf(resp, "删除组织失败");
}
