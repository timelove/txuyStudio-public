import 'package:flutter/material.dart';

import '../models.dart';
import '../relay/client.dart';
import '../page_cache.dart';
import '../theme.dart';

/// 用量页:汇总卡 + 按日列表。筛选与桌面端 UsagePanel 同口径(2026-11-05 用户定调):
/// 预设 今日/昨日/近7/近14/近30/全部,**默认今日**;外加 app 段选(全部/Claude/Codex)。
/// 数据一次拉 120 天(桌面 USAGE_INITIAL_DAYS 同值),筛选纯前端按 date 串过滤。
class UsagePage extends StatefulWidget {
  final RelayClient client;
  /// 是否为当前底部导航 tab(HomeShell 传入):切回时静默刷新带出新数据,
  /// 否则 IndexedStack 常驻内存只在首开拉一次,桌面端新消耗永远不出现。
  final bool active;
  const UsagePage({super.key, required this.client, required this.active});

  @override
  State<UsagePage> createState() => _UsagePageState();
}

class _UsagePageState extends State<UsagePage> {
  UsageSummary? _summary;
  String? _error;
  bool _fromSnapshot = false;
  bool _loading = false;
  // 日期预设:today | yesterday | d7 | d14 | d30 | all(桌面同款六档)。
  String _range = "today";
  // app 筛选:all | claude | codex(Rollup.app 字段)。
  String _app = "all";

  @override
  void initState() {
    super.initState();
    _loadCached();
    _load();
  }

  @override
  void didUpdateWidget(UsagePage old) {
    super.didUpdateWidget(old);
    // 首次切到本 tab 才刷(old.active=false→active=true),页内切筛选不触发。
    if (widget.active && !old.active && !_loading) _load();
  }

  Future<void> _loadCached() async {
    final cached = await PageCache.readObject("usage");
    if (cached != null && mounted && _summary == null) {
      setState(() => _summary = UsageSummary.fromJson(cached));
    }
  }

