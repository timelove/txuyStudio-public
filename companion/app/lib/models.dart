// 与桌面端 relay api.rs 返回结构逐字段对齐(camelCase,来源 system/commands.rs)。
// 协议契约:.work/design/20261023-mobile-relay/protocol-v1.md「业务帧」。

class TabInfo {
  final String id;
  final String kind;
  final String title;
  /// AI tab 运行态(桌面端 registry;projects.list 附带,旧桌面无此字段为 false)。
  /// started = 进程活着(claude 长进程启动后恒 true);busy = 正在对话。
  final bool started;
  final bool busy;
  TabInfo({required this.id, required this.kind, required this.title, this.started = false, this.busy = false});
  factory TabInfo.fromJson(Map<String, dynamic> j) => TabInfo(
      id: j["id"] ?? "", kind: j["kind"] ?? "", title: j["title"] ?? "",
      started: j["started"] == true, busy: j["busy"] == true);

  /// 是否 AI 对话 tab(手机端唯一支持远程输入的类型)。
  bool get isAi => kind == "claudepane" || kind == "claude" || kind == "codexpane" || kind == "codex";

  /// provider 名("claude" / "codex"),非 AI tab 为 null。
  String? get provider => switch (kind) {
        "claudepane" || "claude" => "claude",
        "codexpane" || "codex" => "codex",
        _ => null,
      };
}

/// 桌面端一个 pane(叶子)的结构视图:`projects.list` 的 `panes[]`。
///
/// 手机不模拟左右分割,只保留**分组与顺序**:`ratio` 是所在分屏里该 pane 占的比例
/// (%,整数),`split` 是该层分屏方向(只有每个分屏的首个 pane 带,避免重复显示)。
class PaneInfo {
  final String paneId;
  final int ratio;
  final String? split;
  final double? splitRatio;
  final String? activeTabId;
  final List<TabInfo> tabs;
  PaneInfo({
    required this.paneId,
    required this.ratio,
    this.split,
    this.splitRatio,
    this.activeTabId,
    required this.tabs,
  });

  factory PaneInfo.fromJson(Map<String, dynamic> j) => PaneInfo(
        paneId: j["paneId"] ?? "",
        ratio: (j["ratio"] as num?)?.toInt() ?? 0,
        split: j["split"] as String?,
        splitRatio: (j["splitRatio"] as num?)?.toDouble(),
        activeTabId: j["activeTabId"] as String?,
        tabs: (j["tabs"] as List<dynamic>? ?? []).map((e) => TabInfo.fromJson(e)).toList(),
      );

  /// 组内排序(手机端视角):busy > 在线(started)AI > 其余 AI > 非 AI;
  /// 同桶保持桌面端顺序(分桶拼接,不冒然 sort——Dart List.sort 不稳定)。
  List<TabInfo> get sortedTabs {
    final b0 = <TabInfo>[], b1 = <TabInfo>[], b2 = <TabInfo>[], b3 = <TabInfo>[];
    for (final t in tabs) {
      if (t.busy) {
        b0.add(t);
      } else if (t.isAi && t.started) {
        b1.add(t);
      } else if (t.isAi) {
        b2.add(t);
      } else {
        b3.add(t);
      }
    }
    return [...b0, ...b1, ...b2, ...b3];
  }

  bool get hasAi => tabs.any((t) => t.isAi);

  /// 含正在对话的 tab(pane 置顶排序第一优先级)。
  bool get hasBusy => tabs.any((t) => t.busy);

  /// 含在线 AI 会话(busy 或 started;pane 置顶排序第二优先级)。
  bool get hasLiveAi => tabs.any((t) => t.isAi && (t.busy || t.started));
}

