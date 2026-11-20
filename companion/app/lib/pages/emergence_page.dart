import 'package:flutter/material.dart';

import '../relay/client.dart';
import '../page_cache.dart';
import '../theme.dart';

/// 涌现页(四期 P4c;2026-11-19 开写口):桌面「涌现」指挥台的镜像 + 远程处置。
///
/// 数据源 `conductor.snapshot`(直读 ConductorState,不走桌面 conductor_snapshot
/// 命令——那带 ack 副作用,手机不动桌面徽标水位)。六区:
/// 会话状态 / Agent 实况 / 涌现流 / 接力计划 / 孵化待投 / 代批流水。
///
/// 写操作(2026-11-19,走 relay `allowRemoteChat` 闸门,与 chat.send 同档):
/// - 发孵化(conductor.inbox.add,带目标即投);
/// - 涌现流卡片 accept/reject(conductor.decision.respond)。
/// **仍只读不写**:权限审批、编排暂停/终止、记忆管理——高危确认必须人在电脑前。
class EmergencePage extends StatefulWidget {
  final RelayClient client;
  /// 是否为当前底部导航 tab:切回时静默刷新。
  final bool active;
  const EmergencePage({super.key, required this.client, required this.active});

  @override
  State<EmergencePage> createState() => _EmergencePageState();
}

class _EmergencePageState extends State<EmergencePage> {
  Map<String, dynamic>? _snap;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _loadCached();
    _load();
  }

  @override
  void didUpdateWidget(EmergencePage old) {
    super.didUpdateWidget(old);
    if (widget.active && !old.active && !_loading) _load();
  }

  Future<void> _loadCached() async {
    final cached = await PageCache.readObject("emergence");
    if (cached != null && mounted && _snap == null) {
      setState(() => _snap = cached);
    }
  }

  Future<void> _load() async {
    setState(() { _error = null; _loading = true; });
    try {
      final resp = await widget.client.request("conductor.snapshot");
      await PageCache.write("emergence", resp["result"]);
      if (mounted) setState(() => _snap = resp["result"]);
    } catch (_) {
      if (_snap != null) return; // SWR:旧数据保留,静默失败
      if (mounted) setState(() => _error = "连接已断开且无缓存");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 远程写帧统一出口:成功刷新快照,失败 SnackBar 带后端原因(闸门关/卡已处理等)。
  Future<void> _act(String method, Map<String, dynamic> params, String okText) async {
    try {
      await widget.client.request(method, params);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(okText), duration: const Duration(seconds: 2),
      ));
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(_errText(e)), duration: const Duration(seconds: 3),
      ));
    }
  }

  /// RelayApiException.toString 直出桌面端人话;StateError/TimeoutException 剥前缀。
  static String _errText(Object e) {
    final raw = e is RelayApiException ? e.message : e.toString();
    final s = raw.replaceFirst(RegExp(r'^(Bad state|TimeoutException|Exception)[^:]*: '), '');
    return s.isEmpty ? "操作失败" : (s.length > 120 ? "${s.substring(0, 120)}…" : s);
  }

  void _showAddSheet() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _AddInboxSheet(
        sessions: (_snap?["sessions"] as List? ?? []).cast<Map<String, dynamic>>(),
        onSubmit: (text, acceptance, targets) async {
          Navigator.of(ctx).pop();
          await _act("conductor.inbox.add", {
            "text": text,
            "acceptance": ?acceptance,
            "targets": [for (final t in targets) {"projectId": t.$1, "tabId": t.$2}],
          }, targets.isEmpty ? "已存入驿站(回桌面投递)" : "已投递孵化");
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final snap = _snap;
    return Scaffold(
      appBar: AppBar(
        title: const Text("涌现"),
        actions: [
          IconButton(
            onPressed: () => _showAddSheet(),
            tooltip: "发孵化",
            icon: const Icon(Icons.add_task, size: 19),
          ),
          IconButton(
            onPressed: _loading ? null : _load,
            icon: _loading
                ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh, size: 18),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(12),
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(_error!, style: const TextStyle(fontSize: 12, color: Mx.warning)),
              ),
            if (snap == null && _error == null)
              const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
            if (snap != null) ...[
              _SessionsSection(snap),
              const SizedBox(height: 12),
              _BeatsSection(snap),
              const SizedBox(height: 12),
              _DecisionsSection(snap, onAct: (id, action) =>
                  _act("conductor.decision.respond", {"id": id, "action": action}, action == "accept" ? "已采纳并发送" : "已拒绝")),
              const SizedBox(height: 12),
              _PlansSection(snap),
              const SizedBox(height: 12),
              _InboxSection(snap, onAdd: _showAddSheet, onRequeue: (id, targets) =>
                  _act("conductor.inbox.dispatch", {"id": id, "targets": targets}, "已投递")),
              const SizedBox(height: 12),
              _ApprovalsSection(snap),
            ],
          ],
        ),
      ),
    );
  }
}

