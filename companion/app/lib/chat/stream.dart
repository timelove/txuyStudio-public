// 对话消息归并:桌面端 `src/domain/claudeStream.ts` / `codexStream.ts` 的**展示必需**精简移植。
//
// 只搬「把事件流变成可渲染消息块」这一层:不搬 retry 状态机、不搬 ctx 账本、不搬
// 权限重试/审批超时等桌面端专属逻辑。目标是一份代码同时消费:
//   1. `chat.history` 回填(与实时事件**同构**的 ClaudeEventPayload 序列);
//   2. 实时 `chat.event` 推送。
// 这样手机端只有一条渲染路径,不会出现「历史长这样、新消息长那样」的分裂。

/// 一条消息里的一个块。
class ChatBlock {
  final String type; // "text" | "thinking" | "tool"
  String text; // text / thinking 正文;tool 时为命令或参数摘要
  String? toolName;
  String? toolId;
  String? result; // 工具结果文本(null = 未回填)
  bool isError;
  bool get pending => type == "tool" && result == null && !isError;

  ChatBlock.text(this.text)
      : type = "text",
        toolName = null,
        toolId = null,
        result = null,
        isError = false;
  ChatBlock.thinking(this.text)
      : type = "thinking",
        toolName = null,
        toolId = null,
        result = null,
        isError = false;
  ChatBlock.tool({
    required this.toolName,
    required this.toolId,
    required this.text,
  })  : type = "tool",
        result = null,
        isError = false;

  /// 原地回填工具结果(不做不可变拷贝——Flutter 侧用 setState 重绘,没必要每次重建整表)。
  void fillResult(String content, bool error) {
    result = content;
    isError = error;
  }
}

/// 一条消息(用户输入 / assistant 回复 / 系统提示)。
class ChatMessage {
  final String id;
  final String role; // "user" | "assistant" | "system"
  final List<ChatBlock> blocks;
  ChatMessage({required this.id, required this.role, required this.blocks});
}

/// 审批卡(claude `can_use_tool`)。
class PermissionAsk {
  final String requestId;
  final String toolName;
  final String inputBrief;
  final Map<String, dynamic> input;
  PermissionAsk({
    required this.requestId,
    required this.toolName,
    required this.inputBrief,
    required this.input,
  });
}

/// 归并状态。一个 (projectId, tabId) 一份。
class ChatStream {
  final List<ChatMessage> messages = [];
  final Map<String, int> _msgIndex = {}; // message.id -> messages 下标
  final Map<String, (int, int)> _toolIndex = {}; // tool_use id -> (msgIdx, blockIdx)
  final List<PermissionAsk> permissions = [];
  String status = "idle"; // idle | running | thinking | done | error
  String? model;
  /// claude 的推理档位(`--effort` 启动 flag,由 `chat.status` 回读;空 = auto)。
  String? effort;
  String? sessionId;
  String? terminatedReason;

  /// 当前会话用量(2026-10-29)。两条链路口径不同:
  /// - claude = **当前上下文**口径:result.usage 每轮整体覆盖(glm 代理 result.usage
  ///   即当前上下文,官方流式快照同语义;与桌面 computeContextInfo 一致)。
  /// - codex = **逐轮累计**:turn_completed.usage 是本轮用量,求和。
  /// 历史回放与实时流同路归并(claude 历史带 usage 可重建;codex 历史是扁平
  /// role/text 无 usage,重进页面从零累计)。
  int usageInput = 0; // claude: input + cacheRead + cacheCreation 三段纯和
  int usageOutput = 0;

  /// 后台任务快照(claude `background_tasks_changed` 权威替换,[] = 无;chat.status
  /// 断线重连补齐同写这里)。桌面端「后台 ×N」同源。
  List<Map<String, String>> backgroundTasks = [];

  /// 装载期实时事件缓冲(2026-11-05 竞态修复)。
  ///
  /// `_bootstrap` 拉历史期间(round-trip 数秒),桌面端的实时事件已在到达;若直接归并,
  /// 随后 `_applyHistoryPayload` 的 `clear()` 重建会把它们洗掉——用户实测「新消息凭空消失」。
  /// 置 `buffering` 后 `applyLive` 把事件存进这里,历史落地后 `replayBuffered` 按序重放:
  /// 归并按 msgId/toolId 去重,与历史重叠部分幂等吸收,重叠之外的是真正的新消息。
  final List<Map<String, dynamic>> _liveBuffer = [];
  bool _buffering = false;

