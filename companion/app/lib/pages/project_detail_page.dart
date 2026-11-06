import 'dart:async';

import 'package:flutter/material.dart';

import '../models.dart';
import '../relay/client.dart';
import '../theme.dart';
import 'chat_page.dart';
import 'terminal_mirror_page.dart';

/// 项目详情:按桌面端 pane 顺序分节,每节列出该 pane 的 tab。
///
/// 手机不模拟左右分割(小屏不可用),但**分组与顺序严格跟随桌面端**。只有 AI tab
/// (claudepane/codexpane)可点进对话页;shell/test 置灰并说明原因。
class ProjectDetailPage extends StatefulWidget {
  final RelayClient client;
  final ProjectInfo project;
  final bool online;
  const ProjectDetailPage({
    super.key,
    required this.client,
    required this.project,
    required this.online,
  });

  @override
  State<ProjectDetailPage> createState() => _ProjectDetailPageState();
}

class _ProjectDetailPageState extends State<ProjectDetailPage> {
  late ProjectInfo _project = widget.project;
  late bool _online = widget.online;
  StreamSubscription<RelayConnState>? _connSub;
  StreamSubscription<Map<String, dynamic>>? _evtSub;
  Timer? _evtDebounce;

  @override
  void initState() {
    super.initState();
    // `widget.online` 是进页那一刻的快照:停留期间断线/恢复不会自动更新,这里跟连接流。
    _connSub = widget.client.stateStream.listen((s) {
      if (!mounted) return;
      final online = s == RelayConnState.online;
      if (online == _online) return;
      setState(() => _online = online);
      if (online) _refresh();
    });
    // 对话事件驱动刷新(限本项目):在线标签/置顶排序近实时跟进。桌面每条流式事件
    // 都推,2s 防抖聚合一轮再拉,避免打爆 projects.list。
    _evtSub = widget.client.events.listen((frame) {
      if (frame["ev"] != "chat.event") return;
      final data = (frame["data"] as Map?)?.cast<String, dynamic>();
      if (data == null || data["projectId"] != widget.project.id) return;
      _evtDebounce?.cancel();
      _evtDebounce = Timer(const Duration(seconds: 2), () {
        if (mounted) _refresh();
      });
    });
    _refresh();
  }

  @override
  void dispose() {
    _evtDebounce?.cancel();
    _evtSub?.cancel();
    _connSub?.cancel();
    super.dispose();
  }

  /// 刷新项目结构(桌面端可能刚分屏/新开 tab)。失败静默保留旧结构。
  Future<void> _refresh() async {
    try {
      final resp = await widget.client.request("projects.list");
      final list = (resp["result"]["projects"] as List<dynamic>)
          .map((e) => ProjectInfo.fromJson(e))
          .where((p) => p.id == widget.project.id)
          .toList();
      if (list.isNotEmpty && mounted) setState(() => _project = list.first);
    } catch (_) {}
  }

  /// pane 展示序(桌面原 index 列表,按在线优先重排;同档保持桌面顺序)。
  List<int> get _orderedPaneIndices {
    final panes = _project.panes;
    final idx = [for (var i = 0; i < panes.length; i++) i];
    int rank(int i) => panes[i].hasBusy ? 0 : (panes[i].hasLiveAi ? 1 : 2);
    idx.sort((a, b) {
      final r = rank(a) - rank(b);
      return r != 0 ? r : a - b;
    });
    return idx;
  }

  void _openChat(PaneInfo pane, TabInfo tab, int paneIndex) {
    Navigator.of(context)
        .push(MaterialPageRoute(
          builder: (_) => ChatPage(
            client: widget.client,
            projectId: _project.id,
            projectName: _project.name,
            tabId: tab.id,
            tabTitle: tab.title.isEmpty ? tab.kind : tab.title,
            paneLabel: "pane ${paneIndex + 1}",
          ),
        ))
        .then((_) => _refresh());
  }