class ProjectInfo {
  final String id;
  final String name;
  final String rootPath;
  final bool isActive;
  final List<TabInfo> tabs;
  final List<PaneInfo> panes;
  ProjectInfo({
    required this.id,
    required this.name,
    required this.rootPath,
    required this.isActive,
    required this.tabs,
    this.panes = const [],
  });
  factory ProjectInfo.fromJson(Map<String, dynamic> j) {
    final tabs = (j["tabs"] as List<dynamic>? ?? []).map((e) => TabInfo.fromJson(e)).toList();
    final rawPanes = j["panes"] as List<dynamic>? ?? const [];
    final panes = rawPanes.map((e) => PaneInfo.fromJson(e)).toList();
    return ProjectInfo(
      id: j["id"] ?? "",
      name: j["name"] ?? "",
      rootPath: j["rootPath"] ?? "",
      isActive: j["isActive"] == true,
      tabs: tabs,
      // 旧快照无 panes:退化成一个虚拟 pane(保证详情页仍能列出 tab)。
      panes: panes.isNotEmpty
          ? panes
          : (tabs.isEmpty ? const <PaneInfo>[] : [PaneInfo(paneId: "", ratio: 100, tabs: tabs)]),
    );
  }

  /// 第一个 AI tab(「继续上次对话」兜底用)。
  TabInfo? get firstAiTab {
    for (final p in panes) {
      for (final t in p.tabs) {
        if (t.isAi) return t;
      }
    }
    for (final t in tabs) {
      if (t.isAi) return t;
    }
    return null;
  }

  /// 有正在对话的 tab(项目级置顶排序第一优先级)。
  bool get hasBusyTab => tabs.any((t) => t.busy);

  /// 有在线 AI 会话(busy 或 started;项目级置顶排序第二优先级)。
  bool get hasLiveAiTab => tabs.any((t) => t.isAi && (t.busy || t.started));

  /// 「继续对话」目标:优先正在对话的 AI tab,次之在线(started)的,没有则第一个
  /// AI tab——手机上最想进的就是活跃会话,别让固定取首个把人带进冷会话。
  TabInfo? get resumeTab {
    for (final t in tabs) {
      if (t.isAi && t.busy) return t;
    }
    for (final t in tabs) {
      if (t.isAi && t.started) return t;
    }
    return firstAiTab;
  }
}

/// `chat.status` 结果。
class ChatStatus {
  final String provider;
  final bool started;
  final bool busy;
  final String status;
  final String? model;
  /// claude:`--effort` 当前值(null = auto);codex 恒 null。
  final String? effort;
  /// codex:`model_reasoning_effort` 当前值;claude 恒 null。
  final String? reasoningEffort;
  /// claude:`--permission-mode` 当前值(acceptEdits/plan/manual/bypassPermissions);
  /// codex 恒 null。启动 flag,手机快捷指令「当前档」显示用。
  final String? permissionMode;
  /// codex:最近一轮实际用的沙箱档(read-only/workspace-write/danger-full-access);
  /// claude 恒 null。
  final String? sandbox;
  /// codex:最近一轮实际用的权限档(ask-for-approval/approve-for-me/full-access/read-only);
  /// claude 恒 null。
  final String? permission;
  final String? sessionId;
  /// claude:后台任务快照(taskId/taskType/description;断线重连/进页补齐,
  /// 实时由 backgroundTasksChanged 事件推)。codex 恒空。
  final List<Map<String, String>> backgroundTasks;
  ChatStatus({
    required this.provider,
    required this.started,
    required this.busy,
    required this.status,
    this.model,
    this.effort,
    this.reasoningEffort,
    this.permissionMode,
    this.sandbox,
    this.permission,
    this.sessionId,
    this.backgroundTasks = const [],
  });
  factory ChatStatus.fromJson(Map<String, dynamic> j) => ChatStatus(
        provider: j["provider"] ?? "claude",
        started: j["started"] == true,
        busy: j["busy"] == true,
        status: j["status"] ?? "idle",
        model: j["model"],
        effort: j["effort"],
        reasoningEffort: j["reasoningEffort"],
        permissionMode: j["permissionMode"],
        sandbox: j["sandbox"],
        permission: j["permission"],
        sessionId: j["sessionId"],
        backgroundTasks: [
          for (final t in (j["backgroundTasks"] as List<dynamic>? ?? const []))
            if (t is Map)
              {
                "taskId": t["taskId"] as String? ?? "",
                "taskType": t["taskType"] as String? ?? "",
                "description": t["description"] as String? ?? "",
              },
        ],
      );
}