  Future<void> _load() async {
    // 静默刷新:已有数据时清 error 但不清 summary,失败保留旧内容(SWR 语义)。
    setState(() { _error = null; _loading = true; });
    try {
      // 120 天一窗拉全(桌面端初始窗口同值),前端按筛选切片;切换筛选不重新请求。
      final resp = await widget.client.request("usage.summary", {"days": 120});
      await PageCache.write("usage", resp["result"]);
      if (mounted) {
        setState(() { _summary = UsageSummary.fromJson(resp["result"]); _fromSnapshot = false; });
      }
    } catch (_) {
      // 已有数据(SWR 后台刷新)失败就静默保留旧数据,横幅/空态只在无数据时出现。
      if (_summary != null) return;
      try {
        final snap = await widget.client.fetchSnapshot();
        final usage = snap == null ? null : DesktopSnapshot.fromJson(snap).usage;
        if (usage != null && mounted) {
          // 快照兜底固定 7 天窗口(桌面 build_snapshot 口径),筛选照常可用但更早日期为空。
          setState(() { _summary = usage; _fromSnapshot = true; });
          return;
        }
      } catch (_) {}
      if (mounted && _summary == null) setState(() => _error = "连接已断开且无快照");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String fmtTokens(int n) {
    if (n >= 1000000000) return "${(n / 1000000000).toStringAsFixed(1)}B";
    if (n >= 1000000) return "${(n / 1000000).toStringAsFixed(1)}M";
    if (n >= 1000) return "${(n / 1000).toStringAsFixed(1)}K";
    return "$n";
  }

  /// 本地日期串 yyyy-MM-dd(Rollup.date 同格式,字符串比较即时间序)。
  static String _dateStr(DateTime d) =>
      "${d.year.toString().padLeft(4, "0")}-${d.month.toString().padLeft(2, "0")}-${d.day.toString().padLeft(2, "0")}";

  /// 当前预设的 [from, to] 闭区间(null = 全部),与桌面端预设口径一致:
  /// 今日 from=to=今天;昨日 from=to=昨天;近7 from=今天-6 …(含今天共 N 天)。
  (String?, String?) get _rangeWindow {
    final today = DateTime.now();
    String d(int daysAgo) => _dateStr(today.subtract(Duration(days: daysAgo)));
    switch (_range) {
      case "today":
        return (d(0), d(0));
      case "yesterday":
        return (d(1), d(1));
      case "d7":
        return (d(6), d(0));
      case "d14":
        return (d(13), d(0));
      case "d30":
        return (d(29), d(0));
      default:
        return (null, null);
    }
  }

  static const _rangeLabels = {
    "today": "今日",
    "yesterday": "昨日",
    "d7": "近7天",
    "d14": "近14天",
    "d30": "近30天",
    "all": "全部",
  };

  @override
  Widget build(BuildContext context) {
    final s = _summary;
    return RefreshIndicator(onRefresh: _load, child: ListView(children: [
      if (_fromSnapshot)
        Container(
          margin: const EdgeInsets.fromLTRB(12, 8, 12, 0),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: Mx.warningSoft,
            borderRadius: BorderRadius.circular(Mx.radiusMd),
            border: Border.all(color: Mx.warning),
          ),
          child: const Row(children: [
            Icon(Icons.cloud_off, size: 13, color: Mx.warning),
            SizedBox(width: 6),
            Text("连接已断开 — 显示最近快照", style: TextStyle(fontSize: 11, color: Mx.warning)),
          ]),
        ),
      if (_error != null)
        Padding(padding: const EdgeInsets.all(24), child: Center(child: Text(_error!, style: const TextStyle(color: Mx.muted, fontSize: 13)))),
      if (s != null) ..._buildBody(s),
    ]));
  }

  List<Widget> _buildBody(UsageSummary s) {
    final (fromStr, toStr) = _rangeWindow;
    // 按日聚合(rollups 是 日×app×model 粒度,汇总到日);筛选纯前端。
    final byDate = <String, _DayAgg>{};
    var totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheW = 0, totalReq = 0, totalSessions = 0;
    for (final r in s.rollups) {
      if (_app != "all" && r.app != _app) continue;
      if (fromStr != null && (r.date.compareTo(fromStr) < 0 || r.date.compareTo(toStr!) > 0)) continue;
      final agg = byDate.putIfAbsent(r.date, _DayAgg.new);
      agg.requests += r.requests;
      agg.input += r.inputTokens;
      agg.output += r.outputTokens;
      agg.cacheRead += r.cacheReadTokens;
      agg.cacheCreation += r.cacheCreationTokens;
      agg.sessions += r.sessions;
      totalIn += r.inputTokens;
      totalOut += r.outputTokens;
      totalCacheR += r.cacheReadTokens;
      totalCacheW += r.cacheCreationTokens;
      totalReq += r.requests;
      totalSessions += r.sessions;
    }
    // 会话数 = 范围内逐桶求和(Rollup.sessions 已按 日×app×model 桶内 distinct,
    // 求和跨桶可能极小概率重复计数,与桌面端 distinct 日志口径的偏差可忽略)。
    // 不能用 summary 总口径:claude/codexSessions 是全窗口的,不随「今日」筛选。
    final sessions = totalSessions;
    final days = byDate.keys.toList()..sort((a, b) => b.compareTo(a));
    return [
      // 筛选行:日期预设 chips(横向滚动,窄屏不折行)+ app 段选。
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
        child: Row(children: [
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(children: [
                for (final e in _rangeLabels.entries)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: _chip(_rangeLabels[e.key]!, _range == e.key, () => setState(() => _range = e.key)),
                  ),
              ]),
            ),
          ),
        ]),
      ),
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
        child: SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: "all", label: Text("全部", style: TextStyle(fontSize: 11))),
            ButtonSegment(value: "claude", label: Text("Claude", style: TextStyle(fontSize: 11))),
            ButtonSegment(value: "codex", label: Text("Codex", style: TextStyle(fontSize: 11))),
          ],
          selected: {_app},
          onSelectionChanged: (sel) => setState(() => _app = sel.first),
          style: const ButtonStyle(
            visualDensity: VisualDensity.compact,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            side: WidgetStatePropertyAll(BorderSide(color: Mx.border)),
            backgroundColor: WidgetStatePropertyAll(Colors.transparent),
            foregroundColor: WidgetStatePropertyAll(Mx.muted),
          ),
          showSelectedIcon: false,
        ),
      ),
      // 汇总卡(总量 = 四段和,与桌面端 Hero 口径一致)。
      // 配色沿用桌面端用量图的语义:输出=金,输入=主文字,缓存=灰阶。
      Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(_rangeLabels[_range] ?? "全部", style: const TextStyle(fontSize: 11, color: Mx.faint, letterSpacing: 0.2)),
          const SizedBox(height: 4),
          Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
            Text(fmtTokens(totalIn + totalOut + totalCacheR + totalCacheW),
                style: const TextStyle(fontSize: 27, fontWeight: FontWeight.bold, color: Mx.textBright, letterSpacing: -0.3)),
            const SizedBox(width: 6),
            const Text("tokens", style: TextStyle(fontSize: 11, color: Mx.faint)),
          ]),
          const SizedBox(height: 2),
          Container(width: 26, height: 2, decoration: BoxDecoration(gradient: Mx.brandGradient, borderRadius: BorderRadius.circular(1))),
          const SizedBox(height: 10),
          Wrap(spacing: 18, runSpacing: 8, children: [
            _stat("输入", fmtTokens(totalIn), Mx.text),
            _stat("输出", fmtTokens(totalOut), Mx.accentBright),
            _stat("缓存读", fmtTokens(totalCacheR), Mx.muted),
            _stat("缓存写", fmtTokens(totalCacheW), Mx.faint),
            _stat("请求", "$totalReq", Mx.dim),
            _stat("会话", "$sessions", Mx.dim),
          ]),
        ]),
      )),
      // 按日明细。
      if (days.isEmpty)
        Padding(
          padding: const EdgeInsets.all(24),
          child: Center(child: Text("该范围内暂无用量", style: const TextStyle(color: Mx.muted, fontSize: 13))),
        ),
      for (final d in days)
        Card(child: ListTile(
          dense: true,
          title: Text(d, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Mx.textBright)),
          subtitle: Text(
            "输入 ${fmtTokens(byDate[d]!.input)} · 输出 ${fmtTokens(byDate[d]!.output)} · 缓存 ${fmtTokens(byDate[d]!.cacheRead + byDate[d]!.cacheCreation)}",
            style: const TextStyle(fontSize: 11, color: Mx.muted),
          ),
          trailing: Text("${byDate[d]!.requests} req",
              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Mx.accentBright)),
        )),
    ];
  }

  Widget _chip(String label, bool active, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(Mx.radiusSm),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: active ? Mx.accentSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(Mx.radiusSm),
          border: Border.all(color: active ? Mx.selectedBorder : Mx.border),
        ),
        child: Text(label, style: TextStyle(
          fontSize: 11,
          fontWeight: active ? FontWeight.w600 : FontWeight.w400,
          color: active ? Mx.accentBright : Mx.muted,
        )),
      ),
    );
  }

  Widget _stat(String label, String value, Color color) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text(label, style: const TextStyle(fontSize: 10, color: Mx.faint)),
      Text(value, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: color)),
    ]);
  }
}

class _DayAgg {
  int requests = 0, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sessions = 0;
}
