import 'package:shared_preferences/shared_preferences.dart';

/// 桌面端(电脑)自定义标签:deviceId → 名称。只存**手机本地**(SharedPreferences),
/// 不上中继、不进保险箱——标签纯粹是给自己分辨多台电脑用的,换手机不跟随。
class DeviceLabelStore {
  static const _prefix = "txuy.deviceLabel.";

  /// 全部标签(空值/损坏键静默跳过)。
  static Future<Map<String, String>> loadAll() async {
    final sp = await SharedPreferences.getInstance();
    final out = <String, String>{};
    for (final k in sp.getKeys()) {
      if (!k.startsWith(_prefix)) continue;
      final v = sp.getString(k);
      if (v != null && v.trim().isNotEmpty) out[k.substring(_prefix.length)] = v.trim();
    }
    return out;
  }

  /// 写标签;传空串 = 删除。
  static Future<void> setLabel(String deviceId, String label) async {
    final sp = await SharedPreferences.getInstance();
    if (label.trim().isEmpty) {
      await sp.remove(_prefix + deviceId);
    } else {
      await sp.setString(_prefix + deviceId, label.trim());
    }
  }
}