class UsageRollup {
  final String date;
  final String app;
  final String model;
  final int requests;
  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheCreationTokens;
  final int sessions;
  UsageRollup({
    required this.date, required this.app, required this.model, required this.requests,
    required this.inputTokens, required this.outputTokens, required this.cacheReadTokens,
    required this.cacheCreationTokens, required this.sessions,
  });
  factory UsageRollup.fromJson(Map<String, dynamic> j) => UsageRollup(
        date: j["date"] ?? "", app: j["app"] ?? "", model: j["model"] ?? "",
        requests: j["requests"] ?? 0, inputTokens: j["inputTokens"] ?? 0,
        outputTokens: j["outputTokens"] ?? 0, cacheReadTokens: j["cacheReadTokens"] ?? 0,
        cacheCreationTokens: j["cacheCreationTokens"] ?? 0, sessions: j["sessions"] ?? 0,
      );
  int get totalTokens => inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
}

class UsageSummary {
  final List<UsageRollup> rollups;
  final int claudeSessions;
  final int codexSessions;
  UsageSummary({required this.rollups, required this.claudeSessions, required this.codexSessions});
  factory UsageSummary.fromJson(Map<String, dynamic> j) => UsageSummary(
        rollups: (j["rollups"] as List<dynamic>? ?? []).map((e) => UsageRollup.fromJson(e)).toList(),
        claudeSessions: j["claudeSessions"] ?? 0,
        codexSessions: j["codexSessions"] ?? 0,
      );
}

class SessionItem {
  final String providerId;
  final String sessionId;
  final String? title;
  final String? startedAt;
  final String? lastAt;
  final int messageCount;
  final String? gitBranch;
  final String? cwd;
  SessionItem({
    required this.providerId, required this.sessionId, this.title, this.startedAt,
    this.lastAt, required this.messageCount, this.gitBranch, this.cwd,
  });
  factory SessionItem.fromJson(Map<String, dynamic> j) => SessionItem(
        providerId: j["providerId"] ?? "", sessionId: j["sessionId"] ?? "",
        title: j["title"], startedAt: j["startedAt"], lastAt: j["lastAt"],
        messageCount: j["messageCount"] ?? 0, gitBranch: j["gitBranch"], cwd: j["cwd"],
      );
}

/// 离线快照(桌面端上线即推,电脑离线时手机兜底可看)。
class DesktopSnapshot {
  final DateTime? generatedAt;
  final List<ProjectInfo> projects;
  final UsageSummary? usage;
  DesktopSnapshot({this.generatedAt, required this.projects, this.usage});
  factory DesktopSnapshot.fromJson(Map<String, dynamic> j) {
    // 快照里 projects 字段是 projects.list 的 result 包装({projects:[...]})或裸数组双口径。
    final rawProjects = j["projects"];
    List<dynamic> list = const [];
    if (rawProjects is List) {
      list = rawProjects;
    } else if (rawProjects is Map<String, dynamic> && rawProjects["projects"] is List) {
      list = rawProjects["projects"] as List<dynamic>;
    }
    return DesktopSnapshot(
      generatedAt: j["generatedAt"] == null ? null : DateTime.tryParse(j["generatedAt"]),
      projects: list.map((e) => ProjectInfo.fromJson(e)).toList(),
      usage: j["usage"] == null ? null : UsageSummary.fromJson(j["usage"]),
    );
  }
}
