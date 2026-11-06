// 页面数据缓存(stale-while-revalidate):进页先渲染上次成功的数据,后台刷新替换。
// SharedPreferences 持久化(web = localStorage),冷启动/刷新页面不再面对空白页。
// 只缓存「列表/摘要」这类幂等只读数据;写操作与会话凭证一律不进缓存。
// 离线时保留缓存数据不报错(顶部横幅已提示连接状态)。

import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class PageCache {
  static const _prefix = "pagecache.";

  static Future<List<dynamic>?> readList(String key) async {
    try {
      final sp = await SharedPreferences.getInstance();
      final raw = sp.getString("$_prefix$key");
      if (raw == null) return null;
      final v = jsonDecode(raw);
      return v is List ? v : null;
    } catch (_) {
      return null;
    }
  }

  static Future<Map<String, dynamic>?> readObject(String key) async {
    try {
      final sp = await SharedPreferences.getInstance();
      final raw = sp.getString("$_prefix$key");
      if (raw == null) return null;
      final v = jsonDecode(raw);
      return v is Map<String, dynamic> ? v : null;
    } catch (_) {
      return null;
    }
  }

  /// 写失败静默(缓存是锦上添花,不值得为此打断主流程)。
  static Future<void> write(String key, Object value) async {
    try {
      final sp = await SharedPreferences.getInstance();
      await sp.setString("$_prefix$key", jsonEncode(value));
    } catch (_) {}
  }
}
