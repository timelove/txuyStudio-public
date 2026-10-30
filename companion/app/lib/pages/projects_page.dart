import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models.dart';
import '../relay/client.dart';
import '../page_cache.dart';
import '../theme.dart';
import 'chat_page.dart';
import 'project_detail_page.dart';

/// 项目页:projects.list(在线) / 快照 projects(离线兜底)。
///
/// 点卡片 → 项目详情(pane 分节 → 选 AI tab → 对话);卡片上的「继续」按钮直达
/// 上次进入的那个对话(SharedPreferences 记忆)。
class ProjectsPage extends StatefulWidget {
  final RelayClient client;
  const ProjectsPage({super.key, required this.client});

  @override
  State<ProjectsPage> createState() => _ProjectsPageState();
}

class _ProjectsPageState extends State<ProjectsPage> {
  List<ProjectInfo>? _projects;
  String? _error;
  bool _fromSnapshot = false;
  String? _lastChatKey; // "<projectId>|<tabId>"
  /// 正在请求激活的项目 id(按钮转圈 + 防连点)。
  String? _activating;

  @override
  void initState() {
    super.initState();
    _loadLastChat();
    _loadCached(); // 先渲染缓存(stale-while-revalidate),再后台刷新。
    _load();
  }

  Future<void> _loadCached() async {
    final cached = await PageCache.readList("projects");
    if (cached != null && mounted && (_projects?.isEmpty ?? true)) {
      setState(() => _projects = [for (final e in cached) ProjectInfo.fromJson(e)]);
    }
  }

