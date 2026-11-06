import 'package:flutter/material.dart';

import '../models.dart';
import '../relay/client.dart';
import '../page_cache.dart';
import '../theme.dart';

/// 会话页:AI 历史会话列表,**按项目(cwd)分组**,组内/组间都按最近活动倒序。
///
/// 分组语义移植自桌面端 `src/domain/aiCliSessions.ts` 的 `groupSessionsByProject`:
/// - key = cwd 规范化(去 Windows verbatim 前缀 `\\?\`、去尾分隔符、小写);无 cwd → [_unknownKey]。
/// - label = cwd 末段(项目名);无 cwd → 「未知项目」。
/// - 组内按 `lastAt` 降序;组间按组内最新 `lastAt` 降序(最活跃的项目排最前)。
///
/// 手机端小屏,所以组头可折叠(默认展开),折叠态只记在内存里(不持久化:每次进页
/// 都要看到最近在干什么,而不是上次留下的空列表)。
class SessionsPage extends StatefulWidget {
  final RelayClient client;
  const SessionsPage({super.key, required this.client});

  @override
  State<SessionsPage> createState() => _SessionsPageState();
}

/// 未知项目分组 key(cwd 缺失的会话归此组)。
const _unknownKey = "__unknown_project__";

class _SessionGroup {
  final String key;
  final String? cwd;
  final String label;
  final List<SessionItem> sessions;
  _SessionGroup({required this.key, required this.cwd, required this.label, required this.sessions});

  /// 组内最新活动时间(组间排序依据)。
  String get latest => sessions.isEmpty ? "" : (sessions.first.lastAt ?? "");
}

