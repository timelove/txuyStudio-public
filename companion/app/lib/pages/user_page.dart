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

/// 用户页(未来登录模块的落点)。
///
/// v1 只有**本地身份**:头像(显示名首字 + 品牌渐变底,不引图片依赖)、可改的显示名、
/// 中继 user id、本机设备 id、配对时间,以及一个「登录」占位入口。登录接上后,这里换成
/// 账号卡片 + 退出登录,其余区块(设备/连接)不动。
class UserPage extends StatefulWidget {
  final RelayClient client;
  final PairCredentials cred;
  final String selfId;
  final Future<void> Function() onUnpair;
  final Future<void> Function(UserProfile) onProfileChanged;
  /// 切换桌面端后重建主壳(重读凭证 → 新 RelayClient;main._boot 同一条路径)。
  final Future<void> Function() onSwitchDesktop;
  final UserProfile profile;
  final AppRelease? initialUpdate;

  const UserPage({
    super.key,
    required this.client,
    required this.cred,
    required this.selfId,
    required this.onUnpair,
    required this.onProfileChanged,
    required this.onSwitchDesktop,
    required this.profile,
    this.initialUpdate,
  });

  @override
  State<UserPage> createState() => _UserPageState();
}

class _UserPageState extends State<UserPage> {
  late UserProfile _profile = widget.profile;
  final AppUpdateService _updateService = AppUpdateService();
  late AppRelease? _update = widget.initialUpdate;
  bool _updateChecking = false;
  String? _appVersion;

  /// 桌面端主机名 + 版本(`pair.hello` 业务帧,连上后拉一次)。
  String? _hostName;
  String? _hostVersion;
  String? _deskLabel; // 当前电脑自定义标签(本机;「电脑」行展示优先)

  /// 账号登录会话(账号登录配对后存在;自助改密/退出登录用)。
  AccountSession? _account;

  @override
  void initState() {
    super.initState();
    _loadHost();
    _updateService.currentVersion().then((v) {
      if (mounted) setState(() => _appVersion = v);
    });
    DeviceLabelStore.loadAll().then((m) {
      if (mounted) setState(() => _deskLabel = m[widget.cred.desktopDeviceId]);
    });
    AccountStore.load().then((s) {
      if (mounted && s != null && !s.expired) setState(() => _account = s);
    });
  }

  Future<void> _loadHost() async {
    try {
      final resp = await widget.client.request("pair.hello");
      final r = (resp["result"] as Map?)?.cast<String, dynamic>();
      if (!mounted || r == null) return;
      setState(() {
        _hostName = r["name"] as String?;
        _hostVersion = r["version"] as String?;
      });
    } catch (_) {/* 离线时保持「未握手」 */}
  }

  Future<void> _checkUpdate() async {
    if (_updateChecking) return;
    setState(() => _updateChecking = true);
    try {
      final release = await _updateService.check();
      if (!mounted) return;
      setState(() => _update = release);
      if (release == null) {
        _toast("当前已是最新版本");
      } else {
        await _showUpdateDialog(release);
      }
    } catch (e) {
      if (mounted) _toast("检查更新失败:$e");
    } finally {
      if (mounted) setState(() => _updateChecking = false);
    }
  }