  /// 进入装载期:实时事件改走缓冲(见 _liveBuffer)。
  void beginBuffering() {
    _buffering = true;
  }

  /// 结束缓冲并按序重放积压事件(无积压时零开销)。
  void replayBuffered() {
    _buffering = false;
    if (_liveBuffer.isEmpty) return;
    final pending = List<Map<String, dynamic>>.of(_liveBuffer);
    _liveBuffer.clear();
    for (final p in pending) {
      final provider = p.remove("provider") as String? ?? "claude";
      if (provider == "claude") {
        applyClaude(p);
      } else {
        applyCodex(p);
      }
    }
  }

  /// 实时事件入口:装载期缓冲,装载完成后直接归并。
  ///
  /// claude/codex 共用一个缓冲(同 tab 不会双 provider 混流),重放时按帧内 provider 分流。
  void applyLive(String provider, Map<String, dynamic> payload) {
    if (_buffering) {
      _liveBuffer.add({"provider": provider, ...payload});
      return;
    }
    if (provider == "claude") {
      applyClaude(payload);
    } else {
      applyCodex(payload);
    }
  }

  void clear() {
    messages.clear();
    _msgIndex.clear();
    _toolIndex.clear();
    permissions.clear();
    status = "idle";
    terminatedReason = null;
    usageInput = 0;
    usageOutput = 0;
    backgroundTasks = [];
  }

  /// 把一条 claude payload 归并进来。`payload` 是后端 `ClaudeEventPayload` 的 JSON。
  void applyClaude(Map<String, dynamic> p) {
    switch (p["kind"]) {
      case "init":
        model = _nonEmpty(p["model"]) ?? model;
        sessionId = _nonEmpty(p["claudeSessionId"]) ?? sessionId;
        terminatedReason = null;
        if (status == "idle") status = "running";
        break;
      case "assistant":
        final msg = (p["message"] as Map?)?.cast<String, dynamic>() ?? const {};
        final realModel = _nonEmpty(msg["model"]);
        if (realModel != null && realModel != "<synthetic>") model = realModel;
        status = "running";
        terminatedReason = null;
        _mergeAssistant(msg);
        break;
      case "user":
        _applyUser((p["message"] as Map?)?.cast<String, dynamic>() ?? const {});
        break;
      case "thinking":
        status = "thinking";
        break;
      case "result":
        status = p["success"] == true ? "done" : "error";
        _absorbClaudeUsage(p["usage"]);
        permissions.clear();
        _finalizeTools();
        break;
      case "terminated":
        if (p["reason"] == "interrupted") {
          status = "idle";
          terminatedReason = null;
        } else {
          status = "error";
          terminatedReason = p["reason"] as String?;
        }
        permissions.clear();
        _finalizeTools();
        break;
      case "permission_request":
        permissions.removeWhere((a) => a.requestId == p["requestId"]);
        permissions.add(PermissionAsk(
          requestId: p["requestId"] ?? "",
          toolName: (p["displayName"] as String?)?.isNotEmpty == true
              ? p["displayName"]
              : (p["toolName"] ?? "tool"),
          inputBrief: _briefInput(p["input"]),
          input: (p["input"] as Map?)?.cast<String, dynamic>() ?? const {},
        ));
        break;
      case "compact_status":
        // 桌面端 `claudeStream.ts` 同口径:status="compacting" 开始,result="success"|"failed" 结束。
        // 手机端把它直接映射到 status(不另开 compactRunning 字段):compacting 期间要显示
        // 「压缩中」且不接受新消息,正是 _busy 的语义。
        if (p["status"] == "compacting") {
          status = "compacting";
        } else if (p["result"] == "success" || p["result"] == "failed") {
          if (status == "compacting") status = p["result"] == "failed" ? "error" : "running";
          if (p["result"] == "failed") terminatedReason = _nonEmpty(p["error"]);
        }
        break;
      case "background_tasks_changed":
        // 后台任务列表权威快照(任务启动/完成/变化时推;清空即无)。
        // kind 是 snake_case(与 Rust enum rename_all 对齐):曾误写 camelCase 恒不匹配,
        // 列表只能靠 chat.status 填一次、完成后清不掉(2026-11-05 用户实测卡死)。
        backgroundTasks = [
          for (final t in (p["tasks"] as List<dynamic>? ?? const []))
            if (t is Map)
              {
                "taskId": t["taskId"] as String? ?? "",
                "taskType": t["taskType"] as String? ?? "",
                "description": t["description"] as String? ?? "",
              },
        ];
        break;
      case "task_notification":
        // 后台任务完成/失败通知:插一条轻提示消息(与桌面消息流同位)。
        final summary = _nonEmpty(p["summary"]) ?? "后台任务更新";
        messages.add(ChatMessage(
          id: "notif-${p["taskId"] ?? ""}-${DateTime.now().millisecondsSinceEpoch}",
          role: "system",
          blocks: [ChatBlock.text(summary)],
        ));
        break;
      // compact_boundary / context_usage:手机端 v1 不渲染(需要额外的卡片样式,收益低于体积)。
      default:
        break;
    }
  }

