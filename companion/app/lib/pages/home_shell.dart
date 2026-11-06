import 'dart:async';

import 'package:flutter/material.dart';

import '../app_update.dart';
import '../relay/account.dart';
import '../relay/client.dart';
import '../relay/credentials.dart';
import '../relay/device_labels.dart';
import '../relay/switch_desktop.dart';
import '../theme.dart';
import '../user/profile.dart';
import 'admin_page.dart';
import 'messages_page.dart';
import 'projects_page.dart';
import 'usage_page.dart';
import 'sessions_page.dart';
import 'user_page.dart';

/// 主壳:底部导航三页(项目/用量/会话)+ 顶栏「左头像 / 右更多」。
///
/// 用户模块的容器也在这里:**左上角头像**进用户页(后续登录落点),**右上角更多**收拢
/// 一切「非导航」的东西(连接状态、重连、信息介绍、关于、退出登录)——顶栏只留两个入口,
/// 后续加配置项就往这个菜单里塞,不再挤占标题栏。
class HomeShell extends StatefulWidget {
  final PairCredentials cred;
  final String selfId;
  final Future<void> Function() onUnpair;
  /// 配对凭证变了(用户页切换桌面端)→ 重读凭证重建主壳与新 RelayClient。
  final Future<void> Function() onCredentialsChanged;
  final RelayClient Function() clientBuilder;

  const HomeShell({
    super.key,
    required this.cred,
    required this.selfId,
    required this.onUnpair,
    required this.onCredentialsChanged,
    required this.clientBuilder,
  });

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> with WidgetsBindingObserver {
  late final RelayClient _client;
  int _index = 0;
  UserProfile? _profile;
  final AppUpdateService _updateService = AppUpdateService();
  AppRelease? _update;
  AccountSession? _account; // 登录会话(isAdmin → 更多菜单出现「用户管理」)
  String? _hostName; // 当前连的电脑名(pair.hello,「更多」菜单里展示)
  String? _deskLabel; // 当前电脑的自定义标签(本机;展示优先于 hostName)

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _client = widget.clientBuilder();
    _client.connect();
    _loadProfile();
    _loadHost();
    _checkAppUpdate();
    DeviceLabelStore.loadAll().then((m) {
      if (mounted) setState(() => _deskLabel = m[widget.cred.desktopDeviceId]);
    });
    AccountStore.load().then((s) {
      if (mounted && s != null && !s.expired) setState(() => _account = s);
    });
  }

  /// 当前电脑名:握手业务帧,离线/超时不显示(菜单回退到 deviceId)。
  Future<void> _loadHost() async {
    try {
      final resp = await _client.request("pair.hello");
      final r = (resp["result"] as Map?)?.cast<String, dynamic>();
      final name = r?["name"];
      if (mounted && name is String && name.isNotEmpty) setState(() => _hostName = name);
    } catch (_) {/* 离线:回退 deviceId */}
  }

  /// 启动时检查 GitHub Releases;有新版本立即弹更新说明,失败静默避免干扰连接。
  Future<void> _checkAppUpdate() async {
    try {
      final release = await _updateService.check();
      if (!mounted || release == null) return;
      setState(() => _update = release);
      await showAppUpdateDialog(context, release, _updateService);
    } catch (_) {
      // 更新源不可达时不打断主流程;用户仍可在“我的”页手动检查。
    }
  }

  /// 用户资料:身份锚点(userId/deviceId)来自配对,展示层来自本地存储。
  Future<void> _loadProfile() async {
    final p = await UserStore.load(userId: widget.cred.userId, deviceId: widget.selfId);
    if (mounted) setState(() => _profile = p);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _client.dispose();
    super.dispose();
  }

