// 配对凭证 + 手机自身身份,SharedPreferences 持久化。
// v4:唯一获取路径 = 账号登录后从 vault 解出 {pairKey, deviceId};扫码/本地直连已移除。

import 'dart:convert';
import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

class PairCredentials {
  final String url;        // 中继 ws(s)://
  final String userId;
  final String token;      // 账号登录 session token(传输层唯一凭证)
  final String desktopDeviceId; // 目标桌面端设备(请求路由 to)
  final String pairKeyB64; // E2E 密钥 base64
  PairCredentials({
    required this.url, required this.userId, required this.token,
    required this.desktopDeviceId, required this.pairKeyB64,
  });

  factory PairCredentials.fromJson(Map<String, dynamic> j) => PairCredentials(
        url: j["url"] ?? "", userId: j["userId"] ?? "", token: j["token"] ?? "",
        desktopDeviceId: j["deviceId"] ?? "", pairKeyB64: j["pairKey"] ?? "",
      );

  bool get valid => url.isNotEmpty && userId.isNotEmpty && token.isNotEmpty && desktopDeviceId.isNotEmpty && pairKeyB64.isNotEmpty;
}

class CredentialStore {
  static const _kPair = "txuy.pair";
  static const _kSelfDevice = "txuy.selfDevice";

  /// 手机自身 deviceId(首次生成持久化;重装 app = 新设备,重新配对)。
  static Future<String> selfDeviceId() async {
    final sp = await SharedPreferences.getInstance();
    var id = sp.getString(_kSelfDevice);
    if (id == null || id.isEmpty) {
      final r = Random.secure();
      id = "dev-phone-${List.generate(8, (_) => r.nextInt(16).toRadixString(16)).join()}";
      await sp.setString(_kSelfDevice, id);
    }
    return id;
  }

  static Future<PairCredentials?> load() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kPair);
    if (raw == null) return null;
    try {
      final c = PairCredentials.fromJson(jsonDecode(raw) as Map<String, dynamic>);
      return c.valid ? c : null;
    } catch (_) {
      return null;
    }
  }

  static Future<void> save(PairCredentials c) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kPair, jsonEncode({
      "v": 3, "url": c.url, "userId": c.userId, "token": c.token,
      "deviceId": c.desktopDeviceId, "pairKey": c.pairKeyB64,
    }));
  }

  static Future<void> clear() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kPair);
  }
}
