// 用户身份骨架(为后续「登录」预留)。
//
// 现在只有**本地身份**:`userId` 来自配对 payload(与桌面端 relay.json 的 user_id 同源,
// 中继侧按它做设备归属),显示名/头像都是本机可改的展示层,`loginKind` 恒为 "local"。
// 将来接账号体系时只需把 `loginKind` 换成 "account" + 填 `email`,其余 UI 与存储不用动。

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class UserProfile {
  /// 中继用户 id(配对时下发,桌面端与手机共用的账号维度)。
  final String userId;
  /// 本机设备 id(`dev-phone-xxxx`,重装即新设备)。
  final String deviceId;
  /// 展示名(可改;默认取 userId 末 6 位,避免一串裸 id 糊在头像下)。
  final String displayName;
  /// 登录来源:"local" = 仅配对(本地身份),"account" = 已登录(后续)。
  final String loginKind;
  /// 账号邮箱(登录后才有,v1 恒 null)。
  final String? email;
  /// 首次配对时间(本地记录,仅用于「已连接多久」展示)。
  final DateTime? pairedAt;

  UserProfile({
    required this.userId,
    required this.deviceId,
    required this.displayName,
    this.loginKind = "local",
    this.email,
    this.pairedAt,
  });

  bool get loggedIn => loginKind == "account";

  /// 头像文字:显示名首字符(中文取第一个字,英文取首字母大写)。
  String get initial {
    final name = displayName.trim();
    if (name.isEmpty) return "?";
    return name.substring(0, 1).toUpperCase();
  }

  UserProfile copyWith({String? displayName}) => UserProfile(
        userId: userId,
        deviceId: deviceId,
        displayName: displayName ?? this.displayName,
        loginKind: loginKind,
        email: email,
        pairedAt: pairedAt,
      );

  Map<String, dynamic> toJson() => {
        "v": 1,
        "displayName": displayName,
        "loginKind": loginKind,
        "email": email,
        "pairedAt": pairedAt?.toIso8601String(),
      };

  factory UserProfile.fromJson(
    Map<String, dynamic> j, {
    required String userId,
    required String deviceId,
  }) =>
      UserProfile(
        userId: userId,
        deviceId: deviceId,
        displayName: (j["displayName"] as String?)?.trim().isNotEmpty == true
            ? (j["displayName"] as String).trim()
            : defaultName(userId),
        loginKind: j["loginKind"] as String? ?? "local",
        email: j["email"] as String?,
        pairedAt: DateTime.tryParse(j["pairedAt"] as String? ?? ""),
      );

  /// 默认显示名:优先用 userId 末段(便于区分多账号),太短就整串。
  static String defaultName(String userId) {
    final tail = userId.length > 6 ? userId.substring(userId.length - 6) : userId;
    return tail.isEmpty ? "本机用户" : "用户 $tail";
  }
}

/// 用户资料的持久化(SharedPreferences,与 `CredentialStore` 同一口径)。
///
/// 只存**可变的展示层**;userId / deviceId 是身份锚点,始终从配对凭证与设备 id 现取,
/// 不落这份存储——避免「取消配对重配另一个账号后名字还留着」的串台。
class UserStore {
  static const _kUser = "txuy.user";

  static Future<UserProfile> load({
    required String userId,
    required String deviceId,
  }) async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kUser);
    if (raw != null) {
      try {
        return UserProfile.fromJson(jsonDecode(raw) as Map<String, dynamic>,
            userId: userId, deviceId: deviceId);
      } catch (_) {/* 损坏则按默认重建 */}
    }
    final fresh = UserProfile(
      userId: userId,
      deviceId: deviceId,
      displayName: UserProfile.defaultName(userId),
      pairedAt: DateTime.now(),
    );
    await save(fresh);
    return fresh;
  }

  static Future<void> save(UserProfile p) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kUser, jsonEncode(p.toJson()));
  }

  static Future<void> clear() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kUser);
  }
}
