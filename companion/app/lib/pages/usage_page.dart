import 'package:flutter/material.dart';

import '../models.dart';
import '../relay/client.dart';
import '../page_cache.dart';
import '../theme.dart';

/// 用量页:近 7 天汇总 + 按日列表(输入/输出/缓存/请求数)。
class UsagePage extends StatefulWidget {
  final RelayClient client;
  const UsagePage({super.key, required this.client});

  @override
  State<UsagePage> createState() => _UsagePageState();
}

class _UsagePageState extends State<UsagePage> {
  UsageSummary? _summary;
  String? _error;
  bool _fromSnapshot = false;

  @override
  void initState() {
    super.initState();
    _loadCached();
    _load();
  }

  Future<void> _loadCached() async {
    final cached = await PageCache.readObject("usage");
    if (cached != null && mounted && _summary == null) {
      setState(() => _summary = UsageSummary.fromJson(cached));
    }
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final resp = await widget.client.request("usage.summary", {"days": 7});
      await PageCache.write("usage", resp["result"]);
      if (mounted) {
        setState(() { _summary = UsageSummary.fromJson(resp["result"]); _fromSnapshot = false; });
      }
    } catch (_) {
      try {
        final snap = await widget.client.fetchSnapshot();
        final usage = snap == null ? null : DesktopSnapshot.fromJson(snap).usage;
        if (usage != null && mounted) {
          setState(() { _summary = usage; _fromSnapshot = true; });
          return;
        }
      } catch (_) {}
      if (mounted && _summary == null) setState(() => _error = "电脑离线且无快照");
    }
  }

  String fmtTokens(int n) {
    if (n >= 1000000000) return "${(n / 1000000000).toStringAsFixed(1)}B";
    if (n >= 1000000) return "${(n / 1000000).toStringAsFixed(1)}M";
    if (n >= 1000) return "${(n / 1000).toStringAsFixed(1)}K";
    return "$n";
  }

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
            Text("电脑离线 — 显示最近快照", style: TextStyle(fontSize: 11, color: Mx.warning)),
          ]),
        ),
      if (_error != null)
        Padding(padding: const EdgeInsets.all(24), child: Center(child: Text(_error!, style: const TextStyle(color: Mx.muted, fontSize: 13)))),
      if (s != null) ..._buildBody(s),
    ]));
  }

  List<Widget> _buildBody(UsageSummary s) {
    // 按日聚合(rollups 是 日×app×model 粒度,汇总到日)。
    final byDate = <String, _DayAgg>{};
    var totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheW = 0, totalReq = 0;
    for (final r in s.rollups) {
      final agg = byDate.putIfAbsent(r.date, _DayAgg.new);
      agg.requests += r.requests;
      agg.input += r.inputTokens;
      agg.output += r.outputTokens;
      agg.cacheRead += r.cacheReadTokens;
      agg.cacheCreation += r.cacheCreationTokens;
      totalIn += r.inputTokens;
      totalOut += r.outputTokens;
      totalCacheR += r.cacheReadTokens;
      totalCacheW += r.cacheCreationTokens;
      totalReq += r.requests;
    }
    final days = byDate.keys.toList()..sort((a, b) => b.compareTo(a));
    return [
      // 汇总卡(总量 = 四段和,与桌面端 Hero 口径一致)。
      // 配色沿用桌面端用量图的语义:输出=金,输入=主文字,缓存=灰阶。
      Card(child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text("近 7 天", style: TextStyle(fontSize: 11, color: Mx.faint, letterSpacing: 0.2)),
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
            _stat("会话", "${s.claudeSessions + s.codexSessions}", Mx.dim),
          ]),
        ]),
      )),
      // 按日明细。
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

  Widget _stat(String label, String value, Color color) {
    return Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      Text(label, style: const TextStyle(fontSize: 10, color: Mx.faint)),
      Text(value, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: color)),
    ]);
  }
}

class _DayAgg {
  int requests = 0, input = 0, output = 0, cacheRead = 0, cacheCreation = 0;
}