  Future<void> _loadLastChat() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final v = prefs.getString("lastChat");
      if (mounted && v != null) setState(() => _lastChatKey = v);
    } catch (_) {}
  }

  bool get _online => widget.client.state == RelayConnState.online;

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final resp = await widget.client.request("projects.list");
      final raw = resp["result"]["projects"] as List<dynamic>;
      final list = raw.map((e) => ProjectInfo.fromJson(e)).toList();
      await PageCache.write("projects", raw);
      if (mounted) setState(() { _projects = list; _fromSnapshot = false; });
    } catch (e) {
      // 桌面端离线 → 拉中继快照兜底。
      try {
        final snap = await widget.client.fetchSnapshot();
        if (snap != null && mounted) {
          setState(() { _projects = DesktopSnapshot.fromJson(snap).projects; _fromSnapshot = true; });
          return;
        }
      } catch (_) {}
      if (mounted && (_projects?.isEmpty ?? true)) setState(() => _error = "电脑离线且无快照");
    }
  }

  void _openDetail(ProjectInfo p) {
    Navigator.of(context)
        .push(MaterialPageRoute(
          builder: (_) => ProjectDetailPage(client: widget.client, project: p, online: _online),
        ))
        .then((_) => _load());
  }

  /// 「继续上次对话」:优先上次那个 tab,项目里已没有就退到首个 AI tab。
  void _resumeChat(ProjectInfo p) {
    TabInfo? target;
    if (_lastChatKey != null && _lastChatKey!.startsWith("${p.id}|")) {
      final tabId = _lastChatKey!.split("|").last;
      for (final pane in p.panes) {
        for (final t in pane.tabs) {
          if (t.id == tabId && t.isAi) target = t;
        }
      }
    }
    target ??= p.firstAiTab;
    if (target == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("这个项目还没有 AI tab")),
      );
      return;
    }
    final tab = target;
    Navigator.of(context)
        .push(MaterialPageRoute(
          builder: (_) => ChatPage(
            client: widget.client,
            projectId: p.id,
            projectName: p.name,
            tabId: tab.id,
            tabTitle: tab.title.isEmpty ? tab.kind : tab.title,
            paneLabel: "继续上次",
          ),
        ))
        .then((_) => _load());
  }

  /// 远程激活:手机点「激活」→ 桌面端切到该项目(后端 `projects.activate` 落盘 + emit
  /// `active-project-changed`,桌面主窗口监听后 setActiveProjectId)。
  ///
  /// 成功后 `_load()` 重拉列表,`isActive` 徽章就跟着挪到新项目上——手机端不需要自己
  /// 维护激活态,始终以后端为准(桌面端自己切项目也能在下一次刷新时同步过来)。
  Future<void> _activate(ProjectInfo p) async {
    if (_activating != null) return;
    setState(() => _activating = p.id);
    try {
      await widget.client.request("projects.activate", {"projectId": p.id});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("已在电脑上激活「${p.name}」")),
        );
      }
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("激活失败:$e")),
        );
      }
    } finally {
      if (mounted) setState(() => _activating = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final projects = _projects;
    return RefreshIndicator(onRefresh: _load, child: ListView(
      children: [
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
        if (projects != null)
          for (final p in projects) _projectCard(p),
        ],
    ));
  }

  Widget _projectCard(ProjectInfo p) {
    final ai = p.firstAiTab;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(Mx.radiusLg),
        onTap: () => _openDetail(p),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ListTile(
              leading: Container(
                width: 36, height: 36,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: p.isActive ? Mx.accentSoft : Mx.cardInner,
                  borderRadius: BorderRadius.circular(Mx.radiusMd),
                  border: Border.all(color: p.isActive ? Mx.selectedBorder : Mx.border),
                ),
                child: Text(p.name.isEmpty ? "?" : p.name.substring(0, 1),
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold,
                        color: p.isActive ? Mx.accentBright : Mx.muted)),
              ),
              title: Row(children: [
                Flexible(child: Text(p.name, overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: Mx.textBright))),
                if (p.isActive)
                  Container(
                    margin: const EdgeInsets.only(left: 6),
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      color: Mx.accentSoft,
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: Mx.selectedBorder),
                    ),
                    child: const Text("active", style: TextStyle(fontSize: 9, fontWeight: FontWeight.w600, color: Mx.accentBright)),
                  ),
              ]),
              subtitle: Text(
                "${rootPathShort(p.rootPath)} · ${p.panes.length} pane · ${p.tabs.length} tab",
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Mx.muted),
              ),
              trailing: const Icon(Icons.chevron_right, size: 18, color: Mx.faint),
            ),
            if (p.tabs.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                child: Wrap(
                  spacing: 6, runSpacing: 4,
                  children: [
                    for (final t in p.tabs.take(4))
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: t.isAi ? Mx.violetSoft : Mx.cardInner,
                          borderRadius: BorderRadius.circular(Mx.radiusSm),
                          border: Border.all(color: t.isAi ? Mx.violetBorder : Mx.borderSoft),
                        ),
                        child: Text(
                          "${kindGlyph(t.kind)} ${t.title.isEmpty ? t.kind : t.title}",
                          style: TextStyle(fontSize: 10, color: t.isAi ? Mx.violet : Mx.muted),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    if (p.tabs.length > 4)
                      Text("+${p.tabs.length - 4}", style: const TextStyle(fontSize: 10, color: Mx.faint)),
                  ],
                ),
              ),
            if (ai != null || _online)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                child: Row(children: [
                if (ai != null) ...[
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: () => _resumeChat(p),
                      icon: Icon(
                        ai.provider == "claude" ? Icons.auto_awesome : Icons.terminal,
                        size: 15,
                      ),
                      label: Text(
                        "继续对话 · ${ai.title.isEmpty ? ai.kind : ai.title}",
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12),
                      ),
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 34)),
                    ),
                  ),
                  const SizedBox(width: 8),
                ],
                // 远程激活:桌面端可能开着很多项目,只有一个处于激活(pane 树可见)。
                // 手机上想切哪个就地切,不用跑到电脑前点。
                if (_online)
                  OutlinedButton.icon(
                    onPressed: (p.isActive || _activating != null) ? null : () => _activate(p),
                    icon: _activating == p.id
                        ? const SizedBox(
                            width: 13, height: 13,
                            child: CircularProgressIndicator(strokeWidth: 1.6),
                          )
                        : const Icon(Icons.bolt, size: 15),
                    label: Text(p.isActive ? "已激活" : "激活",
                        style: const TextStyle(fontSize: 12)),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size(0, 34),
                      foregroundColor: p.isActive ? Mx.muted : Mx.accentBright,
                      side: BorderSide(color: p.isActive ? Mx.border : Mx.selectedBorder),
                    ),
                  ),
              ]),
            ),
          ],
        ),
      ),
    );
  }

  static String rootPathShort(String p) {
    final parts = p.replaceAll("\\", "/").split("/").where((s) => s.isNotEmpty).toList();
    if (parts.isEmpty) return p;
    return parts.take(3).join("/") + (parts.length > 3 ? "/…" : "");
  }

  static String kindGlyph(String kind) {
    return switch (kind) {
      "claude" || "claudepane" => "C",
      "codex" || "codexpane" => "X",
      "shell" => ">",
      "test" => "T",
      _ => "·",
    };
  }
}
