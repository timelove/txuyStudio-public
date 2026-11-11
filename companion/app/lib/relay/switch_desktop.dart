import 'package:flutter/material.dart';

import '../theme.dart';
import '../user/profile.dart';
import '../widgets/device_entry_list.dart';
import 'account.dart';
import 'credentials.dart';

/// 切换电脑(桌面端)的公共流程:**任意位置可调**,不必退出登录。
///
/// 与登录页的自动配对同一条路径:拉保险箱(vault)→ 挑一台 → 用账号密码解密出
/// `{pairKey, deviceId}` → 覆盖本机配对凭证 + 用户资料锚点。E2E 密钥按桌面端
/// 一对一点对点,所以「切换」= 换凭证重连,不是同时连多台。
///
/// 密码优先用 [AccountStore.sessionPassword](登录时输入的,仅内存),没有才弹框;
/// 内存密码解不开(桌面端改过密码)会清掉缓存再问一次。
///
/// 返回新桌面的 deviceId;用户取消/失败返回 null(失败在面板内提示,可重试)。
/// 调用方负责重建主壳:HomeShell 的 key 带 desktopDeviceId,换凭证即换新 RelayClient。
Future<String?> switchDesktopDevice(
  BuildContext context, {
  required AccountSession session,
  required String currentDesktopId,
  required String displayName,
}) async {
  // 点击立即弹面板(内含加载/错误/重试):拉 vault+devices 是两次公网 HTTP
  // round-trip,可达数十秒——先弹后拉,页面不能像没点上一样干等(2026-11-10)。
  if (!context.mounted) return null;
  final entry = await _pickDesktopSheet(context, session, currentDesktopId);
  if (entry == null || !context.mounted) return null;

  final cred = await _unlock(context, entry, session);
  if (cred == null || !context.mounted) return null;

  await CredentialStore.save(cred);
  // 身份锚点跟着新电脑走(deviceId = 「连的哪台电脑」);显示名保留。
  await UserStore.save(UserProfile(
    userId: cred.userId,
    deviceId: await CredentialStore.selfDeviceId(),
    displayName: displayName,
    loginKind: "account",
    pairedAt: DateTime.now(),
  ));
  return entry.deviceId;
}

/// 挑一台桌面端(底部面板)。列表与登录页共用 DeviceEntryList(✎ 打标签);
/// **全量设备**(含当前连接的,打「当前」徽标)——只列「别的」会让单电脑用户
/// 看到空列表误以为功能坏了(2026-11-10 实测反馈)。
Future<VaultEntry?> _pickDesktopSheet(
  BuildContext context,
  AccountSession session,
  String currentDesktopId,
) {
  return showModalBottomSheet<VaultEntry>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    backgroundColor: Mx.surface,
    builder: (ctx) => SafeArea(
      child: _DesktopPicker(session: session, currentDesktopId: currentDesktopId),
    ),
  );
}

/// 面板内自管加载态:转圈 → 设备列表;失败就地显示错误 + 重试按钮(不闪退面板)。
class _DesktopPicker extends StatefulWidget {
  final AccountSession session;
  final String currentDesktopId;
  const _DesktopPicker({required this.session, required this.currentDesktopId});

  @override
  State<_DesktopPicker> createState() => _DesktopPickerState();
}