  /// codex 事件归并。
  void applyCodex(Map<String, dynamic> p) {
    switch (p["kind"]) {
      case "init":
        sessionId = _nonEmpty(p["sessionId"]) ?? sessionId;
        terminatedReason = null;
        break;
      case "turn_started":
        status = "running";
        break;
      case "user":
        // 手机经中继发来的用户消息回显(codex 原生事件不回显输入,这条是后端补的)。
        // 手机自己发的那条已在 `_send` 里乐观插入并用同 id 登记,这里会被 `_applyUser` 去重。
        status = "running";
        _applyUser((p["message"] as Map?)?.cast<String, dynamic>() ?? const {});
        break;
      case "item_started":
        status = "running";
        final item = (p["item"] as Map?)?.cast<String, dynamic>() ?? const {};
        if (_isToolItem(item)) _pushTool(item, done: false);
        break;
      case "item_completed":
        final item = (p["item"] as Map?)?.cast<String, dynamic>() ?? const {};
        final type = item["type"] as String? ?? "";
        if (type == "agent_message") {
          final text = item["text"] as String? ?? "";
          if (text.trim().isNotEmpty) {
            _pushOrMergeText(item["id"] as String? ?? _genId("agent"), text);
          }
        } else if (type == "reasoning") {
          final text = item["text"] as String? ?? "";
          if (text.isNotEmpty) _appendThinking(text);
        } else if (_isToolItem(item)) {
          _pushTool(item, done: true);
        } else if (type == "error") {
          final text = item["message"] as String? ?? "";
          if (text.isNotEmpty) _appendSystem(text);
        }
        break;
      case "turn_completed":
        status = "done";
        _absorbCodexUsage(p["usage"]);
        _finalizeTools();
        break;
      case "approval_requested":
        // app-server 实时审批帧(request 外壳 = {key, method, params})。复用 claude
        // 审批卡结构渲染;应答走 `chat.codexApproval`(key + approved,decision 枚举
        // 由桌面端按 method 代际分派,手机端不感知协议代际)。
        final req = (p["request"] as Map?)?.cast<String, dynamic>() ?? const {};
        final key = req["key"] as String? ?? "";
        if (key.isNotEmpty) {
          final rp = (req["params"] as Map?)?.cast<String, dynamic>() ?? const {};
          permissions.removeWhere((a) => a.requestId == key);
          permissions.add(PermissionAsk(
            requestId: key,
            toolName: _codexApprovalLabel(req["method"] as String? ?? ""),
            inputBrief: (rp["command"] as String?) ?? (rp["reason"] as String?) ?? "",
            input: rp,
          ));
        }
        break;
      case "approval_resolved":
        // 后端 respond(或超时/他端决策)后的权威广播:无条件撤卡(多视图同步兜底;
        // 手机自己应答的本地清除在 _answer,先到先生效)。
        final rid = p["requestId"] as String? ?? "";
        permissions.removeWhere((a) => a.requestId == rid);
        break;
      case "terminated":
        // normal = 每轮 exec 正常 EOF(设计如此,当 idle);interrupted = 用户中断。
        final reason = p["reason"] as String? ?? "";
        if (reason == "normal" || reason == "interrupted") {
          status = status == "running" ? "idle" : status;
          if (status == "idle") terminatedReason = null;
        } else {
          status = "error";
          terminatedReason = reason;
        }
        // 轮已断(进程死/中断),审批请求不再可答,撤卡防悬空(桌面同语义)。
        permissions.clear();
        _finalizeTools();
        break;
      default:
        break;
    }
  }

