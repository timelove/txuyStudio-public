// 账号登录页(v4 首屏,App 风格):账号密码 → 登录(client=mobile)→ 拉密码保险箱
// (vault)→ 解密 pairKey → 配对凭证。中继地址默认用 [defaultRelayUrl](线上),
// 仅测试需要自定义地址:「测试模式」入口展开输入框。
//
// vault 空 = 桌面端还没用同账号登录过(桌面端登录时自动发布 pairKey 密文包)
// → 引导稍后重试;多桌面 = 列表挑选(带在线状态)。

import 'dart:async';

import 'package:flutter/material.dart';

import '../relay/account.dart';
import '../relay/credentials.dart';
import '../theme.dart';
import '../user/profile.dart';
import '../widgets/device_entry_list.dart';

class LoginScreen extends StatefulWidget {
  final Future<void> Function() onPaired;
  const LoginScreen({super.key, required this.onPaired});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

enum _Stage { form, working, picking }

class _LoginScreenState extends State<LoginScreen> {
  final _url = TextEditingController();
  final _user = TextEditingController();
  final _pass = TextEditingController();
  bool _obscure = true;
  bool _testMode = false; // 展开自定义中继地址输入(默认线上地址;无默认/无历史时自动展开)
  String? _error;
  String? _hint; // 非阻断提示(vault 未发布等)
  _Stage _stage = _Stage.form;
  AccountSession? _session;
  List<VaultEntry> _entries = const [];
  Map<String, DeviceInfo> _devices = const {};

  Timer? _urlSaveDebounce;

  @override
  void initState() {
    super.initState();
    // 地址默认线上;没有线上默认(测试期)时退上次使用过的中继地址(输入即存,
    // 登录失败也不丢),再没有则展开测试模式让用户自填。
    AccountStore.load().then((s) async {
      if (!mounted) return;
      final lastUrl = defaultRelayUrl.isNotEmpty ? defaultRelayUrl : await AccountStore.lastRelayUrl();
      if (!mounted) return;
      setState(() {
        if (lastUrl.isNotEmpty) {
          _url.text = lastUrl;
        } else {
          _testMode = true;
        }
        if (s != null) _user.text = s.username;
      });
    });
    // 输入即自动保存(防抖 500ms):改完地址不用点登录,下次打开 app 还在。
    _url.addListener(() {
      final v = _url.text.trim();
      if (v.isEmpty) return;
      _urlSaveDebounce?.cancel();
      _urlSaveDebounce = Timer(const Duration(milliseconds: 500), () => AccountStore.saveRelayUrl(v));
    });
  }

  @override
  void dispose() {
    _urlSaveDebounce?.cancel();
    _url.dispose();
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    final url = _url.text.trim();
    final user = _user.text.trim();
    final pass = _pass.text;
    if (url.isEmpty) {
      setState(() {
        _testMode = true; // 地址必填还空着:展开输入框引导填写
        _error = "请填写中继地址(测试期为必填项,填你部署的中继服务地址)";
      });
      return;
    }
    if (user.isEmpty || pass.isEmpty) {
      setState(() => _error = "请填写账号与密码");
      return;
    }
    setState(() {
      _stage = _Stage.working;
      _error = null;
      _hint = null;
    });
    try {
      final session = await relayLogin(url, user, pass);
      await AccountStore.save(session);
      // 本次会话记住密码(仅内存):之后「切换电脑」解保险箱不用再输。
      AccountStore.sessionPassword = pass;
      if (!mounted) return;
      setState(() => _session = session);
      await _loadVault(session, pass);
    } on TimeoutException {
      setState(() {
        _stage = _Stage.form;
        _error = "连接中继超时,请检查地址与网络";
      });
    } catch (e) {
      setState(() {
        _stage = _Stage.form;
        _error = e.toString();
      });
    }
  }

  Future<void> _loadVault(AccountSession session, String pass) async {
    try {
      final entries = await fetchVault(session);
      if (!mounted) return;
      // 在线状态只作挑选参考(拿不到不阻断)。
      Map<String, DeviceInfo> devices = {};
      try {
        devices = {for (final d in await fetchDevices(session)) d.deviceId: d};
      } catch (_) {}
      if (entries.isEmpty) {
        setState(() {
          _stage = _Stage.form;
          _hint = "登录成功,但桌面端还未用此账号登录过。请先在电脑端「设置 → 远程」登录(会自动发布保险箱),然后回来重试。";
        });
        return;
      }
      if (entries.length == 1) {
        await _openEntry(entries.first, pass);
        return;
      }
      setState(() {
        _entries = entries;
        _devices = devices;
        _stage = _Stage.picking;
      });
    } catch (e) {
      setState(() {
        _stage = _Stage.form;
        _error = e.toString();
      });
    }
  }

