import 'dart:convert';
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

/// GitHub Release 摘要。`downloadUrl` 优先匹配 Android APK;其他平台回退 Release 页。
@immutable
class AppRelease {
  const AppRelease({
    required this.version,
    required this.name,
    required this.notes,
    required this.releaseUrl,
    required this.downloadUrl,
    required this.publishedAt,
  });

  final String version;
  final String name;
  final String notes;
  final String releaseUrl;
  final String downloadUrl;
  final DateTime? publishedAt;
}

class AppUpdateService {
  AppUpdateService({http.Client? client}) : _client = client ?? http.Client();

  // 发版源 = 公开仓(桌面 exe/APK/latest.json 都发这里)。此前指向私有仓 txuyStudio,
  // 其 releases API 未鉴权恒 404,更新检查从未生效。
  static const String owner = "timelove";
  static const String repo = "txuyStudio-public";

  final http.Client _client;

  Future<String> currentVersion() async {
    final info = await PackageInfo.fromPlatform();
    return info.version;
  }

  /// 返回 null 表示当前已是最新版本。
  Future<AppRelease?> check() async {
    final info = await PackageInfo.fromPlatform();
    final release = await fetchLatest();
    if (release == null) return null;
    return compareVersions(release.version, info.version) > 0 ? release : null;
  }

  Future<AppRelease?> fetchLatest() async {
    final uri = Uri.parse("https://api.github.com/repos/$owner/$repo/releases/latest");
    final resp = await _client.get(
      uri,
      headers: {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    ).timeout(const Duration(seconds: 15));
    if (resp.statusCode != 200) {
      throw "GitHub Releases 返回 ${resp.statusCode}";
    }
    return compute(_parseRelease, resp.body);
  }

  Future<bool> openDownload(AppRelease release) {
    return launchUrl(
      Uri.parse(release.downloadUrl),
      mode: LaunchMode.externalApplication,
    );
  }
}

/// 新版本提示弹窗:展示 Release Notes,并把“手动更新”落到外部下载页。
Future<void> showAppUpdateDialog(
  BuildContext context,
  AppRelease release,
  AppUpdateService service,
) async {
  await showDialog<void>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text('发现新版本 v${release.version}'),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480, maxHeight: 420),
        child: SingleChildScrollView(
          child: SelectableText(
            release.notes.trim().isEmpty ? '本次发布未提供更新说明。' : release.notes.trim(),
            style: const TextStyle(fontSize: 12, height: 1.5),
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('稍后再说')),
        FilledButton(
          onPressed: () {
            Navigator.pop(ctx);
            unawaited(service.openDownload(release));
          },
          child: const Text('手动更新'),
        ),
      ],
    ),
  );
}

AppRelease? _parseRelease(String body) {
  final map = jsonDecode(body) as Map<String, dynamic>;
  final tag = map["tag_name"] as String?;
  if (tag == null || tag.isEmpty) return null;
  final assets = (map["assets"] as List<dynamic>? ?? const <dynamic>[])
      .whereType<Map<String, dynamic>>()
      .toList();
  final apk = assets.firstWhere(
    (asset) => (asset["browser_download_url"] as String? ?? "").toLowerCase().endsWith(".apk"),
    orElse: () => const <String, dynamic>{},
  );
  final releaseUrl = map["html_url"] as String? ?? "https://github.com/${AppUpdateService.owner}/${AppUpdateService.repo}/releases/latest";
  return AppRelease(
    version: tag.replaceFirst(RegExp("^[vV]"), ""),
    name: map["name"] as String? ?? tag,
    notes: map["body"] as String? ?? "",
    releaseUrl: releaseUrl,
    downloadUrl: (apk["browser_download_url"] as String?) ?? releaseUrl,
    publishedAt: DateTime.tryParse(map["published_at"] as String? ?? ""),
  );
}

int compareVersions(String left, String right) {
  final a = _versionParts(left);
  final b = _versionParts(right);
  final len = a.length > b.length ? a.length : b.length;
  for (var i = 0; i < len; i++) {
    final x = i < a.length ? a[i] : 0;
    final y = i < b.length ? b[i] : 0;
    if (x != y) return x.compareTo(y);
  }
  return 0;
}

List<int> _versionParts(String version) {
  final core = version.trim().split("+").first.replaceFirst(RegExp("^[vV]"), "");
  return core
      .split(".")
      .map((part) => int.tryParse(part.trim()) ?? 0)
      .toList(growable: false);
}