  /// codex 审批帧 method → 可读标签(桌面端按 command/reason 渲染细节,手机端
  /// 卡标题给动作类型)。覆盖 0.166 两代 method 名;未知 method 退「审批请求」。
  static String _codexApprovalLabel(String method) {
    if (method.contains("fileChange") || method.contains("applyPatch")) return "修改文件";
    if (method.contains("permissions")) return "提升权限";
    if (method.contains("commandExecution") || method.contains("execCommand")) return "执行命令";
    return "审批请求";
  }

  /// claude result.usage → 当前上下文口径,整体覆盖(空段跳过防误清零)。
  /// input = 三段纯和(桌面 claudeInputTokens 同口径),对齐 glm 代理语义。
  void _absorbClaudeUsage(Object? raw) {
    final u = (raw as Map?)?.cast<String, dynamic>();
    if (u == null) return;
    final input = (u["input_tokens"] as num?)?.toInt() ?? 0;
    final cacheRead = (u["cache_read_input_tokens"] as num?)?.toInt() ?? 0;
    final cacheCreation = (u["cache_creation_input_tokens"] as num?)?.toInt() ?? 0;
    final output = (u["output_tokens"] as num?)?.toInt() ?? 0;
    if (input + cacheRead + cacheCreation + output <= 0) return;
    usageInput = input + cacheRead + cacheCreation;
    usageOutput = output;
  }

  /// codex turn_completed.usage → 本轮用量,累计。
  /// input 已含 cached(OpenAI 重叠语义,桌面 contextMeter.totalInputTokens 同款
  /// 95% 判别),直接加 cached 会双倍;当前桌面 turn/completed 恒不带 usage
  /// (权威用量走 usage_updated),此路径是防御性兜底。
  void _absorbCodexUsage(Object? raw) {
    final u = (raw as Map?)?.cast<String, dynamic>();
    if (u == null) return;
    final input = (u["input_tokens"] as num?)?.toInt() ?? 0;
    final cached = (u["cached_input_tokens"] as num?)?.toInt() ?? 0;
    final cacheWrite = (u["cache_write_input_tokens"] as num?)?.toInt() ?? 0;
    final output = (u["output_tokens"] as num?)?.toInt() ?? 0;
    final cacheSum = cached + cacheWrite;
    if (input + cacheSum + output <= 0) return;
    final totalIn = (cacheSum > 0 && input >= cacheSum * 0.95)
        ? (input > cacheSum ? input : cacheSum)
        : input + cacheSum;
    usageInput += totalIn;
    usageOutput += output;
  }

  /// 乐观插入用户消息并**用调用方给的 id 登记索引**。
  ///
  /// id 随 `chat.send` 一起发给桌面端,后端回显的 user 事件带同一个 id → `_applyUser`
  /// 的 msgIndex 去重把回显吞掉,不会出现两条相同的提问。
  void addLocalUser(String id, String text) {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    if (_msgIndex.containsKey(id)) return;
    _msgIndex[id] = messages.length;
    messages.add(ChatMessage(id: id, role: "user", blocks: [ChatBlock.text(trimmed)]));
  }

  /// 追加一条纯文本消息(codex 扁平历史回填用:后端只有 role + text,没有结构化事件)。
  void appendPlain({required bool user, required String text}) {    final trimmed = text.trim();
    if (trimmed.isEmpty) return;
    final id = _genId(user ? "user" : "assistant");
    _msgIndex[id] = messages.length;
    messages.add(ChatMessage(
      id: id,
      role: user ? "user" : "assistant",
      blocks: [ChatBlock.text(trimmed)],
    ));
  }

  // ---------- 内部 ----------