/// 会话语义态点色(与桌面 PLAN/STEP 色系对齐的降档版:waiting 琥珀/finished 绿/error 红)。
(Color, String) _kindVisual(String kind) {
  return switch (kind) {
    "waiting_approval" => (Mx.warning, "等审批"),
    "finished" => (Mx.success, "已完成"),
    "error" => (Mx.danger, "异常"),
    "running" => (Mx.accent, "运行中"),
    "idle" => (Mx.muted, "空闲"),
    _ => (Mx.muted, kind),
  };
}

/// 会话色签(与桌面 StagePanel 同款 8 色板 + hash):一群会话一眼分得清。
const _sessionColors = [
  Color(0xFFE11D48), Color(0xFFF59E0B), Color(0xFF10B981), Color(0xFF3B82F6),
  Color(0xFF8B5CF6), Color(0xFF06B6D4), Color(0xFFEC4899), Color(0xFF84CC16),
];

Color _sessionColor(String key) {
  var h = 0;
  for (var i = 0; i < key.length; i++) {
    h = (h * 31 + key.codeUnitAt(i)) & 0x7FFFFFFF;
  }
  return _sessionColors[h % _sessionColors.length];
}

/// 工具分色(与桌面 StagePanel 同口径:读青/写金/执行紫/派生绿)。
Color _toolColor(String tool) {
  final t = tool.toLowerCase();
  // 注:helper 不能叫 is——保留字(类型测试运算符),解析器会把 `bool is(...)` 当类型判断。
  bool eq(String n) => t == n;
  if (eq("read") || eq("grep") || eq("glob") || eq("todoread") || eq("todowrite") ||
      eq("websearch") || eq("webfetch") || eq("list")) {
    return const Color(0xFF0891B2);
  }
  if (eq("edit") || eq("write") || eq("multiedit") || eq("notebookedit")) {
    return Mx.accentBright;
  }
  if (eq("bash") || eq("shell") || eq("powershell") || t.startsWith("mcp:")) {
    return const Color(0xFF7C3AED);
  }
  if (eq("task") || eq("agent") || eq("dispatch")) {
    return const Color(0xFF059669);
  }
  return Mx.muted;
}

/// 相对时间(刚刚 / N 分钟前 / N 小时前)。
String _relTime(num ms) {
  final diff = DateTime.now().millisecondsSinceEpoch - ms;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return "${diff ~/ 60000}分钟前";
  if (diff < 86400000) return "${diff ~/ 3600000}小时前";
  return "${diff ~/ 86400000}天前";
}

class _SessionsSection extends StatelessWidget {
  final Map<String, dynamic> snap;
  const _SessionsSection(this.snap);

  @override
  Widget build(BuildContext context) {
    final sessions = (snap["sessions"] as List? ?? []).cast<Map<String, dynamic>>();
    if (sessions.isEmpty) {
      return _card("会话", [const Padding(
        padding: EdgeInsets.symmetric(vertical: 14),
        child: Center(child: Text("暂无活跃会话", style: TextStyle(fontSize: 12, color: Mx.muted))),
      )]);
    }
    return _card("会话(${sessions.length})", [
      for (final s in sessions) _sessionRow(s),
    ]);
  }

  Widget _sessionRow(Map<String, dynamic> s) {
    final (color, label) = _kindVisual((s["kind"] ?? "").toString());
    final detail = s["detail"]?.toString();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(children: [
        Container(width: 8, height: 8, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
        const SizedBox(width: 8),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(
              "${s["projectName"] ?? ""} · ${s["tabTitle"] ?? s["tabId"] ?? ""}",
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
            if (detail != null && detail.isNotEmpty)
              Text(detail, maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Mx.muted)),
          ]),
        ),
        Text(label, style: TextStyle(fontSize: 11, color: color)),
      ]),
    );
  }
}

/// Agent 实况(2026-11-19,与桌面 StagePanel 同源):每次工具调用一拍——会话色签 +
/// 工具名(分色)+ 目标摘要,新的在前。
class _BeatsSection extends StatelessWidget {
  final Map<String, dynamic> snap;
  const _BeatsSection(this.snap);

