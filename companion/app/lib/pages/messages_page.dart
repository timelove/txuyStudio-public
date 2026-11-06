// 消息 tab(QQ 式会话列表):桌面端全部在线 AI 对话的直达入口。
// 数据源 = 桌面 `chat.digest`(一次请求:项目分组 + 每 tab 最新一条消息摘要 + busy 态),
// 按项目分组渲染;点击直达 ChatPage(项目详情页的对话入口同时保留——那边还有唤起/终端镜像)。
// 15s 轮询让最新消息与 running 态自然跟进(与 QQ「对方正在输入」同感);
// 2026-10-30 起叠加事件驱动:桌面对话事件推送即触发 2s 防抖刷新,停留本页也近实时同步。

import 'dart:async';

import 'package:flutter/material.dart';

import '../page_cache.dart';
import '../relay/client.dart';
import '../theme.dart';
import 'chat_page.dart';

class _DigestItem {
  final String projectId;
  final String projectName;
  final String tabId;
  final String tabTitle;
  final String kind; // claude | codex
  final bool busy;
  final bool started; // 进程在线(claude 长进程启动后恒 true;旧桌面无此字段为 false)
  final String lastText;
  final String lastTs; // ISO8601,可能为空
  const _DigestItem({
    required this.projectId, required this.projectName, required this.tabId,
    required this.tabTitle, required this.kind, required this.busy, required this.started,
    required this.lastText, required this.lastTs,
  });
}

class MessagesPage extends StatefulWidget {
  final RelayClient client;
  const MessagesPage({super.key, required this.client});

  @override
  State<MessagesPage> createState() => _MessagesPageState();
}

class _MessagesPageState extends State<MessagesPage> {
  List<_DigestItem> _items = const [];
  bool _loading = true;
  String? _error;
  Timer? _timer;
  Timer? _evtDebounce;
  StreamSubscription<Map<String, dynamic>>? _evtSub;
  final _scroll = ScrollController();
  DateTime? _lastFetch; // 上滑到底触发的静默刷新节流(3s)