  Future<void> _showUpdateDialog(AppRelease release) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text("发现新版本 v${release.version}"),
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480, maxHeight: 420),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (release.publishedAt != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      "发布时间:${_fmtTime(release.publishedAt!)}",
                      style: const TextStyle(fontSize: 11, color: Mx.muted),
                    ),
                  ),
                SelectableText(
                  release.notes.trim().isEmpty ? "本次发布未提供更新说明。" : release.notes.trim(),
                  style: const TextStyle(fontSize: 12, height: 1.5, color: Mx.text),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("稍后再说")),
          FilledButton(
            onPressed: () {
              Navigator.pop(ctx);
              unawaited(_openDownload(release));
            },
            child: const Text("手动更新"),
          ),
        ],
      ),
    );
  }

  Future<void> _openDownload(AppRelease release) async {
    try {
      final ok = await _updateService.openDownload(release);
      if (!mounted || ok) return;
      _toast("无法打开下载页,请检查浏览器设置");
    } catch (e) {
      if (mounted) _toast("打开下载页失败:$e");
    }
  }

  Future<void> _rename() async {
    final ctrl = TextEditingController(text: _profile.displayName);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("显示名"),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 24,
          decoration: const InputDecoration(hintText: "例如:我的手机"),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("取消")),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, ctrl.text.trim()),
            child: const Text("保存"),
          ),
        ],
      ),
    );
    ctrl.dispose();
    if (name == null || name.isEmpty || !mounted) return;
    final next = _profile.copyWith(displayName: name);
    await UserStore.save(next);
    if (!mounted) return;
    setState(() => _profile = next);
    await widget.onProfileChanged(next);
  }

  /// 自助改密:旧/新/确认三输入;成功后用新密码**重发布保险箱**
  /// (手机端持有 pairKey,直接覆盖当前桌面的桶,新密码仍可免扫码配对)。
  /// 会话不吊销,当前连接不受影响。
  Future<void> _changePassword() async {
    final s = _account ?? await AccountStore.load();
    if (s == null || !mounted) return;
    final oldC = TextEditingController();
    final newC = TextEditingController();
    final newC2 = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("修改密码"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: oldC, obscureText: true,
              decoration: const InputDecoration(labelText: "当前密码", border: OutlineInputBorder(), isDense: true)),
            const SizedBox(height: 10),
            TextField(controller: newC, obscureText: true,
              decoration: const InputDecoration(labelText: "新密码(8~128 位,字母+数字)", border: OutlineInputBorder(), isDense: true)),
            const SizedBox(height: 10),
            TextField(controller: newC2, obscureText: true,
              decoration: const InputDecoration(labelText: "确认新密码", border: OutlineInputBorder(), isDense: true)),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认")),
        ],
      ),
    );
    // 先取值再 dispose(controller dispose 后 .text 不可读)。
    final oldPw = oldC.text, newPw = newC.text, newPw2 = newC2.text;
    oldC.dispose(); newC.dispose(); newC2.dispose();
    if (ok != true || !mounted) return;
    if (!isStrongPassword(newPw)) {
      _toast(weakPasswordTip);
      return;
    }
    if (newPw != newPw2) {
      _toast("两次输入的新密码不一致");
      return;
    }
    try {
      await relayChangePassword(s, oldPw, newPw);
      var msg = "密码已修改";
      try {
        await republishVaultWithNewPassword(s, widget.cred, newPw);
        msg += ",保险箱已用新密码重新加密";
      } catch (e) {
        msg += ";但保险箱重发布失败($e),下次自动配对需让电脑端重新登录";
      }
      _toast(msg);
    } catch (e) {
      _toast(e.toString());
    }
  }

  /// 退出登录:吊销会话(配对凭证的 token 同为此会话,一并失效)→ 清账号与配对凭证,
  /// 回登录页。桌面端不受影响,重新登录即恢复。
  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("退出登录?"),
        content: const Text("当前会话将被吊销,本机配对凭证一并清除,回到登录页(电脑端不受影响,重新登录即可恢复)。"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认")),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final s = _account ?? await AccountStore.load();
    await AccountStore.clear();
    // 吊销请求放后台(自带 5s 超时):断网时不能把用户卡在「确认」上等它跑完。
    if (s != null) unawaited(relayLogout(s));
    if (!mounted) return;
    // 根组件只是把 home 换成登录页,而「我的」页是 push 上来的路由,会压在新登录页
    // 上面 —— 不 pop 就是「退出登录没反应」。先弹回根路由再清凭证。
    Navigator.of(context).popUntil((r) => r.isFirst);
    await widget.onUnpair(); // 清凭证 → 回登录页
  }

  /// 切换电脑:同账号下多台电脑都往 vault 发布过配对凭证,这里重新拉保险箱
  /// 挑一台解密换凭证。流程与「更多 → 切换电脑」共用(relay/switch_desktop.dart);
  /// 登录时已经输过密码,本机内存里留着,切换不必再输。
  Future<void> _switchDesktop() async {
    final s = _account ?? await AccountStore.load();
    if (!mounted) return;
    if (s == null || s.expired) {
      _toast("登录会话缺失或已过期,请退出登录后重新登录");
      return;
    }
    final newId = await switchDesktopDevice(
      context,
      session: s,
      currentDesktopId: widget.cred.desktopDeviceId,
      displayName: _profile.displayName,
    );
    if (newId == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    await widget.onSwitchDesktop();
    if (!mounted) return;
    // 根组件重建的是主壳(HomeShell 带 key 会整体换新 State/新客户端),「我的」页
    // 是压在它上面的路由,不 pop 看不到切换结果。
    Navigator.of(context).popUntil((r) => r.isFirst);
    messenger.showSnackBar(SnackBar(
      content: Text("已切换到 $newId"),
      duration: const Duration(seconds: 3),
    ));
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg), duration: const Duration(seconds: 3)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("我的")),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
        children: [
          _identityCard(),
          const SizedBox(height: 12),
          _section('更新', [
            _actionTile(
              icon: _update == null ? Icons.system_update_alt : Icons.download,
              title: _updateChecking
                  ? '正在检查更新'
                  : _update == null
                      ? '检查更新'
                      : '下载新版本 v${_update!.version}',
              subtitle: _update == null
                  ? '当前 v${_appVersion ?? '...'} · 检查 GitHub Releases'
                  : (_update!.notes.trim().split('\n').first.isEmpty
                      ? '查看更新内容并手动安装'
                      : _update!.notes.trim().split('\n').first),
              color: _update == null ? Mx.accentBright : Mx.warning,
              onTap: _updateChecking ? () {} : _checkUpdate,
            ),
          ]),
          const SizedBox(height: 12),
          _section("配对", [
            if (_account != null)
              _kv("登录账号", "${_account!.username}${_account!.isAdmin ? "(管理员)" : ""}"),
            _kv("电脑", _deskLabel ?? _hostName ?? "未握手(离线)"),
            _kv("桌面端版本", _hostVersion ?? "—"),
            _kv("中继地址", widget.cred.url),
            _kv("中继用户", _profile.userId),
            _kv("本机设备", _profile.deviceId),
            if (_profile.pairedAt != null) _kv("配对时间", _fmtTime(_profile.pairedAt!)),
          ]),
          const SizedBox(height: 12),
          _section("会话", [
            _actionTile(
              icon: Icons.computer,
              title: "切换桌面端",
              subtitle: "多台电脑用同账号登录过时,挑一台连接",
              color: Mx.accentBright,
              onTap: _switchDesktop,
            ),
            _actionTile(
              icon: Icons.logout,
              title: "退出登录",
              subtitle: "吊销会话并清除本机凭证,回到登录页",
              color: Mx.danger,
              onTap: _logout,
            ),
          ]),
          const SizedBox(height: 16),
          Center(
            child: Text(
              "txuyStudio 移动伴侣 · v1.0.0",
              style: const TextStyle(fontSize: 11, color: Mx.faint),
            ),
          ),
        ],
      ),
    );
  }

  Widget _identityCard() {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Mx.card,
        borderRadius: BorderRadius.circular(Mx.radiusLg),
        border: Border.all(color: Mx.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(children: [
            // 头像:无图片依赖(Flutter 端只有 4 个包),统一用「首字 + 品牌渐变」。
            Container(
              width: 52,
              height: 52,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: Mx.brandGradient,
                borderRadius: BorderRadius.circular(Mx.radiusLg),
              ),
              child: Text(
                _profile.initial,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                  color: Mx.accentContrast,
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(children: [
                    Flexible(
                      child: Text(
                        _profile.displayName,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w600, color: Mx.textBright),
                      ),
                    ),
                    const SizedBox(width: 6),
                    IconButton(
                      visualDensity: VisualDensity.compact,
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(minWidth: 26, minHeight: 26),
                      icon: const Icon(Icons.edit_outlined, size: 14, color: Mx.faint),
                      tooltip: "改显示名",
                      onPressed: _rename,
                    ),
                  ]),
                  const SizedBox(height: 4),
                  Row(children: [
                    _chip(
                      _profile.loggedIn ? "已登录" : "本地身份",
                      _profile.loggedIn ? Mx.success : Mx.muted,
                      _profile.loggedIn ? Mx.successSoft : Mx.cardInner,
                    ),
                    const SizedBox(width: 6),
                    _chip("仅本机可信", Mx.violet, Mx.violetSoft),
                  ]),
                ],
              ),
            ),
          ]),
          const SizedBox(height: 12),
          if (_account != null)
            // 账号登录态:改密入口(改密不吊销会话,连接不断;保险箱自动换新密码重加密)。
            OutlinedButton.icon(
              onPressed: _changePassword,
              icon: const Icon(Icons.password, size: 15),
              label: Text("修改密码", style: const TextStyle(fontSize: 12)),
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 36)),
            )
          else
            OutlinedButton.icon(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text("本地身份"),
                  content: const Text(
                    "当前是本地身份(未账号登录)。账号登录在登录页入口"
                    "(退出登录后可见),登录后手机与电脑用同一账号,改密/换机都更省事。",
                  ),
                  actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text("知道了"))],
                ),
              ),
              icon: const Icon(Icons.info_outline, size: 15),
              label: const Text("账号登录说明", style: TextStyle(fontSize: 12)),
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 36)),
            ),
        ],
      ),
    );
  }

  Widget _chip(String label, Color fg, Color bg) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(Mx.radiusSm),
          border: Border.all(color: Mx.borderSoft),
        ),
        child: Text(label, style: TextStyle(fontSize: 10, color: fg, fontWeight: FontWeight.w600)),
      );

  Widget _section(String title, List<Widget> children) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 0, 4, 6),
            child: Text(title,
                style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: Mx.dim)),
          ),
          Container(
            decoration: BoxDecoration(
              color: Mx.card,
              borderRadius: BorderRadius.circular(Mx.radiusLg),
              border: Border.all(color: Mx.border),
            ),
            child: Column(children: children),
          ),
        ],
      );

  Widget _kv(String k, String v) => Padding(
        padding: const EdgeInsets.fromLTRB(14, 9, 14, 9),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(
            width: 70,
            child: Text(k, style: const TextStyle(fontSize: 12, color: Mx.muted)),
          ),
          Expanded(
            child: SelectableText(
              v,
              style: const TextStyle(fontSize: 12, color: Mx.text, fontFamily: "monospace"),
            ),
          ),
        ]),
      );

  Widget _actionTile({
    required IconData icon,
    required String title,
    required String subtitle,
    required Color color,
    required VoidCallback onTap,
  }) =>
      InkWell(
        borderRadius: BorderRadius.circular(Mx.radiusLg),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          child: Row(children: [
            Icon(icon, size: 17, color: color),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(title,
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: color)),
                  Text(subtitle, style: const TextStyle(fontSize: 11, color: Mx.muted)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, size: 16, color: Mx.faint),
          ]),
        ),
      );

  static String _fmtTime(DateTime t) {
    String two(int v) => v.toString().padLeft(2, "0");
    return "${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}";
  }
}