  @override
  Widget build(BuildContext context) {
    final beats = (snap["toolBeats"] as List? ?? []).cast<Map<String, dynamic>>();
    if (beats.isEmpty) return const SizedBox.shrink();
    return _card("实况(最近 ${beats.length >= 20 ? 20 : beats.length})", [
      for (final b in beats.take(20))
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(children: [
            Container(
              width: 7, height: 7,
              decoration: BoxDecoration(
                color: _sessionColor("${b["projectId"]}/${b["tabId"]}"),
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              width: 64,
              child: Text((b["tool"] ?? "").toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _toolColor((b["tool"] ?? "").toString()))),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text((b["summary"] ?? "").toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Mx.muted)),
            ),
            Text(_relTime(b["ms"] as num), style: const TextStyle(fontSize: 10, color: Mx.faint)),
          ]),
        ),
    ]);
  }
}

/// 决策卡 kind 徽标。
(String, Color) _decisionKindVisual(String kind) {
  return switch (kind) {
    "suggestion" => ("建议", Mx.accentBright),
    "dispatch" => ("派活", const Color(0xFF3B82F6)),
    "ask_human" => ("提问", Mx.violet),
    "memory_candidate" => ("记忆", const Color(0xFF10B981)),
    "verdict" => ("验收", const Color(0xFF0891B2)),
    _ => (kind, Mx.muted),
  };
}

/// 涌现流(2026-11-19):决策卡镜像 + proposed 卡远程处置(采纳=发送到目标会话 /
/// 拒绝=纯标记;edit/ack 回桌面)。proposed 优先展示,其余留观最近几张。
class _DecisionsSection extends StatelessWidget {
  final Map<String, dynamic> snap;
  final void Function(String id, String action) onAct;
  const _DecisionsSection(this.snap, {required this.onAct});

  @override
  Widget build(BuildContext context) {
    final all = (snap["decisions"] as List? ?? []).cast<Map<String, dynamic>>();
    if (all.isEmpty) return const SizedBox.shrink();
    final proposed = all.where((d) => d["status"] == "proposed").toList();
    final handled = all.where((d) => d["status"] != "proposed").take(5);
    final items = [...proposed, ...handled];
    return _card("涌现流${proposed.isEmpty ? "" : "(${proposed.length} 待决)"}", [
      for (final d in items) _decisionRow(context, d),
    ]);
  }

  Widget _decisionRow(BuildContext context, Map<String, dynamic> d) {
    final (kindLabel, kindColor) = _decisionKindVisual((d["kind"] ?? "").toString());
    final isProposed = d["status"] == "proposed";
    final payload = (d["payload"] as Map<String, dynamic>?) ?? {};
    // verdict 卡的判定着色(success 绿/failed 红/rework 琥珀)。
    Color? verdictColor(String? v) => switch (v) {
      "success" => Mx.success,
      "failed" => Mx.danger,
      "rework" => Mx.warning,
      _ => null,
    };
    final vc = d["kind"] == "verdict" ? verdictColor(payload["verdict"]?.toString()) : null;
    final badgeColor = vc ?? (isProposed ? kindColor : Mx.muted);
    final hasTarget = (d["targetProjectId"] ?? "").toString().isNotEmpty && (d["targetSessionId"] ?? "").toString().isNotEmpty;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
            decoration: BoxDecoration(color: badgeColor.withValues(alpha: 0.13), borderRadius: BorderRadius.circular(4)),
            child: Text(
              d["kind"] == "verdict" ? "验收·${payload["verdict"] ?? "?"}" : kindLabel,
              style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: badgeColor),
            ),
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text((d["summary"] ?? "").toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          ),
          Text(_relTime(d["createdMs"] as num), style: const TextStyle(fontSize: 10, color: Mx.faint)),
        ]),
        const SizedBox(height: 4),
        Text((d["text"] ?? "").toString(), maxLines: 2, overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: Mx.muted, height: 1.35)),
        if (isProposed && hasTarget && (d["kind"] == "suggestion" || d["kind"] == "dispatch")) ...[
          const SizedBox(height: 6),
          Row(children: [
            _miniBtn("采纳发送", Mx.accentBright, Mx.accentContrast, () => onAct(d["id"].toString(), "accept")),
            const SizedBox(width: 8),
            _miniBtn("拒绝", Mx.muted, Colors.white, () => onAct(d["id"].toString(), "reject")),
          ]),
        ] else if (!isProposed)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              switch (d["status"]?.toString()) {
                "accepted" => "已采纳", "rejected" => "已拒绝", "expired" => "已过期", _ => "",
              },
              style: const TextStyle(fontSize: 10, color: Mx.faint),
            ),
          ),
      ]),
    );
  }

  Widget _miniBtn(String label, Color bg, Color fg, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(5)),
        child: Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: fg)),
      ),
    );
  }
}

