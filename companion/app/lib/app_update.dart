import 'dart:convert';
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'package:http/http.dart' as http;
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import 'app_update_install_stub.dart'
    if (dart.library.io) 'app_update_install_io.dart' as install;
import 'theme.dart';

/// 打包注入的更新源 base URL(2026-11-18 定调:不发版后靠设置切换,APK 自带):
/// `flutter build apk --dart-define=TXUY_UPDATE_SOURCE=https://updates.example.com/txuy`
/// 会编译进 AOT 常量;不传 = GitHub Releases 默认。运行期无任何切换入口。
const String kPackagedUpdateSource = String.fromEnvironment('TXUY_UPDATE_SOURCE');

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

  /// 拉最新版本:打包注入了更新源(--dart-define)走 `{base}/android/latest.json`
  /// (release_publisher 的 AndroidManifest),否则 GitHub Releases API。
  Future<AppRelease?> fetchLatest() async {
    final base = kPackagedUpdateSource.trim();
    if (base.isNotEmpty) return _fetchManifest(base);
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

  Future<AppRelease?> _fetchManifest(String base) async {
    final uri = Uri.parse("${base.replaceFirst(RegExp(r"/+$"), "")}/android/latest.json");
    final resp = await _client.get(uri).timeout(const Duration(seconds: 15));
    if (resp.statusCode != 200) {
      throw "更新源返回 ${resp.statusCode}";
    }
    return compute(_parseManifest, resp.body);
  }

  /// 浏览器下载页(更新回退路径;web 平台的主路径)。
  Future<bool> openDownload(AppRelease release) {
    return launchUrl(
      Uri.parse(release.downloadUrl),
      mode: LaunchMode.externalApplication,
    );
  }

  /// 应用内更新(Android):流式下载 APK 到缓存并唤起系统安装器。
  /// web 不支持——调用方([showAppUpdateDialog])已按平台分流,不会在 web 走到这里。
  Future<bool> downloadAndInstall(
    AppRelease release,
    void Function(int received, int? total) onProgress,
  ) {
    return install.downloadAndInstallApk(_client, release.downloadUrl, onProgress);
  }
}

/// 新版本提示弹窗:Release Notes 按 markdown 渲染;「立即更新」在 Android 上应用内
/// 下载(进度弹窗)→ 系统安装器,web 回退浏览器下载页。
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
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (release.publishedAt != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    '发布时间:${_fmtTime(release.publishedAt!)}',
                    style: const TextStyle(fontSize: 11, color: Mx.muted),
                  ),
                ),
              ...buildReleaseNotes(release.notes),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('稍后再说')),
        FilledButton(
          onPressed: () {
            Navigator.pop(ctx);
            unawaited(_startUpdate(context, release, service));
          },
          child: const Text('立即更新'),
        ),
      ],
    ),
  );
}

/// 更新执行分流:web 走浏览器(无文件系统/安装器);Android 应用内下载 + 安装器。
/// 下载期间展示不可关的进度弹窗,完成即关(安装器接管);失败回退浏览器下载页。
Future<void> _startUpdate(
  BuildContext context,
  AppRelease release,
  AppUpdateService service,
) async {
  if (kIsWeb) {
    await service.openDownload(release);
    return;
  }
  if (!context.mounted) return;
  final navigator = Navigator.of(context, rootNavigator: true);
  final progress = ValueNotifier<(String, double?)>(('准备下载…', null));
  final dlgFuture = showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => ValueListenableBuilder<(String, double?)>(
      valueListenable: progress,
      builder: (ctx, v, _) => PopScope(
        canPop: false,
        child: AlertDialog(
          title: const Text('正在下载更新'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              LinearProgressIndicator(value: v.$2),
              const SizedBox(height: 10),
              Text(v.$1, style: const TextStyle(fontSize: 12, color: Mx.muted)),
            ],
          ),
        ),
      ),
    ),
  );
  bool ok = false;
  Object? error;
  try {
    ok = await service.downloadAndInstall(release, (received, total) {
      String mb(int n) => (n / 1024 / 1024).toStringAsFixed(1);
      progress.value = total != null && total > 0
          ? ('${mb(received)} / ${mb(total)} MB', received / total)
          : ('已下载 ${mb(received)} MB', null);
    });
  } catch (e) {
    error = e;
  } finally {
    progress.dispose();
  }
  navigator.pop();
  await dlgFuture;
  if (!ok || error != null) {
    // 应用内路径失败(网络/安装器)→ 回退浏览器下载页,不让用户卡死。
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('应用内更新失败(${error ?? '安装器未拉起'}),已转浏览器下载')),
      );
    }
    await service.openDownload(release);
  }
}

