// 应用内更新的原生安装实现(dart.library.io 平台:Android 为主)。
//
// 经 app_update.dart 的条件导入挂载;web 平台走 app_update_install_stub.dart。
// 流式下载 APK 到临时目录 → OpenFilex.open 唤起系统安装器
// (Android 8+ 首次会先引导「安装未知应用」授权,属 sideload 标准流程)。
library;

import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

/// 下载 [url](APK 直链)到缓存目录并拉起安装器。
///
/// [onProgress] 每收到一段数据回调一次(累计字节数,总长未知时 total 为 null)。
/// 返回 true = 安装器已拉起;false/异常由调用方回退浏览器下载页。
Future<bool> downloadAndInstallApk(
  http.Client client,
  String url,
  void Function(int received, int? total) onProgress,
) async {
  final resp = await client.send(http.Request('GET', Uri.parse(url)));
  if (resp.statusCode != 200) {
    throw '下载失败:HTTP ${resp.statusCode}';
  }
  final dir = await getTemporaryDirectory();
  final file = File(
    '${dir.path}${Platform.pathSeparator}txuy_companion_update.apk',
  );
  final sink = file.openWrite();
  try {
    var received = 0;
    await for (final chunk in resp.stream) {
      sink.add(chunk);
      received += chunk.length;
      onProgress(received, resp.contentLength);
    }
  } finally {
    await sink.close();
  }
  final result = await OpenFilex.open(file.path);
  return result.type == ResultType.done;
}