  void _mergeAssistant(Map<String, dynamic> msg) {
    final msgId = _nonEmpty(msg["id"]) ?? _genId("assistant");
    final rawBlocks = (msg["content"] as List?) ?? const [];
    final idx = _msgIndex[msgId];
    final msgObj = ChatMessage(
      id: msgId,
      role: "assistant",
      blocks: idx == null ? [] : messages[idx].blocks,
    );
    for (final raw in rawBlocks) {
      final b = (raw as Map).cast<String, dynamic>();
      switch (b["type"]) {
        case "text":
          msgObj.blocks.add(ChatBlock.text(b["text"] as String? ?? ""));
          break;
        case "thinking":
          final t = b["thinking"] as String? ?? "";
          // 同一轮 thinking 通常只有一块:已存在则替换(后到的是完整版)。
          final i = msgObj.blocks.indexWhere((x) => x.type == "thinking");
          if (i >= 0) {
            msgObj.blocks[i].text = t;
          } else {
            msgObj.blocks.add(ChatBlock.thinking(t));
          }
          break;
        case "tool_use":
          final id = b["id"] as String? ?? _genId("tool");
          final existing = msgObj.blocks.indexWhere((x) => x.type == "tool" && x.toolId == id);
          if (existing >= 0) break; // 已回填过,增量重复块忽略
          msgObj.blocks.add(ChatBlock.tool(
            toolName: b["name"] as String? ?? "tool",
            toolId: id,
            text: _briefInput(b["input"]),
          ));
          break;
        default:
          break;
      }
    }
    if (idx != null) {
      messages[idx] = msgObj;
    } else {
      _msgIndex[msgId] = messages.length;
      messages.add(msgObj);
    }
    _reindexTools();
  }

  void _applyUser(Map<String, dynamic> msg) {
    final raw = msg["content"];
    final blocks = <Map<String, dynamic>>[
      if (raw is List)
        for (final e in raw)
          if (e is Map) e.cast<String, dynamic>(),
      if (raw is String) {"type": "text", "text": raw},
    ];
    final results = blocks.where((b) => b["type"] == "tool_result").toList();
    if (results.isNotEmpty) {
      for (final tr in results) {
        final pos = _toolIndex[tr["tool_use_id"]];
        final content = _flattenResult(tr["content"]);
        final isError = tr["is_error"] == true;
        if (pos != null) {
          messages[pos.$1].blocks[pos.$2].fillResult(content, isError);
          continue;
        }
        // 精确配对失败(代理改 id):回填到最近一个仍 pending 的工具块。
        _fillFirstPending(content, isError);
      }
      return;
    }
    final text = blocks
        .where((b) => b["type"] == "text")
        .map((b) => b["text"] as String? ?? "")
        .join("\n")
        .trim();
    if (text.isEmpty) return;
    final id = _nonEmpty(msg["id"]) ?? _genId("user");
    if (_msgIndex.containsKey(id)) return;
    _msgIndex[id] = messages.length;
    messages.add(ChatMessage(id: id, role: "user", blocks: [ChatBlock.text(text)]));
  }

  void _pushOrMergeText(String id, String text) {
    final idx = _msgIndex[id];
    if (idx != null) {
      messages[idx].blocks.add(ChatBlock.text(text));
      return;
    }
    status = "running";
    _msgIndex[id] = messages.length;
    messages.add(ChatMessage(id: id, role: "assistant", blocks: [ChatBlock.text(text)]));
  }

  void _appendThinking(String text) {
    var last = _lastAssistant();
    if (last == null) {
      last = ChatMessage(id: _genId("assistant"), role: "assistant", blocks: []);
      _msgIndex[last.id] = messages.length;
      messages.add(last);
    }
    if (last.blocks.isNotEmpty && last.blocks.last.type == "thinking") {
      last.blocks.last.text += text;
    } else {
      last.blocks.add(ChatBlock.thinking(text));
    }
  }

  void _appendSystem(String text) {
    final id = _genId("sys");
    _msgIndex[id] = messages.length;
    messages.add(ChatMessage(id: id, role: "system", blocks: [ChatBlock.text(text)]));
  }

  /// codex 工具 item:started 建 pending 卡,completed 同 id 回填。
  void _pushTool(Map<String, dynamic> item, {required bool done}) {
    final id = item["id"] as String? ?? _genId("item");
    final name = _codexToolName(item);
    final brief = _codexToolBrief(item);
    final pos = _toolIndex[id];
    if (pos != null) {
      if (!done) return;
      messages[pos.$1].blocks[pos.$2]
          .fillResult(_codexToolResult(item), item["status"] == "failed");
      return;
    }
    var host = _lastAssistant();
    if (host == null) {
      host = ChatMessage(id: _genId("assistant"), role: "assistant", blocks: []);
      _msgIndex[host.id] = messages.length;
      messages.add(host);
    }
    host.blocks.add(ChatBlock.tool(toolName: name, toolId: id, text: brief));
    if (done) {
      host.blocks.last.fillResult(_codexToolResult(item), item["status"] == "failed");
    }
    _toolIndex[id] = (messages.indexOf(host), host.blocks.length - 1);
  }