// ---------------------------------------------------------------------------
// Release Notes 轻量 markdown 渲染
// ---------------------------------------------------------------------------

/// 自家 release notes 用到的 md 子集 → Widget 列表:#+标题、- 列表、> 引用、
/// **粗体**、`行内代码`、空行段距。不引第三方包(flutter_markdown 已 discontinued,
/// notes 格式我们自己控,手写更贴奶油金主题)。
List<Widget> buildReleaseNotes(String md) {
  final trimmed = md.trim();
  if (trimmed.isEmpty) {
    return const [Text('本次发布未提供更新说明。')];
  }
  final blocks = <Widget>[];
  final lines = trimmed.split(RegExp(r'\r?\n'));
  for (final raw in lines) {
    final line = raw.trimRight();
    if (line.trim().isEmpty) {
      blocks.add(const SizedBox(height: 8));
      continue;
    }
    final heading = RegExp(r'^(#{1,3})\s+(.*)$').firstMatch(line);
    if (heading != null) {
      final level = heading[1]!.length;
      blocks.add(Padding(
        padding: EdgeInsets.only(top: blocks.isEmpty ? 0 : 8, bottom: 2),
        child: Text.rich(
          _inlineSpans(heading[2]!),
          style: TextStyle(
            fontSize: level == 1 ? 14 : level == 2 ? 13 : 12,
            fontWeight: FontWeight.w700,
            color: Mx.text,
            height: 1.4,
          ),
        ),
      ));
      continue;
    }
    if (line.startsWith('> ')) {
      blocks.add(Padding(
        padding: const EdgeInsets.only(left: 8, top: 2, bottom: 2),
        child: DecoratedBox(
          decoration: const BoxDecoration(
            border: Border(left: BorderSide(color: Mx.borderStrong, width: 2)),
          ),
          child: Padding(
            padding: const EdgeInsets.only(left: 8),
            child: Text.rich(
              _inlineSpans(line.substring(2)),
              style: const TextStyle(fontSize: 11.5, color: Mx.muted, height: 1.5),
            ),
          ),
        ),
      ));
      continue;
    }
    final item = RegExp(r'^\s*[-*]\s+(.*)$').firstMatch(line);
    if (item != null) {
      blocks.add(Padding(
        padding: const EdgeInsets.only(top: 2),
        child: Text.rich(
          TextSpan(children: [
            const TextSpan(text: '· ', style: TextStyle(fontWeight: FontWeight.w700)),
            ...?_inlineSpans(item[1]!).children,
          ]),
          style: const TextStyle(fontSize: 12, color: Mx.text, height: 1.55),
        ),
      ));
      continue;
    }
    blocks.add(Text.rich(
      _inlineSpans(line),
      style: const TextStyle(fontSize: 12, color: Mx.text, height: 1.55),
    ));
  }
  return blocks;
}

/// 行内标记解析:`**粗体**` 与 `` `代码` ``(未匹配段原样继承外层样式)。
TextSpan _inlineSpans(String text) {
  final children = <TextSpan>[];
  final re = RegExp(r'\*\*(.+?)\*\*|`([^`]+)`');
  var last = 0;
  for (final m in re.allMatches(text)) {
    if (m.start > last) {
      children.add(TextSpan(text: text.substring(last, m.start)));
    }
    if (m[1] != null) {
      children.add(TextSpan(
        text: m[1],
        style: const TextStyle(fontWeight: FontWeight.w700),
      ));
    } else {
      children.add(TextSpan(
        text: m[2],
        style: const TextStyle(
          fontFamily: 'monospace',
          fontSize: 11,
          color: Mx.accentBright,
          backgroundColor: Mx.cardInner,
        ),
      ));
    }
    last = m.end;
  }
  if (last < text.length) {
    children.add(TextSpan(text: text.substring(last)));
  }
  return TextSpan(children: children);
}

String _fmtTime(DateTime t) {
  final local = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
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

/// 解析自有源 manifest(release_publisher 生成的 android/latest.json):
/// {version, name, notes, publishedAt, downloadUrl}。downloadUrl 缺失视为无效。
AppRelease? _parseManifest(String body) {
  final map = jsonDecode(body) as Map<String, dynamic>;
  final version = (map["version"] as String?)?.replaceFirst(RegExp("^[vV]"), "") ?? "";
  final download = map["downloadUrl"] as String? ?? "";
  if (version.isEmpty || download.isEmpty) return null;
  return AppRelease(
    version: version,
    name: map["name"] as String? ?? version,
    notes: map["notes"] as String? ?? "",
    releaseUrl: download, // 自有源没有 Release 页概念,回退下载地址(web 端 openDownload 用)
    downloadUrl: download,
    publishedAt: DateTime.tryParse(map["publishedAt"] as String? ?? ""),
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