  @override
  void initState() {
    super.initState();
    _loadCached();
    _reload();
    // 事件驱动近实时刷新:桌面任何 tab 来消息(中继连接级整体推送,无需逐 tab 订阅)
    // 即触发;2s 防抖聚合,一轮回复只拉 1~2 次 digest。15s 轮询保留兜底(丢事件时仍能跟上)。
    _evtSub = widget.client.events.listen((frame) {
      if (frame["ev"] != "chat.event") return;
      _evtDebounce?.cancel();
      _evtDebounce = Timer(const Duration(seconds: 2), () {
        if (mounted) _reload(quiet: true);
      });
    });
    _timer = Timer.periodic(const Duration(seconds: 15), (_) => _reload(quiet: true));
    // 上滑到底:拉一次最新(节流 3s,防连滚狂触发)。
    _scroll.addListener(() {
      if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 60) {
        final now = DateTime.now();
        if (_lastFetch == null || now.difference(_lastFetch!) > const Duration(seconds: 3)) {
          _lastFetch = now;
          _reload(quiet: true);
        }
      }
    });
  }

  @override
  void dispose() {
    _evtDebounce?.cancel();
    _evtSub?.cancel();
    _timer?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadCached() async {
    final cached = await PageCache.readList("chat.digest");
    if (cached != null && mounted && _items.isEmpty) {
      setState(() {
        _items = [for (final e in cached) _DigestItemMapper.from(e as Map<String, dynamic>)];
        _loading = false;
      });
    }
  }

  Future<void> _reload({bool quiet = false}) async {
    if (!quiet) setState(() => _loading = true);
    try {
      final resp = await widget.client.request("chat.digest");
      final raw = resp["result"]["digest"] as List<dynamic>? ?? const [];
      final list = raw.map((e) => _DigestItemMapper.from(e as Map<String, dynamic>)).toList();
      await PageCache.write("chat.digest", raw);
      if (mounted) setState(() { _items = list; _loading = false; _error = null; });
    } catch (e) {
      // 有缓存数据时失败静默(保持旧内容;连接横幅已在 shell 层提示)。
      if (mounted && !quiet && _items.isEmpty) setState(() { _loading = false; _error = e.toString(); });
    }
  }

  void _openChat(_DigestItem it) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ChatPage(
        client: widget.client,
        projectId: it.projectId,
        projectName: it.projectName,
        tabId: it.tabId,
        tabTitle: it.tabTitle,
        paneLabel: "",
      ),
    )).then((_) => _reload(quiet: true));
  }

  @override
  Widget build(BuildContext context) {
    // 不设 AppBar:底部导航已有「消息」标签,顶部再挂一个 title 是重复占位。
    return Scaffold(body: _body());
  }

  Widget _body() {
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null && _items.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off, size: 30, color: Mx.muted),
            const SizedBox(height: 8),
            Text("$_error", style: const TextStyle(fontSize: 12, color: Mx.muted)),
            const SizedBox(height: 10),
            OutlinedButton(onPressed: () => _reload(), child: const Text("重试")),
          ],
        ),
      );
    }
    if (_items.isEmpty) {
      return const Center(
        child: Text("暂无 AI 对话\n桌面端打开 claude / codex tab 后出现在这里",
            textAlign: TextAlign.center, style: TextStyle(fontSize: 13, height: 1.7, color: Mx.muted)),
      );
    }
    // 按项目分组后**在线优先**重排(与项目页同口径):含 busy 的项目组最前,次之含
    // 在线(started)会话;组内 busy > started > 其余。分桶拼接而非 sort——Dart 的
    // List.sort 不稳定,同档要保持 digest 原顺序。
    final groups = <String, List<_DigestItem>>{};
    for (final it in _items) {
      groups.putIfAbsent(it.projectName, () => []).add(it);
    }
    int grpRank(List<_DigestItem> g) => g.any((i) => i.busy)
        ? 0
        : g.any((i) => i.started)
            ? 1
            : 2;
    final gBuckets = [for (var i = 0; i < 3; i++) <MapEntry<String, List<_DigestItem>>>[]];
    for (final e in groups.entries) {
      gBuckets[grpRank(e.value)].add(e);
    }
    final orderedGroups = gBuckets.expand((b) => b).toList();
    return RefreshIndicator(
      onRefresh: () => _reload(),
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          for (final entry in orderedGroups) ...[
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Row(children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(color: Mx.violetSoft, borderRadius: BorderRadius.circular(6)),
                  child: Text(entry.key, style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Mx.violet)),
                ),
                const SizedBox(width: 8),
                const Expanded(child: Divider(height: 1)),
              ]),
            ),
            for (final it in _sortedGroup(entry.value)) _tile(it),
          ],
          const SizedBox(height: 12),
        ],
      ),
    );
  }

  /// 组内在线优先(busy > started > 其余;分桶保序)。
  List<_DigestItem> _sortedGroup(List<_DigestItem> g) {
    final buckets = [for (var i = 0; i < 3; i++) <_DigestItem>[]];
    for (final it in g) {
      buckets[it.busy ? 0 : (it.started ? 1 : 2)].add(it);
    }
    return buckets.expand((b) => b).toList();
  }

  Widget _tile(_DigestItem it) {
    final isClaude = it.kind == "claude";
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      leading: CircleAvatar(
        radius: 19,
        backgroundColor: isClaude ? Mx.brandGradient.colors.first : Mx.violetSoft,
        child: Icon(isClaude ? Icons.auto_awesome : Icons.hub_outlined,
            size: 19, color: isClaude ? Mx.accentContrast : Mx.violet),
      ),
      title: Text(
        it.tabTitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
      ),
      subtitle: it.busy
          ? const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                SizedBox(
                  width: 12, height: 12,
                  child: CircularProgressIndicator(strokeWidth: 1.8, color: Mx.accent),
                ),
                SizedBox(width: 6),
                Text("正在对话…", style: TextStyle(fontSize: 12, color: Mx.accentBright)),
              ],
            )
          : Text(
              it.lastText.isEmpty ? "尚未对话" : it.lastText,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: Mx.muted),
            ),
      trailing: it.busy
          ? Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
              decoration: BoxDecoration(
                color: Mx.accent,
                borderRadius: BorderRadius.circular(999),
              ),
              child: const Text("对话中",
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: Mx.accentContrast)),
            )
          : _timeLabel(it.lastTs),
      onTap: () => _openChat(it),
    );
  }

  /// ISO8601 → 「HH:mm」/「昨天」/「MM-dd」(解析失败返回 null 不占位)。
  Widget? _timeLabel(String ts) {
    if (ts.isEmpty) return null;
    final t = DateTime.tryParse(ts);
    if (t == null) return null;
    final now = DateTime.now();
    String two(int v) => v.toString().padLeft(2, "0");
    final local = t.toLocal();
    final isToday = local.year == now.year && local.month == now.month && local.day == now.day;
    final isYest = now.subtract(const Duration(days: 1));
    final isYesterday = local.year == isYest.year && local.month == isYest.month && local.day == isYest.day;
    final label = isToday
        ? "${two(local.hour)}:${two(local.minute)}"
        : isYesterday
            ? "昨天"
            : "${two(local.month)}-${two(local.day)}";
    return Text(label, style: const TextStyle(fontSize: 11, color: Mx.faint));
  }
}

class _DigestItemMapper {
  static _DigestItem from(Map<String, dynamic> j) => _DigestItem(
        projectId: j["projectId"] ?? "",
        projectName: j["projectName"] ?? "",
        tabId: j["tabId"] ?? "",
        tabTitle: j["tabTitle"] ?? "",
        kind: j["kind"] ?? "claude",
        busy: j["busy"] == true,
        started: j["started"] == true,
        lastText: j["lastText"] ?? "",
        lastTs: j["lastTs"] ?? "",
      );
}
