import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../chat/stream.dart';
import '../models.dart';
import '../page_cache.dart';
import '../relay/client.dart';
import '../theme.dart';

/// 对话页:一个 AI tab 的完整对话视图(与桌面端同一会话,桌面是唯一真源)。
///
/// 数据来源两条:
/// - `chat.history`:进页回填(claude 与实时事件同构,同一套归并);
/// - `chat.event` 推送:流式增量。
/// 发送走 `chat.send`,运行中点停止发 `chat.interrupt`,审批卡回 `chat.permission`。
class ChatPage extends StatefulWidget {
  final RelayClient client;
  final String projectId;
  final String projectName;
  final String tabId;
  final String tabTitle;
  final String paneLabel;
  const ChatPage({
    super.key,
    required this.client,
    required this.projectId,
    required this.projectName,
    required this.tabId,
    required this.tabTitle,
    required this.paneLabel,
  });

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  final _messageListKey = GlobalKey();
  final _currentPromptKey = GlobalKey();
  final _stream = ChatStream();
  StreamSubscription<Map<String, dynamic>>? _sub;
  StreamSubscription<RelayConnState>? _connSub;

  /// 断线期间错过的事件无法重放:恢复在线后必须重拉 status + history 补齐。
  bool _wasOffline = false;

  /// 轻量轮询。两个作用:
  /// 1. **重新登记推送对象**——桌面端把「收 `chat.event` 的手机」按它这次中继连接维护,
  ///    桌面端一重连(或重启)名单就空了,手机 socket 没断也收不到推送;发一条请求即重新登记。
  /// 2. 兜底漏收的 `result`(轮次结束后按钮不会永远停在「停止」)。
  Timer? _poll;

  String? _error;
  bool _loading = true;
  bool _sending = false;
  String _provider = "claude";

  /// —— 快捷指令面板数据(按 tab 缓存)——
  ///
  /// 2026-11-05 用户定调:点 ⌘ 先弹面板再加载(原来 await 整个公网 round-trip 才弹,
  /// 体感「非常慢」)。chat.models 后台拉,到了 setState 刷新(面板是 showModalBottomSheet
  /// 的 builder,吃同一个 state)。数据按 tabId 缓存重启可用;切换供应商后重进面板即见新表。
  /// 只缓「可选清单」,「当前模型/推理档」仍以 chat.status 实时值为准。
  final Map<String, List<Map<String, dynamic>>> _modelsCache = {};
  final Map<String, List<Map<String, dynamic>>> _groupsCache = {};

  /// —— 快捷指令状态 ——
  ///
  /// claude 的 model/effort 是**启动 flag**,改它就是重启进程,所以后端 `chat.command`
  /// 立刻生效、状态由 `chat.status` 回读。
  /// codex 每轮短命 `codex exec`,model/reasoning 是**每轮参数**:这里记着用户的选择,
  /// 下次 `chat.send` 一起带上(不打断当前轮,也不需要重启)。
  String? _modelOverride;
  /// `null` = 还没选过(允许被 `chat.status` 回填);`""` = 用户显式选了「auto」
  /// (不传 `model_reasoning_effort`,让 config.toml 决定);其余为具体档位。
  /// 用空串做哨兵是因为「没选过」和「选了 auto」在 `chat.status` 回填后无法区分。
  String? _reasoningOverride;
  /// codex 权限档/沙箱档(每轮参数,随 `chat.send` 带;app-server per-turn override
  /// 下一轮即生效,无需重启)。`null` = 还没选过(允许被 `chat.status` 回填——后端
  /// 回的是最近一轮实际用的值)。权限四档与沙箱三档联动归档,语义与桌面 CodexPane
  /// 状态栏一致(setSandboxMode 的推导规则)。
  String? _codexPermission;
  String? _codexSandbox;
  /// claude 权限模式(`--permission-mode` 启动 flag)。`null` = 还没选过(允许被
  /// `chat.status` 回填——后端回的是启动时的值);切换走 `chat.command` mode(重启进程)。
  String? _claudeMode;
  /// 「新会话」:置一次,随下一条 send 传 `newSession=true` 后清掉(等价桌面 `newSession()`)。
  bool _newSessionNext = false;
  bool _currentPromptHidden = false;
  bool _currentPromptExpanded = false;
  String? _currentPromptId;

  /// 当前问题横幅单行判定缓存(key = 可用宽度 + 文本,流式 rebuild 时免重复排版)。
  String? _promptOneLineKey;
  bool _promptOneLine = false;

  /// 当前问题收起态单行是否放得下(放得下就不显示展开箭头,与桌面端同口径)。
  /// 按横幅内文本区可用宽度用 TextPainter 排版一次:横幅宽 = Stack 宽 - 24(Positioned
  /// left/right 12),扣掉内边距 22、左图标 13 + 间距 7;箭头隐藏时文本反而更宽,
  /// 所以按「无箭头」口径测,自洽。
  bool _promptFitsOneLine(String text) {
    final avail = MediaQuery.of(context).size.width - 24 - 22 - 13 - 7;
    final key = "$avail\u0000$text";
    if (_promptOneLineKey == key) return _promptOneLine;
    final tp = TextPainter(
      text: TextSpan(text: text, style: const TextStyle(fontSize: 12, color: Mx.text)),
      textDirection: TextDirection.ltr,
      maxLines: 1,
    );
    tp.layout(maxWidth: avail);
    _promptOneLine = !tp.didExceedMaxLines;
    _promptOneLineKey = key;
    tp.dispose();
    return _promptOneLine;
  }

  /// 生效的 codex 推理档位:`auto` 表示下一轮不传 `model_reasoning_effort`。
  String get _effectiveReasoning =>
      (_reasoningOverride == null || _reasoningOverride!.isEmpty) ? "auto" : _reasoningOverride!;

  /// 是否有一轮在跑(按钮显示「停止」)。只看 `_stream.status`:它就是服务端现况
  /// (进页/重连时由 `chat.status` 校准,之后由流式事件推进),不必再存一份快照。
  /// `compacting` 也算忙——桌面端 compact 期间不接受新消息。
  bool get _busy =>
      _stream.status == "running" || _stream.status == "thinking" || _stream.status == "compacting";

  @override
  void initState() {
    super.initState();
    _rememberLast();
    _scroll.addListener(_scheduleCurrentPromptCheck);
    _sub = widget.client.events.listen(_onEvent);
    _connSub = widget.client.stateStream.listen(_onConn);
    _poll = Timer.periodic(const Duration(seconds: 8), (_) {
      if (!mounted || widget.client.state != RelayConnState.online) return;
      _refreshStatus(quiet: true);
    });
    _bootstrap();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _sub?.cancel();
    _connSub?.cancel();
    _scroll.removeListener(_scheduleCurrentPromptCheck);
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  ChatMessage? get _currentPromptMessage {
    for (final m in _stream.messages.reversed) {
      if (m.role != "user") continue;
      final text = m.blocks
          .where((b) => b.type == "text" && b.text.trim().isNotEmpty)
          .map((b) => b.text.trim())
          .join("\n");
      if (text.isNotEmpty) return m;
    }
    return null;
  }

  void _scheduleCurrentPromptCheck() {
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateCurrentPromptOverlay());
  }

