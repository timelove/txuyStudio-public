// 应用内更新在非 io 平台(web)的占位实现。
//
// web 没有文件系统与 APK 安装器,调用方应直接回退 AppUpdateService.openDownload
// (浏览器打开 Release 下载页),本 stub 恒抛异常兜底。
library;

import 'package:http/http.dart' as http;

Future<bool> downloadAndInstallApk(
  http.Client client,
  String url,
  void Function(int received, int? total) onProgress,
) async {
  throw '当前平台不支持应用内安装';
}