  /// 解密选中条目 → 保存凭证 + 账号化用户资料 → onPaired。
  Future<void> _openEntry(VaultEntry e, String pass) async {
    try {
      final cred = await openVaultEntry(e, _session!, pass);
      await CredentialStore.save(cred);
      // 用户资料升级 account 态(展示层;锚点仍现取防串台)。
      await UserStore.save(UserProfile(
        userId: _session!.userId,
        deviceId: await CredentialStore.selfDeviceId(),
        displayName: _session!.username,
        loginKind: "account",
        pairedAt: DateTime.now(),
      ));
      await widget.onPaired();
    } catch (e) {
      setState(() {
        _stage = _Stage.form;
        _error = "解密保险箱失败:$e。若桌面端改过密码,请让电脑端重新登录后重试。";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("账号登录")),
      body: switch (_stage) {
        _Stage.working => const Center(child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 14),
            Text("登录中…", style: TextStyle(fontSize: 13, color: Mx.muted)),
          ],
        )),
        _Stage.picking => _pickView(),
        _Stage.form => _formView(),
      },
    );
  }

  Widget _formView() {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 品牌区
            Container(
              width: 64,
              height: 64,
              alignment: Alignment.center,
              decoration: BoxDecoration(gradient: Mx.brandGradient, borderRadius: BorderRadius.circular(18)),
              child: const Icon(Icons.terminal, size: 34, color: Mx.accentContrast),
            ),
            const SizedBox(height: 14),
            const Text("txuyStudio", textAlign: TextAlign.center,
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: Mx.textBright)),
            const SizedBox(height: 4),
            const Text("AI CLI 终端工作台 · 移动伴侣", textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: Mx.muted)),
            const SizedBox(height: 28),
            if (_hint != null)
              Container(
                margin: const EdgeInsets.only(bottom: 14),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Mx.warningSoft,
                  borderRadius: BorderRadius.circular(Mx.radiusMd),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(Icons.info_outline, size: 15, color: Mx.warning),
                    const SizedBox(width: 8),
                    Expanded(child: Text(_hint!, style: const TextStyle(fontSize: 12, height: 1.5, color: Mx.warning))),
                  ],
                ),
              ),
            // 测试模式:自定义中继地址(线上默认就绪后不占首屏;测试期地址必填,
            // label/helper 明示,输入即自动记住,重开 app 回填)。
            if (_testMode) ...[
              TextField(
                controller: _url,
                keyboardType: TextInputType.url,
                decoration: InputDecoration(
                  labelText: defaultRelayUrl.isEmpty ? "中继地址(必填)" : "中继地址(测试)",
                  hintText: "wss://relay.example.com/txuy/ws",
                  helperText: "填你部署的中继服务地址,输入后自动记住",
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 12),
            ],
            TextField(
              controller: _user,
              decoration: const InputDecoration(
                labelText: "账号",
                prefixIcon: Icon(Icons.person_outline, size: 20),
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _pass,
              obscureText: _obscure,
              onSubmitted: (_) => _login(),
              decoration: InputDecoration(
                labelText: "密码",
                prefixIcon: const Icon(Icons.lock_outline, size: 20),
                border: const OutlineInputBorder(),
                isDense: true,
                suffixIcon: IconButton(
                  icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility, size: 18),
                  onPressed: () => setState(() => _obscure = !_obscure),
                ),
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Text(_error!, style: const TextStyle(fontSize: 12, height: 1.5, color: Mx.danger)),
              ),
            const SizedBox(height: 18),
            FilledButton(
              onPressed: _login,
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 13),
                textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
              ),
              child: const Text("登录"),
            ),
            const SizedBox(height: 18),
            TextButton.icon(
              onPressed: () => setState(() => _testMode = !_testMode),
              icon: Icon(_testMode ? Icons.expand_less : Icons.dns_outlined, size: 16),
              label: Text(
                _testMode
                    ? "收起中继地址"
                    : (defaultRelayUrl.isEmpty ? "中继地址 · 展开修改" : "测试模式 · 自定义中继地址"),
                style: const TextStyle(fontSize: 12),
              ),
              style: TextButton.styleFrom(foregroundColor: Mx.muted),
            ),
            const SizedBox(height: 6),
            const Text(
              "密码只在本机用于解密保险箱,中继存的是密文。",
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 11, height: 1.5, color: Mx.faint),
            ),
          ],
        ),
      ),
    );
  }

  /// 多桌面挑选(vault 按发布时间倒序;在线状态来自 /devices)。
  Widget _pickView() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        // 共用设备选择列表(✎ 打标签;标签存本机,专门解决「多台电脑只有 id 分不清」)。
        DeviceEntryList(
          entries: _entries,
          devices: _devices,
          heading: "选择桌面端",
          description: "该账号下有多台电脑发布过保险箱,选择要连接的一台(✎ 可打标签方便分辨):",
          onPick: (e) => _openEntry(e, _pass.text),
        ),
      ],
    );
  }
}