  void _updateCurrentPromptOverlay() {
    if (!mounted) return;
    final prompt = _currentPromptMessage;
    var hidden = false;
    if (prompt != null) {
      final promptContext = _currentPromptKey.currentContext;
      final listContext = _messageListKey.currentContext;
      final promptObject = promptContext?.findRenderObject();
      final listObject = listContext?.findRenderObject();
      if (promptContext == null ||
          listContext == null ||
          promptObject is! RenderBox ||
          listObject is! RenderBox) {
        // reverse ListView 懒加载:当前问题被裁剪时同样视为离开视口。
        hidden = true;
      } else {
        final top = promptObject.localToGlobal(Offset.zero, ancestor: listObject).dy;
        final bottom = top + promptObject.size.height;
        hidden = bottom <= 12 || top >= listObject.size.height - 12;
      }
    }
    final changed =
        hidden != _currentPromptHidden || _currentPromptId != (prompt?.id ?? "");
    if (!changed) return;
    setState(() {
      _currentPromptHidden = hidden;
      if (_currentPromptId != (prompt?.id ?? "")) _currentPromptExpanded = false;
      _currentPromptId = prompt?.id ?? "";
    });
  }

  /// 断线期间桌面端可能已经跑完一轮(甚至需要审批):重连后重拉 status + 历史。
  void _onConn(RelayConnState s) {
    if (s == RelayConnState.online) {
      if (!_wasOffline) return;
      _wasOffline = false;
      _bootstrap();
    } else {
      _wasOffline = true;
    }
  }