class _DesktopPickerState extends State<_DesktopPicker> {
  List<VaultEntry>? _entries;
  Map<String, DeviceInfo> _devices = const {};
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final entries = await fetchVault(widget.session);
      // 在线状态只作挑选参考(拿不到不挡切换)。
      Map<String, DeviceInfo> devices = const {};
      try {
        devices = {for (final d in await fetchDevices(widget.session)) d.deviceId: d};
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _devices = devices;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = "$e";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 16),
      child: Builder(builder: (ctx) {
        if (_loading) {
          return const Padding(
            padding: EdgeInsets.symmetric(vertical: 36),
            child: Center(
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 1.8),
                ),
                SizedBox(width: 10),
                Text("正在读取保险箱…", style: TextStyle(fontSize: 12, color: Mx.muted)),
              ]),
            ),
          );
        }
        final entries = _entries;
        if (entries == null) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text("读取保险箱失败:$_error",
                    style: const TextStyle(fontSize: 12, color: Mx.danger)),
                const SizedBox(height: 10),
                OutlinedButton(onPressed: _load, child: const Text("重试")),
              ],
            ),
          );
        }
        final others = entries.where((e) => e.deviceId != widget.currentDesktopId).toList();
        final hasCurrent = entries.any((e) => e.deviceId == widget.currentDesktopId);
        final description = others.isEmpty
            ? (hasCurrent
                ? "该账号下目前只有这一台电脑。新的电脑在「设置 → 远程」用同一账号登录后,会出现在这里。"
                : "该账号下还没有已配对的电脑:请先在目标电脑的「设置 → 远程」用同一账号登录。")
            : "选择要连接的一台(✎ 可打标签方便分辨);标「当前」的是正在使用的电脑。";
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DeviceEntryList(
              entries: entries,
              devices: _devices,
              heading: "切换电脑",
              description: description,
              currentDeviceId: widget.currentDesktopId,
              onPick: (e) {
                // 当前电脑不可重选(点了也只是重解密重连同一台,没有意义)。
                if (e.deviceId == widget.currentDesktopId) {
                  ScaffoldMessenger.of(context).hideCurrentSnackBar();
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text("正在使用这台电脑;切换请在列表里选另一台")),
                  );
                  return;
                }
                Navigator.pop(ctx, e);
              },
            ),
            // 诊断行(2026-11-10):保险箱条数 = 中继侧该账号下已发布的桌面数;
            // 在线设备数 = /devices 口径。两台电脑都登录后这里只显示 1 条,说明第二台的
            // vault 没发布成功(电脑端「设置 → 远程」登录结果里有失败提示)。
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 4),
              child: Text(
                "保险箱 ${entries.length} 条 · 设备 ${_devices.length} 台 · 当前 ${widget.currentDesktopId}",
                style: const TextStyle(fontSize: 10, color: Mx.faint),
              ),
            ),
          ],
        );
      }),
    );
  }
}

/// 用账号密码解密 vault 条目。密码来源:本次会话缓存 → 弹框;解密失败清缓存重问一次。
Future<PairCredentials?> _unlock(
  BuildContext context,
  VaultEntry entry,
  AccountSession session,
) async {
  var pass = AccountStore.sessionPassword;
  for (var attempt = 0; attempt < 2; attempt++) {
    if (pass == null || pass.isEmpty) {
      if (!context.mounted) return null;
      pass = await _askPassword(context);
      if (pass == null) return null;
    }
    try {
      final cred = await openVaultEntry(entry, session, pass);
      // 能解开就记住(仅内存),下次切换不再问。
      AccountStore.sessionPassword = pass;
      return cred;
    } catch (_) {
      // 缓存密码失效(电脑端改过密码)→ 清掉再问一次。
      AccountStore.sessionPassword = null;
      pass = null;
      if (attempt == 1) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text("解密失败:密码不正确,或电脑端改过密码(请在电脑端重新登录后再试)"),
          ));
        }
        return null;
      }
    }
  }
  return null;
}

Future<String?> _askPassword(BuildContext context) async {
  final ctrl = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text("需要账号密码"),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text("保险箱密钥由账号密码派生,本机不保存,切换电脑时需要解密一次。",
              style: TextStyle(fontSize: 12, color: Mx.muted)),
          const SizedBox(height: 10),
          TextField(
            controller: ctrl,
            obscureText: true,
            autofocus: true,
            onSubmitted: (_) => Navigator.pop(ctx, true),
            decoration: const InputDecoration(labelText: "账号密码", border: OutlineInputBorder(), isDense: true),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("切换")),
      ],
    ),
  );
  final pass = ctrl.text;
  ctrl.dispose();
  if (ok != true) return null;
  return pass.isEmpty ? null : pass;
}