  /// 非 AI tab(shell / test)→ 只读终端镜像。
  ///
  /// 手机不能往里打字(v1 取舍,见 `terminal_mirror_page.dart` 注释),但「看到此刻
  /// 终端在跑什么」比「什么也看不到」有用得多:长任务进度、报错、测试结果都能瞄一眼。
  void _openMirror(TabInfo tab) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TerminalMirrorPage(
        client: widget.client,
        projectId: _project.id,
        tabId: tab.id,
        tabTitle: tab.title.isEmpty ? tab.kind : tab.title,
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final panes = _project.panes;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_project.name, overflow: TextOverflow.ellipsis),
            Text(
              "${_project.panes.length} pane · ${_project.tabs.length} tab",
              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w400, color: Mx.muted),
            ),
          ],
        ),
        actions: [
          IconButton(icon: const Icon(Icons.refresh, size: 18), tooltip: "刷新结构", onPressed: _refresh),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          padding: const EdgeInsets.only(bottom: 16),
          children: [
            if (!_online)
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
                  Expanded(
                    child: Text("电脑离线 — 显示最近结构,无法发消息",
                        style: TextStyle(fontSize: 11, color: Mx.warning)),
                  ),
                ]),
              ),
            // 在线优先排序:含 busy tab 的 pane 最前,次之含在线(started)AI tab,
            // 其余保持桌面顺序。序号仍用桌面原 index(「pane N」不随排序变)。
            ..._orderedPaneIndices.map((i) => _paneSection(panes[i], i)),
            if (panes.isEmpty)
              const Padding(
                padding: EdgeInsets.all(32),
                child: Center(
                  child: Text("该项目还没有 pane", style: TextStyle(fontSize: 13, color: Mx.muted)),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _paneSection(PaneInfo pane, int index) {
    final tabs = pane.sortedTabs;
    return Card(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 节标题:pane 序号 + 分屏比例(桌面端的布局信息在手机上的最小映射)。
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
            child: Row(children: [
              Container(
                width: 4,
                height: 14,
                decoration: BoxDecoration(
                  color: pane.hasAi ? Mx.accent : Mx.borderStrong,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                "pane ${index + 1}",
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Mx.textBright),
              ),
              const SizedBox(width: 6),
              Text("· ${pane.ratio}%",
                  style: const TextStyle(fontSize: 11, color: Mx.dim)),
              if (pane.split != null) ...[
                const SizedBox(width: 6),
                Text(
                  pane.split == "horizontal" ? "左右分屏" : "上下分屏",
                  style: const TextStyle(fontSize: 10, color: Mx.faint),
                ),
              ],
            ]),
          ),
          for (final tab in tabs) _tabRow(pane, tab, index),
          if (tabs.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(14, 2, 14, 12),
              child: Text("空 pane", style: TextStyle(fontSize: 11, color: Mx.faint)),
            ),
          const SizedBox(height: 6),
        ],
      ),
    );
  }

  Widget _tabRow(PaneInfo pane, TabInfo tab, int paneIndex) {
    final ai = tab.isAi;
    final title = tab.title.isEmpty ? tab.kind : tab.title;
    return InkWell(
      onTap: ai ? () => _openChat(pane, tab, paneIndex) : () => _openMirror(tab),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
        child: Row(children: [
          Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: ai ? _providerSoft(tab) : Mx.cardInner,
              borderRadius: BorderRadius.circular(Mx.radiusSm),
              border: Border.all(color: ai ? _providerBorder(tab) : Mx.borderSoft),
            ),
            child: Text(
              _providerGlyph(tab.kind),
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.bold,
                color: ai ? _providerColor(tab) : Mx.faint,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(children: [
                  Expanded(
                    child: Text(
                      title,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: ai ? FontWeight.w600 : FontWeight.w500,
                        color: ai ? Mx.textBright : Mx.dim,
                      ),
                    ),
                  ),
                  if (ai && tab.busy) ...[
                    _liveBadge("对话中", bg: Mx.accent, fg: Mx.accentContrast),
                    const SizedBox(width: 6),
                  ] else if (ai && tab.started) ...[
                    _liveBadge("在线", bg: Mx.successSoft, fg: Mx.success, border: Mx.success),
                    const SizedBox(width: 6),
                  ],
                ]),
                Text(
                  ai
                      ? (tab.provider == "claude" ? "Claude 对话" : "Codex 对话")
                      : "${_plainKindLabel(tab.kind)} · 只读镜像",
                  style: const TextStyle(fontSize: 10, color: Mx.faint),
                ),
              ],
            ),
          ),
          Icon(Icons.chevron_right, size: 18, color: ai ? Mx.accentBright : Mx.faint),
        ]),
      ),
    );
  }

  /// 在线状态小标签(对话中 = 金色实底最醒目;在线 = 绿色软底描边,一眼可辨)。
  Widget _liveBadge(String text, {required Color bg, required Color fg, Color? border}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: border != null ? Border.all(color: border, width: 0.6) : null,
      ),
      child: Text(text, style: TextStyle(fontSize: 9, fontWeight: FontWeight.w600, color: fg)),
    );
  }

  static String _providerGlyph(String kind) => switch (kind) {
        "claudepane" || "claude" => "C",
        "codexpane" || "codex" => "X",
        "shell" => ">",
        "test" => "T",
        _ => "·",
      };

  static String _plainKindLabel(String kind) => switch (kind) {
        "shell" => "终端",
        "test" => "测试命令",
        _ => kind,
      };

  static Color _providerColor(TabInfo t) => t.provider == "claude" ? Mx.violet : Mx.info;
  static Color _providerSoft(TabInfo t) => t.provider == "claude" ? Mx.violetSoft : Mx.infoSoft;
  static Color _providerBorder(TabInfo t) => t.provider == "claude" ? Mx.violetBorder : Mx.border;
}