  /// 页面从后台回到前台:浏览器会节流甚至冻结后台标签页的定时器,ping 停了中继
  /// 会按 90s 静默超时踢连接。回来后立刻重连,别让用户盯着「离线」等 5s 退避。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _client.state != RelayConnState.online) {
      _client.reconnectNow();
    }
  }

  Future<void> _openUserPage() async {
    final profile = _profile ??
        await UserStore.load(userId: widget.cred.userId, deviceId: widget.selfId);
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => UserPage(
        client: _client,
        cred: widget.cred,
        selfId: widget.selfId,
        profile: profile,
        initialUpdate: _update,
        onUnpair: widget.onUnpair,
        onSwitchDesktop: () => widget.onCredentialsChanged(),
        onProfileChanged: (p) async {
          if (mounted) setState(() => _profile = p);
        },
      ),
    ));
  }

  /// 用户管理(仅管理员;会话过期则引导重新登录)。
  Future<void> _openAdmin() async {
    final s = _account;
    if (s == null) return;
    if (s.expired) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("登录会话已过期,请退出登录后重新登录")),
      );
      return;
    }
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => AdminPage(session: s)));
  }

  /// 切换电脑:不必退出登录——解目标电脑的保险箱换凭证,根组件按新 deviceId 换新
  /// 主壳与 RelayClient(见 main.dart 的 HomeShell key)。
  Future<void> _switchDesktop() async {
    final s = _account ?? await AccountStore.load();
    if (!mounted) return;
    if (s == null || s.expired) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("登录会话缺失或已过期,请重新登录")),
      );
      return;
    }
    final newId = await switchDesktopDevice(
      context,
      session: s,
      currentDesktopId: widget.cred.desktopDeviceId,
      displayName: _profile?.displayName ?? s.username,
    );
    if (newId == null || !mounted) return;
    await widget.onCredentialsChanged();
  }

  /// 退出登录:吊销会话(配对凭证的 token 同为此会话,一并失效)→ 清账号与凭证回登录页。
  /// 与 user_page 的退出登录同一语义;桌面端不受影响,重新登录即恢复。
  Future<void> _confirmLogout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("退出登录?"),
        content: const Text("当前会话将被吊销,本机配对凭证一并清除,回到登录页(电脑端不受影响)。"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认")),
        ],
      ),
    );
    if (ok != true) return;
    final s = await AccountStore.load();
    await AccountStore.clear();
    // 本地先退、吊销后台跑(请求自带 5s 超时);断网时不能卡住回登录页。
    if (s != null) unawaited(relayLogout(s));
    await widget.onUnpair(); // 清凭证 → 回登录页
  }

  void _showIntro() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: Mx.surface,
      builder: (ctx) => const _IntroSheet(),
    );
  }

  /// 「关于」:应用信息 + 手动检查更新入口(2026-11-05 用户要求)。showAboutDialog
  /// 不支持自定义 actions,换自定义 AlertDialog;版本号取自 package_info(原为硬编码)。
  Future<void> _showAbout() async {
    String version = "";
    try {
      version = await _updateService.currentVersion();
    } catch (_) {}
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Row(children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              gradient: Mx.brandGradient,
              borderRadius: BorderRadius.circular(9),
            ),
          ),
          const SizedBox(width: 10),
          const Expanded(child: Text("txuyStudio 移动伴侣")),
        ]),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(version.isEmpty ? "版本未知" : "版本 v$version",
                style: const TextStyle(fontSize: 12, color: Mx.muted)),
            const SizedBox(height: 10),
            const Text(
              "这是 txuyStudio 的手机端。电脑上的 Claude / Codex 对话、项目与用量,"
              "经你自己的中继端到端加密转发到这里;数据始终留在你那台电脑上,没有云端副本。",
              style: TextStyle(fontSize: 12, height: 1.5),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => _checkUpdateFromAbout(ctx), child: const Text("检查更新")),
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭")),
        ],
      ),
    );
  }

  /// 关于弹窗里的手动检查更新:有新版关弹窗直接展示更新说明;已是最新 toast 提示。
  Future<void> _checkUpdateFromAbout(BuildContext dialogCtx) async {
    try {
      final release = await _updateService.check();
      if (!mounted) return;
      if (dialogCtx.mounted) Navigator.pop(dialogCtx);
      if (release != null) {
        setState(() => _update = release);
        await showAppUpdateDialog(context, release, _updateService);
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("当前已是最新版本")),
        );
      }
    } catch (_) {
      if (!mounted) return;
      if (dialogCtx.mounted) Navigator.pop(dialogCtx);
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("检查更新失败,请稍后重试")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      MessagesPage(client: _client),
      ProjectsPage(client: _client),
      UsagePage(client: _client, active: _index == 2),
      SessionsPage(client: _client),
    ];
    return Scaffold(
      appBar: AppBar(
        leadingWidth: 56,
        leading: _avatarButton(),
        title: const Text("txuyStudio"),
        actions: [_statusDot(), _moreButton()],
      ),
      // 断线时在内容上方给一条「为什么掉」的横幅:lastError 之前只写不显示,
      // 出问题只能靠猜。
      body: StreamBuilder<RelayConnState>(
        stream: _client.stateStream,
        initialData: _client.state,
        builder: (context, snap) {
          final st = snap.data ?? RelayConnState.disconnected;
          return Column(children: [
            if (st == RelayConnState.disconnected)
              Container(
                width: double.infinity,
                color: Mx.warningSoft,
                padding: const EdgeInsets.fromLTRB(12, 7, 8, 7),
                child: Row(children: [
                  const Icon(Icons.cloud_off, size: 14, color: Mx.warning),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      "未连接：${_client.lastError ?? "正在重试"}",
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, height: 1.35, color: Mx.warning),
                    ),
                  ),
                  TextButton(
                    onPressed: _client.reconnectNow,
                    style: TextButton.styleFrom(
                      minimumSize: const Size(0, 30),
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      foregroundColor: Mx.accentBright,
                    ),
                    child: const Text("重连", style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                  ),
                ]),
              ),
            Expanded(child: IndexedStack(index: _index, children: pages)),
          ]);
        },
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), selectedIcon: Icon(Icons.chat_bubble), label: "消息"),
          NavigationDestination(icon: Icon(Icons.folder_outlined), selectedIcon: Icon(Icons.folder), label: "项目"),
          NavigationDestination(icon: Icon(Icons.bar_chart_outlined), selectedIcon: Icon(Icons.bar_chart), label: "用量"),
          NavigationDestination(icon: Icon(Icons.forum_outlined), selectedIcon: Icon(Icons.forum), label: "会话"),
        ],
      ),
    );
  }

  /// 左上角头像:首字 + 品牌渐变(无图片依赖,不引网络头像)。
  Widget _avatarButton() {
    final initial = _profile?.initial ?? "?";
    return Center(
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: _openUserPage,
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              gradient: Mx.brandGradient,
              shape: BoxShape.circle,
              border: Border.all(color: Mx.selectedBorder),
            ),
            child: Text(
              initial,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.bold,
                color: Mx.accentContrast,
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 顶栏连接状态点(完整文案收进「更多」菜单,这里只留颜色)。
  Widget _statusDot() {
    return StreamBuilder<RelayConnState>(
      stream: _client.stateStream,
      initialData: _client.state,
      builder: (context, snap) {
        final s = snap.data ?? RelayConnState.disconnected;
        final color = switch (s) {
          RelayConnState.online => Mx.success,
          RelayConnState.connecting => Mx.warning,
          RelayConnState.disconnected => Mx.danger,
        };
        return Center(
          child: Padding(
            padding: const EdgeInsets.only(right: 2),
            child: Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
          ),
        );
      },
    );
  }

  /// 右上角「更多」:连接状态 / 重连 / 信息介绍 / 关于 / 退出登录。
  /// 后续加配置项只往这里追加,不动顶栏结构。
  Widget _moreButton() {
    return StreamBuilder<RelayConnState>(
      stream: _client.stateStream,
      initialData: _client.state,
      builder: (context, snap) {
        final s = snap.data ?? RelayConnState.disconnected;
        final (color, label) = switch (s) {
          RelayConnState.online => (Mx.success, "在线"),
          RelayConnState.connecting => (Mx.warning, "连接中"),
          RelayConnState.disconnected => (Mx.danger, "离线"),
        };
        return PopupMenuButton<String>(
          icon: const Icon(Icons.more_horiz, size: 20),
          tooltip: "更多",
          color: Mx.surface,
          onSelected: (v) {
            switch (v) {
              case "reconnect":
                _client.reconnectNow();
              case "user":
                _openUserPage();
              case "switchpc":
                _switchDesktop();
              case "admin":
                _openAdmin();
              case "intro":
                _showIntro();
              case "about":
                _showAbout();
              case "unpair":
                _confirmLogout();
            }
          },
          itemBuilder: (ctx) => [
            // 状态行:不可点,只作信息展示(带颜色圆点)。
            PopupMenuItem<String>(
              enabled: false,
              height: 34,
              child: Row(children: [
                Container(width: 7, height: 7, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
                const SizedBox(width: 7),
                Text("连接状态 · $label",
                    style: const TextStyle(fontSize: 12, color: Mx.muted, fontWeight: FontWeight.w600)),
              ]),
            ),
            const PopupMenuDivider(),
            // 已连接不显示重连入口(自动保活);仅离线时给手动触发(断线横幅也有)。
            if (_client.state != RelayConnState.online)
              const PopupMenuItem(
                value: "reconnect",
                height: 40,
                child: _MenuRow(icon: Icons.refresh, label: "立即重连"),
              ),
            if (_account != null)
              PopupMenuItem(
                value: "switchpc",
                height: 40,
                child: _MenuRow(
                  icon: Icons.desktop_windows_outlined,
                  label: "切换电脑",
                  // 标签(自己起的)优先于机器名,都没有退 deviceId。
                  hint: _deskLabel ?? _hostName ?? widget.cred.desktopDeviceId,
                ),
              ),
            if (_account?.isAdmin == true)
              const PopupMenuItem(
                value: "admin",
                height: 40,
                child: _MenuRow(icon: Icons.manage_accounts, label: "用户管理"),
              ),
            const PopupMenuItem(
              value: "user",
              height: 40,
              child: _MenuRow(icon: Icons.person_outline, label: "我的账号"),
            ),
            const PopupMenuItem(
              value: "intro",
              height: 40,
              child: _MenuRow(icon: Icons.info_outline, label: "信息介绍"),
            ),
            const PopupMenuItem(
              value: "about",
              height: 40,
              child: _MenuRow(icon: Icons.help_outline, label: "关于"),
            ),
            const PopupMenuDivider(),
            const PopupMenuItem(
              value: "unpair",
              height: 40,
              child: _MenuRow(icon: Icons.logout, label: "退出登录", color: Mx.danger),
            ),
          ],
        );
      },
    );
  }
}

class _MenuRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  /// 右侧灰色小字(如「切换电脑」当前连的是哪台)。
  final String? hint;
  const _MenuRow({required this.icon, required this.label, this.color = Mx.text, this.hint});

  @override
  Widget build(BuildContext context) {
    return Row(children: [
      Icon(icon, size: 16, color: color == Mx.text ? Mx.muted : color),
      const SizedBox(width: 10),
      Expanded(child: Text(label, style: TextStyle(fontSize: 13, color: color))),
      if (hint != null)
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 120),
          child: Text(
            hint!,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 10, fontFamily: "monospace", color: Mx.faint),
          ),
        ),
    ]);
  }
}

