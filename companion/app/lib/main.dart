import 'package:flutter/material.dart';

import 'pages/login_screen.dart';
import 'pages/home_shell.dart';
import 'relay/client.dart';
import 'relay/credentials.dart';
import 'theme.dart';

/// txuyStudio 移动伴侣:经公网中继遥控桌面端(出站连接 + E2E 加密)。
/// 无凭证 → 账号登录页(v4:账密 → vault 解密配对凭证);有凭证 → 主壳。
void main() {
  runApp(const CompanionApp());
}

class CompanionApp extends StatelessWidget {
  const CompanionApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "txuyStudio",
      debugShowCheckedModeBanner: false,
      // 奶油金:与桌面端 [data-theme="cream-gold"] 同口径(见 theme.dart)。
      theme: buildCompanionTheme(),
      home: const _Root(),
    );
  }
}

class _Root extends StatefulWidget {
  const _Root();

  @override
  State<_Root> createState() => _RootState();
}

class _RootState extends State<_Root> {
  PairCredentials? _cred;
  String? _selfId;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    final cred = await CredentialStore.load();
    final self = await CredentialStore.selfDeviceId();
    if (!mounted) return;
    setState(() {
      _cred = cred;
      _selfId = self;
      _loading = false;
    });
  }

  Future<void> _unpair() async {
    await CredentialStore.clear();
    if (!mounted) return;
    setState(() => _cred = null);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_cred == null || _selfId == null) {
      return LoginScreen(onPaired: () => _boot());
    }
    return HomeShell(
      // 凭证换了(切换桌面端)必须换 key:同类型同位置的 Element 会被复用,State 里的
      // `late final RelayClient _client` 就不会重建,连接还停在旧桌面端。
      key: ValueKey("${_cred!.userId}|${_cred!.desktopDeviceId}"),
      cred: _cred!,
      selfId: _selfId!,
      onUnpair: _unpair,
      // 切换桌面端(用户页)换的是凭证:走同一条 _boot 重建路径(新 RelayClient)。
      onCredentialsChanged: _boot,
      clientBuilder: () => RelayClient(cred: _cred!, selfId: _selfId!),
    );
  }
}