/// 接力计划进度条:done/total + 状态色。
(Color, String) _planVisual(String status) {
  return switch (status) {
    "running" => (Mx.accent, "接力中"),
    "paused" => (Mx.warning, "已暂停"),
    "halted" => (Mx.danger, "已停止"),
    "finished" => (Mx.success, "已完成"),
    _ => (Mx.muted, status),
  };
}

class _PlansSection extends StatelessWidget {
  final Map<String, dynamic> snap;
  const _PlansSection(this.snap);

  @override
  Widget build(BuildContext context) {
    final plans = (snap["plans"] as List? ?? []).cast<Map<String, dynamic>>();
    if (plans.isEmpty) return const SizedBox.shrink();
    return _card("接力(${plans.length})", [
      for (final p in plans.take(5)) _planRow(p),
    ]);
  }

  Widget _planRow(Map<String, dynamic> p) {
    final steps = (p["steps"] as List? ?? []).cast<Map<String, dynamic>>();
    final done = steps.where((s) => s["status"] == "done").length;
    final (color, label) = _planVisual((p["status"] ?? "").toString());
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Text((p["goal"] ?? "").toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ),
          Text("$label $done/${steps.length}", style: TextStyle(fontSize: 11, color: color)),
        ]),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(3),
          child: LinearProgressIndicator(
            value: steps.isEmpty ? 0 : done / steps.length,
            minHeight: 4,
            backgroundColor: Mx.border,
            valueColor: AlwaysStoppedAnimation(color),
          ),
        ),
      ]),
    );
  }
}

class _InboxSection extends StatelessWidget {
  final Map<String, dynamic> snap;
  final VoidCallback onAdd;
  final void Function(String id, List<Map<String, dynamic>> targets) onRequeue;
  const _InboxSection(this.snap, {required this.onAdd, required this.onRequeue});

  @override
  Widget build(BuildContext context) {
    // 待投 + 排队(投递被占用全拦、等会话空闲自动补投)都露出,行尾区分。
    final items = (snap["inbox"] as List? ?? []).cast<Map<String, dynamic>>()
      ..retainWhere((i) => i["status"] == "pending" || i["status"] == "queued");
    return _card("孵化(${items.length})", [
      Padding(
        padding: const EdgeInsets.only(right: 8),
        child: Align(
          alignment: Alignment.centerRight,
          child: GestureDetector(
            onTap: onAdd,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: Mx.accentSoft, borderRadius: BorderRadius.circular(5)),
              child: const Text("+ 发孵化", style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Mx.accentBright)),
            ),
          ),
        ),
      ),
      if (items.isEmpty)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 6),
          child: Text("暂无待投条目", style: TextStyle(fontSize: 11, color: Mx.muted)),
        ),
      for (final i in items.take(8)) _inboxRow(i),
    ]);
  }

  Widget _inboxRow(Map<String, dynamic> i) {
    final sessions = (snap["sessions"] as List? ?? []).cast<Map<String, dynamic>>();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      child: Row(children: [
        Expanded(
          child: Text((i["text"] ?? "").toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12)),
        ),
        if (i["status"] == "queued")
          const Text("排队中", style: TextStyle(fontSize: 11, color: Color(0xFF3B82F6)))
        else ...[
          Text("→${i["targetCount"] ?? 0}", style: const TextStyle(fontSize: 11, color: Mx.muted)),
          // 待投条目快捷重投:目标取当前活跃会话(桌面存的 targets 快照里没带,
          // 活跃口径与驿站「选会话」一致;无活跃会话时置灰)。
          const SizedBox(width: 8),
          GestureDetector(
            onTap: sessions.isEmpty ? null : () => onRequeue(
              i["id"].toString(),
              [for (final s in sessions.take(4)) {"projectId": s["projectId"], "tabId": s["tabId"]}],
            ),
            child: Text("投递", style: TextStyle(
              fontSize: 11, fontWeight: FontWeight.w600,
              color: sessions.isEmpty ? Mx.faint : Mx.accentBright,
            )),
          ),
        ],
      ]),
    );
  }
}

class _ApprovalsSection extends StatelessWidget {
  final Map<String, dynamic> snap;
  const _ApprovalsSection(this.snap);