  /// 轮次结束兜底:仍 pending 的工具块标 done(否则 spinner 永远转)。
  void _finalizeTools() {
    for (final m in messages) {
      for (final b in m.blocks) {
        if (b.type == "tool" && b.result == null && !b.isError) b.fillResult("", false);
      }
    }
  }

  void _fillFirstPending(String content, bool isError) {
    for (var i = messages.length - 1; i >= 0; i--) {
      final m = messages[i];
      if (m.role != "assistant") continue;
      for (final b in m.blocks) {
        if (b.type == "tool" && b.result == null && !b.isError) {
          b.fillResult(content, isError);
          return;
        }
      }
    }
  }

  void _reindexTools() {
    _toolIndex.clear();
    for (var i = 0; i < messages.length; i++) {
      final blocks = messages[i].blocks;
      for (var j = 0; j < blocks.length; j++) {
        final id = blocks[j].toolId;
        if (blocks[j].type == "tool" && id != null) _toolIndex[id] = (i, j);
      }
    }
  }

  ChatMessage? _lastAssistant() {
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role == "assistant") return messages[i];
    }
    return null;
  }
}

// ---------- 小工具 ----------

String? _nonEmpty(Object? v) => v is String && v.isNotEmpty ? v : null;

int _genSeq = 0;
String _genId(String prefix) => "$prefix-${++_genSeq}";

bool _isToolItem(Map<String, dynamic> item) {
  final t = item["type"] as String? ?? "";
  return t == "command_execution" || t == "mcp_tool_call" || t == "custom_tool_call";
}

String _codexToolName(Map<String, dynamic> item) {
  final t = item["type"] as String? ?? "";
  if (t == "command_execution") return "shell";
  if (t == "mcp_tool_call") {
    final s = item["server"] as String? ?? "";
    final n = item["tool"] as String? ?? "";
    return s.isEmpty ? n : "mcp:$s.$n";
  }
  if (t == "custom_tool_call") return item["name"] as String? ?? "tool";
  return "tool";
}

String _codexToolBrief(Map<String, dynamic> item) {
  final t = item["type"] as String? ?? "";
  if (t == "command_execution") return item["command"] as String? ?? "";
  if (t == "mcp_tool_call") return _briefInput(item["arguments"]);
  if (t == "custom_tool_call") return _briefInput(item["input"]);
  return "";
}

String _codexToolResult(Map<String, dynamic> item) {
  final t = item["type"] as String? ?? "";
  if (t == "command_execution") {
    final out = item["aggregated_output"] as String? ?? "";
    final code = item["exit_code"];
    return code == null ? out : "$out\n(exit $code)";
  }
  if (t == "mcp_tool_call") {
    final err = item["error"];
    if (err != null) return err.toString();
    final res = item["result"];
    if (res is Map && res["content"] is List) {
      return (res["content"] as List)
          .map((c) => c is Map ? (c["text"] as String? ?? "") : "")
          .join("\n");
    }
    return "";
  }
  if (t == "custom_tool_call") return item["output"]?.toString() ?? "";
  return "";
}

/// 工具输入的一句话摘要(桌面端 `briefInput` 的精简版:取首个路径/命令类字段)。
String _briefInput(Object? input) {
  if (input == null) return "";
  if (input is String) return _truncate(input);
  if (input is! Map) return _truncate(input.toString());
  for (final key in const ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description"]) {
    final v = input[key];
    if (v is String && v.isNotEmpty) return _truncate(v);
  }
  final json = input.entries.map((e) => "${e.key}=${e.value}").join(", ");
  return _truncate(json);
}

String _flattenResult(Object? content) {
  if (content == null) return "";
  if (content is String) return content;
  if (content is List) {
    return content
        .map((c) => c is Map ? (c["text"] as String? ?? "") : c.toString())
        .join("\n");
  }
  return content.toString();
}

String _truncate(String s) {
  final oneLine = s.replaceAll("\n", " ");
  return oneLine.length <= 120 ? oneLine : "${oneLine.substring(0, 120)}…";
}