  /// 记住「上次进入的对话」(项目卡片的一键续聊用)。
  Future<void> _rememberLast() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString("lastChat", "${widget.projectId}|${widget.tabId}");
    } catch (_) {}
  }

  Future<void> _bootstrap() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    // 开缓冲:拉历史期间到达的实时事件先攒着,历史落地重建后按序重放(见 ChatStream._liveBuffer)。
    _stream.beginBuffering();
    try {
      // 先渲染缓存的历史(SWR:归并是幂等重建,回填覆盖即可),网络到了再替换。
      // 400 条事件可达数 MB,公网 round-trip 秒级——没有缓存每进页都盯 spinner。
      await _loadCachedHistory();
      // 顺序有讲究:**先历史、后状态**。history 里的 `result` 事件会把 status 归到 done,
      // 若先取状态再归并历史,状态就被过期快照盖住了;反过来则是服务端现况最后落地。
      await _loadHistory();
      await _refreshStatus();
    } finally {
      // 缓冲重放要在 setState 外做(applyClaude 改 state,重放后统一刷一次 UI)。
      _stream.replayBuffered();
      if (mounted) setState(() => _loading = false);
    }
  }

  /// 历史缓存 key:按 tab 隔离,读写都是「全量 events/messages」原始 JSON。
  String get _historyCacheKey => "chat.history.${widget.projectId}.${widget.tabId}";

  Future<void> _loadCachedHistory() async {
    try {
      final cached = await PageCache.readObject(_historyCacheKey);
      if (cached == null || !mounted) return;
      _applyHistoryPayload(cached);
    } catch (_) {}
  }

  /// `quiet` = 后台轮询:失败不弹错误条(网络抖一下不该打扰用户,断线本身有横幅)。
  Future<void> _refreshStatus({bool quiet = false}) async {
    try {
      final st = await widget.client.request("chat.status", {
        "projectId": widget.projectId,
        "tabId": widget.tabId,
      });
      final status = ChatStatus.fromJson((st["result"] as Map).cast<String, dynamic>());
      if (!mounted) return;
      setState(() {
        _provider = status.provider;
        _stream.status = status.status;
        _stream.model = status.model ?? _stream.model;
        _stream.effort = status.effort;
        _stream.sessionId = status.sessionId ?? _stream.sessionId;
        // 后台任务快照补齐(实时由 backgroundTasksChanged 事件推,这里覆盖断线期错过)。
        if (status.provider == "claude") {
          _stream.backgroundTasks = status.backgroundTasks;
        }
        // codex:后端只回最近一轮实际用的值;用户尚未在手机端改过就跟着后端走。
        if (status.provider != "claude") {
          if (_modelOverride == null && status.model != null) _modelOverride = status.model;
          if (_reasoningOverride == null && status.reasoningEffort != null) {
            _reasoningOverride = status.reasoningEffort;
          }
          if (_codexPermission == null && status.permission != null) {
            _codexPermission = status.permission;
          }
          if (_codexSandbox == null && status.sandbox != null) {
            _codexSandbox = status.sandbox;
          }
        } else if (_claudeMode == null && status.permissionMode != null) {
          _claudeMode = status.permissionMode;
        }
      });
    } catch (e) {
      if (mounted && !quiet) setState(() => _error = "$e");
    }
  }

  Future<void> _loadHistory() async {
    try {
      final resp = await widget.client.request("chat.history", {
        "projectId": widget.projectId,
        "tabId": widget.tabId,
      });
      final result = (resp["result"] as Map).cast<String, dynamic>();
      // 写缓存失败不影响主流程(裁剪后的 payload,几十~几百 KB)。
      unawaited(PageCache.write(_historyCacheKey, result));
      if (mounted) _applyHistoryPayload(result);
    } catch (e) {
      if (mounted) setState(() => _error = "历史加载失败: $e");
    }
  }

  /// 历史与实时事件同构,同一套归并(缓存与网络回填共用;重复归并幂等)。
  void _applyHistoryPayload(Map<String, dynamic> result) {
    final provider = result["provider"] as String? ?? _provider;
    // 历史是权威真源:每次重载都重建(事件可能已归并过,重复归并幂等)。
    // 但**待审批卡不能丢**——历史里没有 permission_request,清掉的话桌面端那一轮会
    // 一直等审批(手机重连/重载后卡片消失 = 死锁)。所以先存后放。
    final pendingAsks = List<PermissionAsk>.of(_stream.permissions);
    _stream.clear();
    _stream.permissions.addAll(pendingAsks);
    if (provider == "claude") {
      for (final e in (result["events"] as List<dynamic>? ?? const [])) {
        _stream.applyClaude((e as Map).cast<String, dynamic>());
      }
    } else {
      // codex 只有扁平文本历史(role/text/timestamp),逐条转成纯文本消息。
      for (final m in (result["messages"] as List<dynamic>? ?? const [])) {
        final msg = (m as Map).cast<String, dynamic>();
        _stream.appendPlain(
          user: (msg["role"] as String? ?? "") == "user",
          text: msg["text"] as String? ?? "",
        );
      }
    }
    // 状态不在这里定:历史里的 result 事件会把它归成 done,紧接着的 `_refreshStatus`
    // 才是权威现况(见 `_bootstrap` 的顺序说明)。
    if (mounted) setState(() {});
  }

  void _onEvent(Map<String, dynamic> frame) {
    if (frame["ev"] != "chat.event") return;
    final data = (frame["data"] as Map?)?.cast<String, dynamic>();
    if (data == null) return;
    if (data["projectId"] != widget.projectId || data["tabId"] != widget.tabId) return;
    final payload = (data["payload"] as Map?)?.cast<String, dynamic>();
    if (payload == null) return;
    final provider = data["provider"] as String? ?? "claude";
    setState(() {
      // 装载期(拉历史 round-trip 中)事件先进缓冲,历史落地重建后重放,
      // 否则 clear() 会把装载期到达的新消息洗掉(竞态,2026-11-05 用户实测)。
      _stream.applyLive(provider, payload);
    });
    _scrollToBottom();
  }

  void _scrollToBottom() {
    // 倒序 ListView:offset 0 就是「最新一条」。用户上滑看历史时不要强行拉回
    // (只有已经在底部或自己刚发消息时才滚)。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      if (_scroll.offset > 60) return;
      _scroll.jumpTo(0);
    });
  }

  Future<void> _send() async {
    final text = _input.text.trim();
    if (text.isEmpty || _sending) return;
    _input.clear();
    // id 随请求发给桌面端:后端回显 user 事件时带上同一个 id,本机 `_applyUser` 的
    // msgIndex 去重就会把自己这条吞掉(否则手机屏幕上会出现两条同样的提问)。
    final messageId = "local-${DateTime.now().microsecondsSinceEpoch}";
    // codex 的每轮参数:model / reasoning 是进程参数,「新会话」只在下一轮生效一次。
    final sendNewSession = _newSessionNext;
    setState(() {
      _sending = true;
      // 乐观回显(不等后端事件,手机上要立刻看到自己说了什么)。
      _stream.addLocalUser(messageId, text);
      _stream.status = "running";
      if (sendNewSession) _newSessionNext = false;
    });
    _scrollToBottom();
    try {
      await widget.client.request("chat.send", {
        "projectId": widget.projectId,
        "tabId": widget.tabId,
        "text": text,
        "messageId": messageId,
        if (_provider != "claude") ...{
          if (_modelOverride != null) "model": _modelOverride,
          // 空串哨兵 = 显式 auto,不发该参数(后端 `filter(|s| !s.is_empty())` 也会吞掉,
          // 这里少发一次省得两端都靠约定)。
          if (_effectiveReasoning != "auto") "reasoningEffort": _effectiveReasoning,
          // 权限/沙箱:每轮参数(per-turn override),面板里选过就随每轮带上。
          if (_codexPermission != null) "permission": _codexPermission,
          if (_codexSandbox != null) "sandbox": _codexSandbox,
          if (sendNewSession) "newSession": true,
        },
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = "发送失败: $e";
          _stream.status = "idle";
        });
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _stop() async {
    try {
      await widget.client.request("chat.interrupt", {
        "projectId": widget.projectId,
        "tabId": widget.tabId,
      });
    } catch (e) {
      if (mounted) setState(() => _error = "中断失败: $e");
    }
    // 不本地改 status:等后端 `terminated{interrupted}` 或下一次轮询校准,
    // 否则中断失败(例如后端正在启动)时会误显「空闲」而实际还在跑。
  }

  Future<void> _answer(String requestId, bool allow) async {
    final ask = _stream.permissions.firstWhere(
      (a) => a.requestId == requestId,
      orElse: () => PermissionAsk(requestId: "", toolName: "", inputBrief: "", input: const {}),
    );
    // 先本地移除(先答的口生效;另一端收到 result 后卡片也会消失)。
    setState(() => _stream.permissions.removeWhere((a) => a.requestId == requestId));
    try {
      if (_provider == "claude") {
        await widget.client.request("chat.permission", {
          "projectId": widget.projectId,
          "tabId": widget.tabId,
          "requestId": requestId,
          "behavior": allow ? "allow" : "deny",
          // allow 必须带 updatedInput(CLI 认这个形态,spike 实测)。
          if (allow) "updatedInput": ask.input,
          if (!allow) "message": "用户在手机端拒绝了这个操作。",
        });
      } else {
        // codex app-server 实时审批:requestId 即审批帧的 request key;
        // decision 枚举由桌面端按 method 代际分派,手机只给 allow/deny 意图。
        await widget.client.request("chat.codexApproval", {
          "projectId": widget.projectId,
          "tabId": widget.tabId,
          "key": requestId,
          "approved": allow,
        });
      }
    } catch (e) {
      // 回传失败必须把卡片放回去:否则桌面端那一轮永远等不到答复(卡死),
      // 而手机端界面上「已处理」毫无提示。
      if (mounted) {
        setState(() {
          _error = "审批回传失败: $e";
          if (ask.requestId.isNotEmpty &&
              !_stream.permissions.any((a) => a.requestId == ask.requestId)) {
            _stream.permissions.add(ask);
          }
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final online = widget.client.state == RelayConnState.online;
    WidgetsBinding.instance.addPostFrameCallback((_) => _updateCurrentPromptOverlay());
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(widget.tabTitle, overflow: TextOverflow.ellipsis),
            Text(
              "${widget.projectName} · ${widget.paneLabel}",
              style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w400, color: Mx.muted),
            ),
          ],
        ),
        actions: [
          _bgPill(),
          // 会话用量(claude=当前上下文口径每轮覆盖,codex=逐轮累计):从消息底部
          // 挪进 AppBar(2026-10-30 用户「放消息底部太丑」),小字弱化不抢视线。
          _usageLabel(),
          _statusPill(),
          IconButton(
            icon: const Icon(Icons.refresh, size: 18),
            tooltip: "重载历史",
            onPressed: _bootstrap,
          ),
        ],
      ),
      body: Column(
        children: [
          if (_error != null) _errorBar(),
          if (!online)
            Container(
              width: double.infinity,
              color: Mx.warningSoft,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              child: const Row(children: [
                Icon(Icons.cloud_off, size: 13, color: Mx.warning),
                SizedBox(width: 6),
                Expanded(
                  child: Text("连接已断开,正在重连 — 恢复后消息可正常发送",
                      style: TextStyle(fontSize: 11, color: Mx.warning)),
                ),
              ]),
            ),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : Stack(
                    key: _messageListKey,
                    children: [
                      Positioned.fill(child: _messageList()),
                      if (_currentPromptHidden)
                        Builder(builder: (context) {
                          final prompt = _currentPromptMessage;
                          if (prompt == null) return const SizedBox.shrink();
                          return _currentPromptBanner(prompt);
                        }),
                    ],
                  ),
          ),
          _composer(online),
        ],
      ),
    );
  }

  Widget _statusPill() {
    final (color, label) = switch (_stream.status) {
      "running" => (Mx.accentBright, "运行中"),
      "thinking" => (Mx.violet, "思考中"),
      "compacting" => (Mx.warning, "压缩中"),
      "error" => (Mx.danger, "错误"),
      "done" => (Mx.success, "完成"),
      _ => (Mx.faint, "空闲"),
    };
    return Center(
      child: Container(
        margin: const EdgeInsets.only(right: 4),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(
          color: Mx.cardInner,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: Mx.border),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Container(width: 6, height: 6, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 5),
          Text(label, style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: Mx.muted)),
        ]),
      ),
    );
  }

  Widget _errorBar() => Container(
        width: double.infinity,
        color: Mx.dangerSoft,
        padding: const EdgeInsets.fromLTRB(12, 7, 6, 7),
        child: Row(children: [
          const Icon(Icons.error_outline, size: 14, color: Mx.danger),
          const SizedBox(width: 6),
          Expanded(
            child: Text(_error!, maxLines: 2, overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Mx.danger)),
          ),
          TextButton(
            onPressed: () => setState(() => _error = null),
            style: TextButton.styleFrom(
              minimumSize: const Size(0, 28),
              padding: const EdgeInsets.symmetric(horizontal: 8),
            ),
            child: const Text("关闭", style: TextStyle(fontSize: 11)),
          ),
        ]),
      );

  Widget _messageList() {
    final lastIdx = _stream.messages.length - 1;
    final currentPrompt = _currentPromptMessage;
    final n = _stream.messages.length + _stream.permissions.length;
    if (n == 0) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(32),
          child: Text("还没有对话 — 发一句试试", style: TextStyle(fontSize: 13, color: Mx.muted)),
        ),
      );
    }
    // 倒序 ListView + reverse:进入对话页**天然停在最新一条**(正序要把内容全量布局完
    // 才能算出 maxScrollExtent 再跳,长会话首次进来会「先闪到顶再跳到底」)。
    return ListView.builder(
      controller: _scroll,
      reverse: true,
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
      itemCount: n,
      itemBuilder: (context, i) {
        // 倒序索引:i=0 是最底部(最新的)。
        final fromEnd = n - 1 - i;
        if (fromEnd >= _stream.messages.length) {
          return _permissionCard(_stream.permissions[fromEnd - _stream.messages.length]);
        }
        final m = _stream.messages[fromEnd];
        return Column(
          key: currentPrompt?.id == m.id ? _currentPromptKey : null,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _messageBubble(m),
            // 「正在输入」指示挂在最后一条消息下方(整轮未结束就显示——thinking /
            // compacting 同样是在跑,只认 running 会让思考期看起来「卡住了」)。
            if (fromEnd == lastIdx && _busy && m.role == "assistant")
              const _TypingDots(),
          ],
        );
      },
    );
  }

  Widget _currentPromptBanner(ChatMessage message) {
    final text = message.blocks
        .where((b) => b.type == "text" && b.text.trim().isNotEmpty)
        .map((b) => b.text.trim())
        .join("\n");
    // 单行放得下且未展开:没有可展开的内容,不显示箭头。
    final showChevron = _currentPromptExpanded || !_promptFitsOneLine(text);
    return Positioned(
      top: 8,
      left: 12,
      right: 12,
      child: GestureDetector(
        onTap: () => setState(() => _currentPromptExpanded = !_currentPromptExpanded),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
          decoration: BoxDecoration(
            color: Mx.card.withValues(alpha: 0.97),
            borderRadius: BorderRadius.circular(Mx.radiusMd),
            border: Border.all(color: Mx.selectedBorder),
            boxShadow: const [
              BoxShadow(color: Color(0x26000000), blurRadius: 16, offset: Offset(0, 5)),
            ],
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.chat_bubble_outline, size: 13, color: Mx.accentBright),
              const SizedBox(width: 7),
              Expanded(
                child: _currentPromptExpanded
                    ? ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: 220),
                        child: SingleChildScrollView(
                          child: Text(
                            text,
                            style: const TextStyle(fontSize: 12, height: 1.45, color: Mx.text),
                          ),
                        ),
                      )
                    : Text(
                        text,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: Mx.text),
                      ),
              ),
              if (showChevron) ...[
                const SizedBox(width: 6),
                AnimatedRotation(
                  turns: _currentPromptExpanded ? 0.5 : 0,
                  duration: const Duration(milliseconds: 140),
                  child: const Icon(Icons.keyboard_arrow_down, size: 16, color: Mx.muted),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _messageBubble(ChatMessage m) {
    final isUser = m.role == "user";
    final isSystem = m.role == "system";
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.86),
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
        decoration: BoxDecoration(
          color: isUser ? Mx.accentSoft : (isSystem ? Mx.warningSoft : Mx.card),
          borderRadius: BorderRadius.circular(Mx.radiusMd),
          border: Border.all(
            color: isUser ? Mx.selectedBorder : (isSystem ? Mx.warning : Mx.border),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [for (final b in m.blocks) _block(b)],
        ),
      ),
    );
  }

  Widget _block(ChatBlock b) {
    switch (b.type) {
      case "thinking":
        // 思考块折叠(手机屏幕小,正文价值低于占位)。
        return _Collapsible(
          header: const Text("思考", style: TextStyle(fontSize: 11, color: Mx.dim)),
          body: Text(b.text, style: const TextStyle(fontSize: 12, color: Mx.dim, height: 1.45)),
        );
      case "tool":
        return _Collapsible(
          header: Row(mainAxisSize: MainAxisSize.min, children: [
            Text(
              b.toolName ?? "tool",
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: b.isError ? Mx.danger : Mx.accentBright,
              ),
            ),
            const SizedBox(width: 5),
            Flexible(
              child: Text(
                b.text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Mx.muted),
              ),
            ),
            if (b.pending) ...[
              const SizedBox(width: 6),
              const SizedBox(
                width: 9, height: 9,
                child: CircularProgressIndicator(strokeWidth: 1.4, color: Mx.accentBright),
              ),
            ] else if (b.isError) ...[
              const SizedBox(width: 4),
              const Icon(Icons.close, size: 11, color: Mx.danger),
            ] else ...[
              const SizedBox(width: 4),
              const Icon(Icons.check, size: 11, color: Mx.success),
            ],
          ]),
          body: Text(
            (b.result ?? "").trim().isEmpty ? "(无输出)" : b.result!,
            style: const TextStyle(fontSize: 11, height: 1.4, color: Mx.muted, fontFamily: "monospace"),
          ),
        );
      default:
        return Padding(
          padding: const EdgeInsets.only(bottom: 2),
          child: Text(b.text, style: const TextStyle(fontSize: 13, height: 1.5, color: Mx.text)),
        );
    }
  }

  Widget _permissionCard(PermissionAsk ask) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
      decoration: BoxDecoration(
        color: Mx.warningSoft,
        borderRadius: BorderRadius.circular(Mx.radiusMd),
        border: Border.all(color: Mx.warning),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(children: [
            const Icon(Icons.lock_outline, size: 14, color: Mx.warning),
            const SizedBox(width: 5),
            Expanded(
              child: Text("需要授权 · ${ask.toolName}",
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Mx.warning)),
            ),
          ]),
          if (ask.inputBrief.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(ask.inputBrief,
                style: const TextStyle(fontSize: 11, height: 1.4, color: Mx.muted, fontFamily: "monospace")),
          ],
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
              child: OutlinedButton(
                onPressed: () => _answer(ask.requestId, false),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Mx.danger,
                  side: const BorderSide(color: Mx.dangerBorder),
                  minimumSize: const Size(0, 34),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                ),
                child: const Text("拒绝", style: TextStyle(fontSize: 12)),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: FilledButton(
                onPressed: () => _answer(ask.requestId, true),
                style: FilledButton.styleFrom(minimumSize: const Size(0, 34)),
                child: const Text("批准", style: TextStyle(fontSize: 12)),
              ),
            ),
          ]),
        ],
      ),
    );
  }

  Widget _composer(bool online) {
    final canSend = online && !_sending;
    return Container(
      decoration: const BoxDecoration(
        color: Mx.tabbar,
        border: Border(top: BorderSide(color: Mx.border)),
      ),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      child: SafeArea(
        top: false,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          // 输入行三件(⌘/输入框/发送)统一 44 高 + 底对齐:原先 ⌘ 被 bottom padding
          // 顶起、按钮 40 而输入框 ~43,视觉歪(2026-10-30 用户「发送按钮没垂直对齐」)。
          Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
          // 快捷指令入口(桌面端输入框旁 ⋯ 菜单的手机版)。
          _commandButton(online),
          const SizedBox(width: 6),
          Expanded(
            child: TextField(
              controller: _input,
              minLines: 1,
              maxLines: 4,
              enabled: online,
              textInputAction: TextInputAction.newline,
              decoration: InputDecoration(
                hintText: online ? "发消息给 ${_provider == "claude" ? "Claude" : "Codex"}…" : "连接已断开,正在重连…",
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                // 单行时撑到 44 与两侧按钮同高(多行不受限,底对齐下顶边平齐)。
                constraints: const BoxConstraints(minHeight: 44),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _busy
              ? FilledButton(
                  onPressed: _stop,
                  style: FilledButton.styleFrom(
                    backgroundColor: Mx.danger,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                  ),
                  child: const Text("停止", style: TextStyle(fontSize: 12)),
                )
              : FilledButton(
                  onPressed: canSend ? _send : null,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size(0, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                  ),
                  child: _sending
                      ? const SizedBox(
                          width: 14, height: 14,
                          child: CircularProgressIndicator(strokeWidth: 1.6, color: Mx.accentContrast),
                        )
                      : const Text("发送", style: TextStyle(fontSize: 12)),
                ),
        ]),
        ]),
      ),
    );
  }

  /// AppBar 右侧的会话用量小字(2026-10-30 从消息底部 composer 上方挪来)。
  /// claude=当前上下文口径每轮覆盖,codex=逐轮累计;有真实数据才显示。
  Widget _usageLabel() {
    final showUsage = _stream.usageInput > 0 || _stream.usageOutput > 0;
    if (!showUsage) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: Center(
        child: Text(
          "↑${_fmtTokens(_stream.usageInput)} ↓${_fmtTokens(_stream.usageOutput)}",
          style: const TextStyle(fontSize: 10, color: Mx.faint),
        ),
      ),
    );
  }

  /// tokens 人读格式(1.2M / 354K / 812),与桌面端 formatTokens 同风格。
  static String _fmtTokens(int n) {
    if (n >= 1000000) {
      final v = n / 1000000.0;
      return "${v >= 10 ? v.toStringAsFixed(1) : v.toStringAsFixed(2)}M";
    }
    if (n >= 1000) return "${(n / 1000.0).toStringAsFixed(n >= 100000 ? 0 : 1)}K";
    return "$n";
  }

  /// composer 左侧的 ⌘ 按钮:打开快捷指令面板。固定 44 高与输入框/发送按钮同排对齐。
  Widget _commandButton(bool online) {
    return SizedBox(
      height: 44,
      child: IconButton(
        icon: const Icon(Icons.bolt_outlined, size: 20),
        tooltip: "快捷指令",
        visualDensity: VisualDensity.compact,
        color: Mx.accentBright,
        onPressed: online ? _openCommands : null,
      ),
    );
  }

  Future<void> _openCommands() async {
    // 先弹面板(用缓存或空清单),chat.models 后台拉——原来 await round-trip 才弹,
    // 公网延迟全算在「点按钮→面板出现」上。拉到后 setState 刷新面板内容。
    Future<void> fetchModels() async {
      try {
        final resp = await widget.client.request("chat.models", {
          "projectId": widget.projectId,
          "tabId": widget.tabId,
        });
        if (!mounted) return;
        setState(() {
          _modelsCache[widget.tabId] = ((resp["result"]?["models"] as List<dynamic>?) ?? const [])
              .map((e) => (e as Map).cast<String, dynamic>())
              .toList();
          _groupsCache[widget.tabId] = ((resp["result"]?["groups"] as List<dynamic>?) ?? const [])
              .map((e) => (e as Map).cast<String, dynamic>())
              .toList();
        });
      } catch (_) {/* 拉不到就用缓存/空清单,不挡其它指令 */}
    }
    if (mounted) setState(() {});
    unawaited(fetchModels());

    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: Mx.surface,
      isScrollControlled: true,
      // 高度上限 75% 屏高,内容超出内部滚动(2026-11-05 用户定调)。
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.75),
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: _commandSheetRows(ctx),
            ),
          ),
        ),
      ),
    );
  }

  /// 面板内容:按 provider 给不同指令集。
  ///
  /// **桌面专属指令一律不出现**(`/folder` `/memory` `/agents` `/skills` `/mcp` `/plugins`
  /// `/config` `/export` `/doctor` `/rewind` `/add-dir` `/help`):它们要么打开电脑上的面板,
  /// 要么读本地文件,手机上点了没有任何反馈,只会让人以为坏了。
  List<Widget> _commandSheetRows(BuildContext sheetCtx) {
    final models = _modelsCache[widget.tabId] ?? const [];
    final groups = _groupsCache[widget.tabId] ?? const [];
    final activeModel = _stream.model;
    final rows = <Widget>[
      Padding(
        padding: const EdgeInsets.fromLTRB(2, 0, 2, 8),
        child: Row(children: [
          Text(
            _provider == "claude" ? "Claude 会话动作" : "Codex 会话动作",
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Mx.textBright),
          ),
          const SizedBox(width: 8),
          if (_busy)
            const Text("运行中 · 切模型需先停止",
                style: TextStyle(fontSize: 10, color: Mx.warning)),
        ]),
      ),
    ];

    if (_provider == "claude") {
      rows
        ..add(_sectionLabel("上下文"))
        ..add(_cmdTile(
          icon: Icons.compress,
          title: "压缩上下文",
          subtitle: "/compact · 把长对话压成摘要,腾出窗口",
          enabled: !_busy,
          onTap: () => _runCommand("compact", closeSheet: sheetCtx),
        ))
        ..add(_cmdTile(
          icon: Icons.cleaning_services_outlined,
          title: "清空会话",
          subtitle: "/clear · 清屏并开一条新上下文(历史仍可从桌面端恢复)",
          enabled: !_busy,
          onTap: () => _runCommand("clear", closeSheet: sheetCtx),
        ))
        ..add(_sectionLabel("模型"))
        ..addAll(_modelChoices(models, sheetCtx, groups, activeModel))
        ..add(_sectionLabel("推理档位"))
        ..addAll(_effortChoices(sheetCtx))
        ..add(_sectionLabel("权限模式"))
        ..addAll(_claudeModeChoices(sheetCtx))
        ..add(_sectionLabel("进程"))
        ..add(_cmdTile(
          icon: Icons.restart_alt,
          title: "重启会话进程",
          subtitle: "保留会话历史(--resume 续接),拾取 settings.json 的新配置",
          enabled: !_busy,
          onTap: () => _runCommand("restart", closeSheet: sheetCtx),
        ))
        ..add(_cmdTile(
          icon: Icons.power_settings_new,
          title: "结束会话",
          subtitle: "杀掉 claude 进程(下条消息会自动重新拉起并续接)",
          enabled: true,
          danger: true,
          onTap: () => _runCommand("exit", closeSheet: sheetCtx),
        ));
      return rows;
    }

    // codex:model / reasoning 每轮传参,新会话只影响下一轮 —— 这些都不需要重启。
    rows
      ..add(_sectionLabel("会话"))
      ..add(_cmdTile(
        icon: Icons.add_comment_outlined,
        title: "下一条开新会话",
        subtitle: _newSessionNext ? "已排队:下一条消息不续接当前 thread" : "下一条消息不续接当前 thread",
        enabled: !_busy,
        selected: _newSessionNext,
        onTap: () {
          Navigator.pop(sheetCtx);
          setState(() => _newSessionNext = true);
          _toast("下一条消息将开新会话");
        },
      ))
      ..add(_sectionLabel("模型"))
      ..addAll(_codexModelChoices(models, sheetCtx))
      ..add(_sectionLabel("推理档位"))
      ..addAll(_codexReasoningChoices(models, sheetCtx))
      ..add(_sectionLabel("权限"))
      ..addAll(_codexPermissionChoices(sheetCtx))
      ..add(_sectionLabel("沙箱"))
      ..addAll(_codexSandboxChoices(sheetCtx))
      ..add(_sectionLabel("进程"))
      ..add(_cmdTile(
        icon: Icons.power_settings_new,
        title: "结束当前轮",
        subtitle: "kill 正在跑的 codex exec(下一轮照常)",
        enabled: _busy || _stream.status == "error",
        danger: true,
        onTap: () => _runCommand("exit", closeSheet: sheetCtx),
      ));
    return rows;
  }

  Widget _sectionLabel(String text) => Padding(
        padding: const EdgeInsets.fromLTRB(2, 10, 2, 6),
        child: Text(text,
            style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Mx.dim)),
      );

  /// claude 模型:**供应商分组**(2026-10-30):groups 非空按供应商分节,点选走
  /// `chat.setProviderModel`(与桌面 applyProvider 同一条写入路径:整体替换
  /// settings.json env);生效家当前模型高亮。groups 空(老桌面未推 providers 镜像)
  /// 退回扁平列表 + /model 单键切换。
  List<Widget> _modelChoices(List<Map<String, dynamic>> models, BuildContext sheetCtx,
      List<Map<String, dynamic>> groups, String? activeModel) {
    if (groups.isNotEmpty) {
      return _groupedModelChoices(groups, activeModel ?? _stream.model, sheetCtx);
    }
    final current = _stream.model;
    final out = <Widget>[];
    if (current != null && current.isNotEmpty) {
      out.add(_cmdTile(
        icon: Icons.check,
        title: current,
        subtitle: "当前模型",
        enabled: false,
        selected: true,
        onTap: () {},
      ));
    }
    for (final m in models) {
      final id = m["id"] as String? ?? "";
      final label = m["label"] as String? ?? id;
      if (id.isEmpty || id == current) continue;
      out.add(_cmdTile(
        icon: Icons.memory,
        title: label,
        subtitle: id == label ? null : id,
        enabled: !_busy,
        onTap: () => _runCommand("model", value: id, closeSheet: sheetCtx),
      ));
    }
    if (out.isEmpty) {
      out.add(const _EmptyHint("这个环境没配可选模型(settings.json 里没有 *_MODEL)"));
    }
    return out;
  }

  /// 供应商分组模型区:每家一节(生效家标注),组内模型 tile。
  List<Widget> _groupedModelChoices(List<Map<String, dynamic>> groups, String? current, BuildContext sheetCtx) {
    final out = <Widget>[];
    for (final g in groups) {
      final gid = g["id"] as String? ?? "";
      final gname = g["name"] as String? ?? "未命名";
      final active = g["active"] == true;
      final models = (g["models"] as List<dynamic>? ?? const [])
          .whereType<String>()
          .toList();
      if (models.isEmpty) continue;
      out.add(_sectionLabel(active ? "$gname · 生效中" : gname));
      for (final m in models) {
        final isCurrent = active && (m == current || current == null);
        out.add(_cmdTile(
          icon: isCurrent ? Icons.check : Icons.memory,
          title: m,
          subtitle: isCurrent ? "当前模型" : null,
          enabled: !_busy && !isCurrent,
          selected: isCurrent,
          onTap: () => _setProviderModel(gid, m, closeSheet: sheetCtx),
        ));
      }
    }
    if (out.isEmpty) {
      out.add(const _EmptyHint("供应商镜像为空(在桌面端设置中心配置供应商后重试)"));
    }
    return out;
  }

  /// 按供应商切模型(relay chat.setProviderModel;写 settings.json 下一轮生效,
  /// 运行中长进程由 env 哈希检测拾取)。
  Future<void> _setProviderModel(String providerId, String model, {BuildContext? closeSheet}) async {
    if (closeSheet != null) Navigator.pop(closeSheet);
    try {
      await widget.client.request("chat.setProviderModel", {
        "projectId": widget.projectId,
        "tabId": widget.tabId,
        "providerId": providerId,
        "model": model,
      });
      if (!mounted) return;
      setState(() => _stream.model = model);
      _toast("已切换到 $model(下一轮生效)");
    } catch (e) {
      if (mounted) _toast(e.toString());
    }
  }

  /// AppBar 的后台任务 pill(有任务才显示;点开任务列表)。
  Widget _bgPill() {
    final tasks = _stream.backgroundTasks;
    if (tasks.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(right: 2),
      child: GestureDetector(
        onTap: _showBackgroundTasks,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
          decoration: BoxDecoration(
            color: Mx.violetSoft,
            borderRadius: BorderRadius.circular(Mx.radiusSm),
            border: Border.all(color: Mx.borderSoft),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.work_history_outlined, size: 11, color: Mx.violet),
            const SizedBox(width: 3),
            Text("后台 ${tasks.length}",
                style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: Mx.violet)),
          ]),
        ),
      ),
    );
  }

  /// 后台任务列表(底部弹层:类型 + 描述)。
  Future<void> _showBackgroundTasks() async {
    final tasks = _stream.backgroundTasks;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: Mx.surface,
      builder: (ctx) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(14, 0, 14, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text("后台任务(${tasks.length})",
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: Mx.textBright)),
              ),
              for (final t in tasks)
                Container(
                  margin: const EdgeInsets.only(bottom: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                  decoration: BoxDecoration(
                    color: Mx.card,
                    borderRadius: BorderRadius.circular(Mx.radiusMd),
                    border: Border.all(color: Mx.border),
                  ),
                  child: Row(children: [
                    const Icon(Icons.work_history_outlined, size: 14, color: Mx.violet),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(t["description"]?.isNotEmpty == true ? t["description"]! : "(无描述)",
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12, color: Mx.text)),
                          Text(t["taskType"] ?? "",
                              style: const TextStyle(fontSize: 10, color: Mx.muted)),
                        ],
                      ),
                    ),
                  ]),
                ),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _codexModelChoices(List<Map<String, dynamic>> models, BuildContext sheetCtx) {
    final current = _modelOverride ?? _stream.model;
    final out = <Widget>[];
    for (final m in models) {
      final id = m["id"] as String? ?? "";
      if (id.isEmpty) continue;
      final label = m["label"] as String? ?? id;
      out.add(_cmdTile(
        icon: id == current ? Icons.check : Icons.memory,
        title: label,
        subtitle: id == label ? null : id,
        enabled: true,
        selected: id == current,
        onTap: () {
          Navigator.pop(sheetCtx);
          setState(() {
            _modelOverride = id;
            // 换模型后旧 reasoning 档可能不支持:显式回到 auto(空串哨兵),
            // 不能置 null —— null 会被 `chat.status` 用旧档回填。
            _reasoningOverride = "";
          });
          _toast("下一条消息使用 $label");
        },
      ));
    }
    if (out.isEmpty) {
      out.add(const _EmptyHint("codex 模型目录为空(cc-switch catalog 未配置)"));
    }
    return out;
  }

  /// codex 推理档位:值域来自模型目录的 `reasoningLevels`(不同模型支持不同档),
  /// 目录缺失时退回桌面端 `FALLBACK_REASONING_LEVELS`。「auto」= 不传
  /// `-c model_reasoning_effort`,由 config.toml 决定。
  List<Widget> _codexReasoningChoices(
      List<Map<String, dynamic>> models, BuildContext sheetCtx) {
    final modelId = _modelOverride ?? _stream.model;
    var levels = <String>[];
    for (final m in models) {
      if (m["id"] == modelId) {
        levels = ((m["reasoningLevels"] as List<dynamic>?) ?? const [])
            .whereType<String>()
            .where((s) => s.isNotEmpty)
            .toList();
        break;
      }
    }
    if (levels.isEmpty) levels = const ["low", "medium", "high", "xhigh"];
    final current = _effectiveReasoning;
    return [
      for (final lv in ["auto", ...levels])
        _cmdTile(
          icon: lv == current ? Icons.check : Icons.tune,
          title: lv,
          subtitle: lv == "auto" ? "不传 model_reasoning_effort,用 config.toml 默认" : null,
          enabled: true,
          selected: lv == current,
          onTap: () {
            Navigator.pop(sheetCtx);
            // 空串 = 显式 auto(下一轮不传 `model_reasoning_effort`)。
            setState(() => _reasoningOverride = lv == "auto" ? "" : lv);
            _toast(lv == "auto" ? "推理档位跟随 config.toml" : "下一条消息推理档位:$lv");
          },
        ),
    ];
  }

  /// claude 推理档位:auto/low/medium/high/xhigh/max(`--effort`)。
  /// 「auto」= 不传 flag,后端翻译成 None。
  List<Widget> _effortChoices(BuildContext sheetCtx) {
    const levels = ["auto", "low", "medium", "high", "xhigh", "max"];
    final current = _stream.effort ?? "auto";
    return [
      for (final lv in levels)
        _cmdTile(
          icon: lv == current ? Icons.check : Icons.tune,
          title: lv,
          enabled: !_busy,
          selected: lv == current,
          onTap: () => _runCommand("effort", value: lv, closeSheet: sheetCtx),
        ),
    ];
  }

  /// claude 权限模式(`--permission-mode` 启动 flag,重启进程换):走 `chat.command`
  /// mode(与 model/effort 同一 restart 机制,带上其余启动参数)。当前档由
  /// `chat.status.permissionMode` 回读(启动时的值),切换后 `_refreshStatus` 校准。
  List<Widget> _claudeModeChoices(BuildContext sheetCtx) {
    const modes = [
      ("acceptEdits", "自动接受编辑", "文件编辑自动通过,其余操作仍询问"),
      ("plan", "计划模式", "只读调研,先提方案经你确认再动手"),
      ("manual", "逐步确认", "每次操作都先问你(最稳)"),
      ("bypassPermissions", "跳过所有权限", "全部放行不再询问(谨慎)"),
    ];
    final current = _claudeMode ?? "acceptEdits";
    return [
      for (final (id, title, desc) in modes)
        _cmdTile(
          icon: id == current ? Icons.check : Icons.verified_user_outlined,
          title: "$title · $id",
          subtitle: desc,
          enabled: !_busy,
          selected: id == current,
          onTap: () => _runCommand("mode", value: id, closeSheet: sheetCtx),
        ),
    ];
  }

  /// codex 权限四档(桌面 CodexPane 状态栏同口径;每轮参数随 chat.send 带,
  /// app-server per-turn override 下一轮即生效,无需重启)。approval 档联动 sandbox。
  List<Widget> _codexPermissionChoices(BuildContext sheetCtx) {
    const profiles = [
      ("ask-for-approval", "每次询问", "工作区写入可用,敏感操作先问你"),
      ("approve-for-me", "自动批准", "工作区内自动批准,不再询问"),
      ("full-access", "完全访问", "全放行,不限工作区(谨慎)"),
      ("read-only", "只读", "只读不写,最安全"),
    ];
    final current = _codexPermission ?? "ask-for-approval";
    return [
      for (final (id, title, desc) in profiles)
        _cmdTile(
          icon: id == current ? Icons.check : Icons.verified_user_outlined,
          title: title,
          subtitle: desc,
          enabled: true,
          selected: id == current,
          onTap: () {
            Navigator.pop(sheetCtx);
            _setCodexPermission(id);
            _toast("下一条消息权限:$title");
          },
        ),
    ];
  }

  /// codex 沙箱三档(桌面 SANDBOX_MODES 同口径)。切沙箱时按桌面 setSandboxMode
  /// 规则归档权限档,避免「权限显示与实际沙箱不一致」。
  List<Widget> _codexSandboxChoices(BuildContext sheetCtx) {
    const sandboxes = [
      ("read-only", "只读", "不能写文件,只能看"),
      ("workspace-write", "工作区写入", "只能写项目目录内"),
      ("danger-full-access", "完全访问", "全盘可写(谨慎)"),
    ];
    final current = _codexSandbox ?? "workspace-write";
    return [
      for (final (id, title, desc) in sandboxes)
        _cmdTile(
          icon: id == current ? Icons.check : Icons.shield_outlined,
          title: title,
          subtitle: desc,
          enabled: true,
          selected: id == current,
          onTap: () {
            Navigator.pop(sheetCtx);
            _setCodexSandbox(id);
            _toast("下一条消息沙箱:$title");
          },
        ),
    ];
  }

  /// codex 权限档切换(桌面 setPermissionMode 同语义:profile 决定 sandbox)。
  void _setCodexPermission(String id) {
    const profileSandbox = {
      "ask-for-approval": "workspace-write",
      "approve-for-me": "workspace-write",
      "full-access": "danger-full-access",
      "read-only": "read-only",
    };
    setState(() {
      _codexPermission = id;
      _codexSandbox = profileSandbox[id] ?? "workspace-write";
    });
  }

  /// codex 沙箱档切换(桌面 setSandboxMode 同语义:反推权限档保联动一致)。
  void _setCodexSandbox(String mode) {
    setState(() {
      _codexSandbox = mode;
      _codexPermission = mode == "danger-full-access"
          ? "full-access"
          : mode == "read-only"
              ? "read-only"
              : (_codexPermission == "approve-for-me" ? "approve-for-me" : "ask-for-approval");
    });
  }

  Widget _cmdTile({
    required IconData icon,
    required String title,
    String? subtitle,
    required bool enabled,
    bool selected = false,
    bool danger = false,
    required VoidCallback onTap,
  }) {
    final fg = danger ? Mx.danger : (selected ? Mx.accentBright : Mx.text);
    return Opacity(
      opacity: enabled ? 1 : 0.45,
      child: InkWell(
        borderRadius: BorderRadius.circular(Mx.radiusMd),
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
          child: Row(children: [
            Icon(icon, size: 15, color: enabled ? fg : Mx.faint),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: TextStyle(
                          fontSize: 13,
                          fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                          color: enabled ? fg : Mx.muted)),
                  if (subtitle != null && subtitle.isNotEmpty)
                    Text(subtitle,
                        style: const TextStyle(fontSize: 10.5, height: 1.35, color: Mx.muted)),
                ],
              ),
            ),
            if (selected) const Icon(Icons.check_circle, size: 14, color: Mx.accentBright),
          ]),
        ),
      ),
    );
  }

  /// 发一条快捷指令。`closeSheet` 非空 → 先收面板(避免面板盖住结果/错误条);
  /// `value` 给 model/effort 用。
  Future<void> _runCommand(String command, {String? value, BuildContext? closeSheet}) async {
    if (closeSheet != null) Navigator.pop(closeSheet);
    try {
      final resp = await widget.client.request("chat.command", {
        "projectId": widget.projectId,
        "tabId": widget.tabId,
        "command": command,
        "value": ?value,
      });
      final r = (resp["result"] as Map?)?.cast<String, dynamic>();
      if (!mounted) return;
      // 重启类指令会换进程:状态/模型/effort 全部重新读一遍(init 事件随后也会推过来)。
      await _refreshStatus(quiet: true);
      if (!mounted) return;
      final label = switch (command) {
        "compact" => "已开始压缩上下文",
        "clear" => "会话已清空",
        "model" => "模型已切换:${r?["model"] ?? value}",
        "effort" => "推理档位已切换:${r?["effort"] ?? value}",
        "mode" => "权限模式已切换:${r?["permissionMode"] ?? value}",
        "restart" => "会话进程已重启",
        "exit" => "会话已结束",
        _ => "已执行 $command",
      };
      _toast(label);
    } catch (e) {
      if (mounted) setState(() => _error = "指令失败: $e");
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(msg, style: const TextStyle(fontSize: 12)),
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
      ),
    );
  }
}
/// 「正在输入」三点呼吸(与桌面端 ThinkingDots 同款语义:纯呼吸,不做形状循环)。
class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.only(left: 4, bottom: 8),
        child: AnimatedBuilder(
          animation: _c,
          builder: (context, _) => Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < 3; i++)
                Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: Opacity(
                    opacity: 0.25 + 0.6 * _wave(i),
                    child: Container(
                      width: 5,
                      height: 5,
                      decoration: const BoxDecoration(color: Mx.accentBright, shape: BoxShape.circle),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 三点错相呼吸:每点在自己相位上的 sin 幅度(0..1)。
  double _wave(int i) {
    final t = (_c.value + i * 0.18) % 1.0;
    return (0.5 - 0.5 * math.cos(t * 2 * math.pi)).clamp(0.0, 1.0);
  }
}

/// 折叠块(tool / thinking 共用)。
class _Collapsible extends StatefulWidget {
  final Widget header;
  final Widget body;
  const _Collapsible({required this.header, required this.body});

  @override
  State<_Collapsible> createState() => _CollapsibleState();
}

class _CollapsibleState extends State<_Collapsible> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 3),
            child: Row(children: [
              Icon(_open ? Icons.expand_less : Icons.expand_more, size: 13, color: Mx.faint),
              const SizedBox(width: 2),
              Flexible(child: widget.header),
            ]),
          ),
        ),
        if (_open)
          Container(
            margin: const EdgeInsets.only(top: 2, bottom: 4),
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
            decoration: BoxDecoration(
              color: Mx.cardInner,
              borderRadius: BorderRadius.circular(Mx.radiusSm),
              border: Border.all(color: Mx.borderSoft),
            ),
            child: widget.body,
          ),
      ],
    );
  }
}

/// 快捷指令面板里的空态提示(某类候选拉不到数据时占位)。
class _EmptyHint extends StatelessWidget {
  final String text;
  const _EmptyHint(this.text);

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 4, 8, 8),
      child: Text(text, style: const TextStyle(fontSize: 11, height: 1.4, color: Mx.faint)),
    );
  }
}