  @override
  Widget build(BuildContext context) {
    final approvals = (snap["autoApprovals"] as List? ?? []).cast<Map<String, dynamic>>();
    if (approvals.isEmpty) return const SizedBox.shrink();
    Color levelColor(String? level) => switch (level) {
      "deny" => Mx.danger,
      "confirm" => Mx.warning,
      _ => Mx.success,
    };
    return _card("代批流水(最近 ${approvals.length})", [
      for (final a in approvals.take(10))
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          child: Row(children: [
            Container(width: 6, height: 6, decoration: BoxDecoration(color: levelColor(a["level"]?.toString()), shape: BoxShape.circle)),
            const SizedBox(width: 8),
            Text((a["toolName"] ?? "").toString(), style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
            const SizedBox(width: 6),
            Expanded(
              child: Text((a["summary"] ?? "").toString(), maxLines: 1, overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Mx.muted)),
            ),
          ]),
        ),
    ]);
  }
}

/// 发孵化 bottom sheet:任务文本 + 可选验收标准 + 目标多选(活跃会话 chips)。
/// 无目标 = 仅存入(回桌面投);有目标 = 存入即投。
class _AddInboxSheet extends StatefulWidget {
  final List<Map<String, dynamic>> sessions;
  final Future<void> Function(String text, String? acceptance, List<(String, String)> targets) onSubmit;
  const _AddInboxSheet({required this.sessions, required this.onSubmit});

  @override
  State<_AddInboxSheet> createState() => _AddInboxSheetState();
}

class _AddInboxSheetState extends State<_AddInboxSheet> {
  final _textCtrl = TextEditingController();
  final _acceptCtrl = TextEditingController();
  final _selected = <String>{};

  @override
  void initState() {
    super.initState();
    // 输入为空时按钮置灰;controller 变化要触发重建才生效。
    _textCtrl.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _textCtrl.dispose();
    _acceptCtrl.dispose();
    super.dispose();
  }

  void _submit() {
    final text = _textCtrl.text.trim();
    if (text.isEmpty) return;
    final targets = <(String, String)>[];
    for (final key in _selected) {
      final parts = key.split("/");
      if (parts.length == 2) targets.add((parts[0], parts[1]));
    }
    final acceptance = _acceptCtrl.text.trim().isEmpty ? null : _acceptCtrl.text.trim();
    widget.onSubmit(text, acceptance, targets);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(
        left: 16, right: 16, top: 16,
        bottom: MediaQuery.of(context).viewInsets.bottom + 16,
      ),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text("发孵化", style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        TextField(
          controller: _textCtrl,
          maxLines: 3, minLines: 2,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: "要 AI 做什么…(存入驿站孵化,选了目标则立即投递)",
            isDense: true, border: OutlineInputBorder(),
          ),
          style: const TextStyle(fontSize: 13),
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _acceptCtrl,
          decoration: const InputDecoration(
            hintText: "验收标准(可选):做到什么才算完成",
            isDense: true, border: OutlineInputBorder(),
          ),
          style: const TextStyle(fontSize: 12.5),
        ),
        const SizedBox(height: 10),
        Text("目标${_selected.isEmpty ? "(不选 = 仅存入)" : "(已选 ${_selected.length})"}",
            style: const TextStyle(fontSize: 11, color: Mx.muted)),
        const SizedBox(height: 6),
        if (widget.sessions.isEmpty)
          const Text("无活跃会话:仅能存入,回桌面投递", style: TextStyle(fontSize: 11, color: Mx.faint))
        else
          Wrap(
            spacing: 6, runSpacing: 6,
            children: [
              for (final s in widget.sessions.take(8))
                FilterChip(
                  label: Text("${s["projectName"] ?? ""}·${s["tabTitle"] ?? s["tabId"]}",
                      style: const TextStyle(fontSize: 11)),
                  selected: _selected.contains("${s["projectId"]}/${s["tabId"]}"),
                  onSelected: (v) => setState(() {
                    final key = "${s["projectId"]}/${s["tabId"]}";
                    v ? _selected.add(key) : _selected.remove(key);
                  }),
                ),
            ],
          ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: _textCtrl.text.trim().isEmpty ? null : _submit,
            style: FilledButton.styleFrom(
              backgroundColor: Mx.accent, foregroundColor: Mx.accentContrast,
            ),
            child: Text(_selected.isEmpty ? "存入驿站" : "投递($_selected)",
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          ),
        ),
      ]),
    );
  }
}

Widget _card(String title, List<Widget> children) {
  return Container(
    decoration: BoxDecoration(
      color: Mx.card,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(color: Mx.border),
    ),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
        child: Text(title, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
      ),
      ...children,
    ]),
  );
}