/// cwd 规范化比较(去 verbatim 前缀 + 去尾分隔符 + 小写),与桌面端 `normalizeCwdForCompare` 同口径。
String _cwdKey(String? cwd) {
  final s = (cwd ?? "").trim();
  if (s.isEmpty) return _unknownKey;
  var v = s;
  if (v.length >= 4 && (v.startsWith(r"\\?\") || v.startsWith(r"\\.\"))) v = v.substring(4);
  v = v.replaceAll(RegExp(r"[\\/]+$"), "");
  return v.toLowerCase();
}

/// 取路径末段作项目名(Windows `\` / POSIX `/` 都兼容)。
String _pathBasename(String value) {
  final normalized = value.trim().replaceAll(RegExp(r"[\\/]+$"), "");
  final parts = normalized.split(RegExp(r"[\\/]")).where((p) => p.isNotEmpty).toList();
  return parts.isEmpty ? value.trim() : parts.last;
}

class _SessionsPageState extends State<SessionsPage> {
  String _kind = "claude";
  List<SessionItem>? _items;
  String? _error;
  /// 折叠的分组 key(仅内存态)。
  final Set<String> _collapsed = {};
  /// 上滑分页:渲染的分组数(会话多时避免一次铺满长列表;到底 +[_pageStep] 组)。
  static const _pageStep = 15;
  int _shownGroups = _pageStep;
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _loadCached();
    _load();
    _scroll.addListener(() {
      if (_scroll.position.pixels >= _scroll.position.maxScrollExtent - 120) {
        // 到底(或接近)时追加下一页;铺满前 maxScrollExtent 为 0 不会触发。
        final total = _items == null ? 0 : _group(_items!).length;
        if (_shownGroups < total && mounted) {
          setState(() => _shownGroups += _pageStep);
        }
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _loadCached() async {
    final cached = await PageCache.readList("sessions.$_kind");
    if (cached != null && mounted && _items == null) {
      setState(() => _items = [for (final e in cached) SessionItem.fromJson(e)]);
    }
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final resp = await widget.client.request("sessions.list", {"kind": _kind});
      final raw = resp["result"] as List<dynamic>;
      final list = raw.map((e) => SessionItem.fromJson(e)).toList();
      await PageCache.write("sessions.$_kind", raw);
      if (mounted) setState(() { _items = list; _shownGroups = _pageStep; });
    } catch (e) {
      if (mounted && _items == null) setState(() => _error = "加载失败(电脑需在线):$e");
    }
  }

  /// 分组 + 排序(每次 build 重算:数据量是「会话数」量级,几十到几百条,无需缓存)。
  List<_SessionGroup> _group(List<SessionItem> items) {
    final map = <String, _SessionGroup>{};
    for (final it in items) {
      final key = _cwdKey(it.cwd);
      final group = map.putIfAbsent(key, () {
        final cwd = (it.cwd ?? "").trim();
        return _SessionGroup(
          key: key,
          cwd: cwd.isEmpty ? null : cwd,
          label: cwd.isEmpty ? "未知项目" : _pathBasename(cwd),
          sessions: [],
        );
      });
      group.sessions.add(it);
    }
    final groups = map.values.toList();
    for (final g in groups) {
      // 组内倒序:最近活动在前(后端已排序,这里双保险)。
      g.sessions.sort((a, b) => (b.lastAt ?? "").compareTo(a.lastAt ?? ""));
    }
    // 组间倒序:按组内最新活动;无时间的组沉底。
    groups.sort((a, b) {
      final al = a.latest, bl = b.latest;
      if (al.isEmpty && bl.isEmpty) return a.label.compareTo(b.label);
      if (al.isEmpty) return 1;
      if (bl.isEmpty) return -1;
      return bl.compareTo(al);
    });
    return groups;
  }

  String _fmtTime(String? iso) {
    if (iso == null) return "—";
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return iso.length > 16 ? iso.substring(0, 16) : iso;
    final now = DateTime.now();
    final diff = now.difference(dt);
    // 时钟偏差/未来时间戳(桌面端与本机不同步)→ 按「刚刚」处理,别显示负数。
    if (diff.isNegative) return "刚刚";
    if (diff.inMinutes < 60) return "${diff.inMinutes} 分钟前";
    if (diff.inHours < 24) return "${diff.inHours} 小时前";
    if (diff.inDays < 30) return "${diff.inDays} 天前";
    return "${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')}";
  }

  /// 项目路径缩略:前 3 段 + `…`(小屏放不下完整路径)。
  static String _pathShort(String p) {
    final parts = p.replaceAll("\\", "/").split("/").where((s) => s.isNotEmpty).toList();
    if (parts.isEmpty) return p;
    return parts.take(3).join("/") + (parts.length > 3 ? "/…" : "");
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    final all = items == null ? const <_SessionGroup>[] : _group(items);
    final groups = all.take(_shownGroups).toList();
    return Column(children: [
      // claude/codex 分段。
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
        child: SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: "claude", label: Text("Claude"), icon: Icon(Icons.auto_awesome, size: 14)),
            ButtonSegment(value: "codex", label: Text("Codex"), icon: Icon(Icons.terminal, size: 14)),
          ],
          selected: {_kind},
          onSelectionChanged: (s) {
            setState(() { _kind = s.first; _items = null; _collapsed.clear(); _shownGroups = _pageStep; });
            _loadCached();
            _load();
          },
          showSelectedIcon: false,
          style: ButtonStyle(visualDensity: VisualDensity.compact, textStyle: const WidgetStatePropertyAll(TextStyle(fontSize: 12))),
        ),
      ),
      Expanded(child: RefreshIndicator(onRefresh: _load, child: ListView(controller: _scroll, children: [
        if (_error != null)
          Padding(padding: const EdgeInsets.all(24), child: Center(child: Text(_error!, style: const TextStyle(color: Mx.muted, fontSize: 13)))),
        for (final g in groups) ...[
          _groupHeader(g),
          if (!_collapsed.contains(g.key))
            for (final s in g.sessions) _sessionCard(s),
        ],
        if (items != null && items.isEmpty)
          const Padding(padding: EdgeInsets.all(24), child: Center(child: Text("无会话", style: TextStyle(color: Mx.muted)))),
        if (_shownGroups < all.length)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 10),
            child: Center(
              child: Text("上滑加载更多(${all.length - _shownGroups} 组未展开)",
                  style: const TextStyle(fontSize: 11, color: Mx.faint)),
            ),
          ),
      ]))),
    ]);
  }

  /// 组头:项目名 + 会话数 + 折叠箭头 + 路径提示。
  Widget _groupHeader(_SessionGroup g) {
    final collapsed = _collapsed.contains(g.key);
    return InkWell(
      onTap: () => setState(() {
        if (collapsed) {
          _collapsed.remove(g.key);
        } else {
          _collapsed.add(g.key);
        }
      }),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
        child: Row(children: [
          Icon(collapsed ? Icons.chevron_right : Icons.expand_more, size: 16, color: Mx.faint),
          const SizedBox(width: 4),
          Flexible(
            child: Text(
              g.label,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: Mx.textBright),
            ),
          ),
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(
              color: Mx.cardInner,
              borderRadius: BorderRadius.circular(4),
              border: Border.all(color: Mx.borderSoft),
            ),
            child: Text("${g.sessions.length}",
                style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.w600, color: Mx.muted)),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              g.cwd == null ? "" : _pathShort(g.cwd!),
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 10, color: Mx.faint),
            ),
          ),
        ]),
      ),
    );
  }

  Widget _sessionCard(SessionItem s) {
    return Card(child: ListTile(
      dense: true,
      leading: Container(
        width: 34, height: 34,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          // claude = 品牌紫,codex = 信息蓝(与桌面端 provider 标识一致)。
          color: s.providerId == "claude" ? Mx.violetSoft : Mx.infoSoft,
          borderRadius: BorderRadius.circular(Mx.radiusMd),
          border: Border.all(color: s.providerId == "claude" ? Mx.violetBorder : Mx.border),
        ),
        child: Text(s.providerId == "claude" ? "C" : "X",
            style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold,
                color: s.providerId == "claude" ? Mx.violet : Mx.info)),
      ),
      title: Text(
        s.title ?? "(无标题)",
        maxLines: 1, overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: Mx.textBright),
      ),
      subtitle: Text(
        "${_fmtTime(s.lastAt)} · ${s.messageCount} 条${s.gitBranch != null && s.gitBranch != "HEAD" ? " · ${s.gitBranch}" : ""}",
        style: const TextStyle(fontSize: 11, color: Mx.muted),
      ),
      trailing: Text(_fmtTime(s.startedAt), style: const TextStyle(fontSize: 10, color: Mx.faint)),
    ));
  }
}
