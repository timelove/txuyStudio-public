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
/// 返回新桌面的 deviceId;用户取消/失败返回 null(失败已用 SnackBar 提示)。
/// 调用方负责重建主壳:HomeShell 的 key 带 desktopDeviceId,换凭证即换新 RelayClient。
Future<String?> switchDesktopDevice(
  BuildContext context, {
  required AccountSession session,
  required String currentDesktopId,
  required String displayName,
}) async {
  final messenger = ScaffoldMessenger.of(context);

  List<VaultEntry> entries;
  Map<String, DeviceInfo> devices = {};
  try {
    entries = await fetchVault(session);
    try {
      // 在线状态只作挑选参考(拿不到不挡切换)。
      devices = {for (final d in await fetchDevices(session)) d.deviceId: d};
    } catch (_) {}
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text("$e")));
    return null;
  }

  final others = entries.where((e) => e.deviceId != currentDesktopId).toList();
  if (others.isEmpty) {
    messenger.showSnackBar(
      const SnackBar(content: Text("该账号下没有别的电脑:请先在目标电脑的「设置 → 远程」用同一账号登录")),
    );
    return null;
  }

  if (!context.mounted) return null;
  final entry = others.length == 1
      ? others.first
      : await _pickDesktop(context, others, devices);
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

/// 挑一台桌面端(底部面板;多台才走这里)。列表与登录页共用 DeviceEntryList(✎ 打标签)。
Future<VaultEntry?> _pickDesktop(
  BuildContext context,
  List<VaultEntry> entries,
  Map<String, DeviceInfo> devices,
) {
  return showModalBottomSheet<VaultEntry>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    backgroundColor: Mx.surface,
    builder: (ctx) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 16),
        child: DeviceEntryList(
          entries: entries,
          devices: devices,
          heading: "切换电脑",
          description: "该账号下有多台电脑发布过保险箱,选择要连接的一台(✎ 可打标签方便分辨):",
          onPick: (e) => Navigator.pop(ctx, e),
        ),
      ),
    ),
  );
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