/// 「信息介绍」:手机端到底能做什么、不能做什么(与设计文档「已知取舍」对齐)。
class _IntroSheet extends StatelessWidget {
  const _IntroSheet();

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text("这是什么",
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Mx.textBright)),
            const SizedBox(height: 8),
            const Text(
              "txuyStudio 的手机端遥控器。它不跑 AI,也不存对话——只是把电脑上那台 "
              "Claude / Codex 会话的第二个视图搬到你手里。",
              style: TextStyle(fontSize: 12, height: 1.55, color: Mx.text),
            ),
            const SizedBox(height: 12),
            _line(Icons.check_circle_outline, Mx.success, "能做", "看项目与分屏、发消息、批准工具调用、切模型/压缩上下文、看 shell 输出。"),
            const SizedBox(height: 6),
            _line(Icons.do_not_disturb_on_outlined, Mx.danger, "不能做", "往终端敲命令、新建/关闭桌面端 pane、离线时发消息。"),
            const SizedBox(height: 12),
            const Text(
              "中继只做端到端加密的转发,消息内容它解不开;数据始终在你那台电脑上。",
              style: TextStyle(fontSize: 11, height: 1.5, color: Mx.muted),
            ),
          ],
        ),
      ),
    );
  }

  Widget _line(IconData icon, Color color, String title, String body) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 14, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: RichText(
              text: TextSpan(
                style: const TextStyle(fontSize: 12, height: 1.5, color: Mx.text),
                children: [
                  TextSpan(
                      text: "$title:",
                      style: TextStyle(fontWeight: FontWeight.w600, color: color)),
                  TextSpan(text: " $body"),
                ],
              ),
            ),
          ),
        ],
      );
}
