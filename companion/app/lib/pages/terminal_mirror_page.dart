import 'dart:async';

import 'package:flutter/material.dart';

import '../relay/client.dart';
import '../terminal/ansi.dart';
import '../theme.dart';

/// shell / test tab 的**只读**终端镜像。
///
/// 数据来源:`pty.tail`(后端 `PtySession.transcript`,256KB 环形缓存,与桌面端
/// WebView 重载后的 re-attach 回放同源)。手机不发键盘输入——v1 明确只读,原因:
/// 手机键盘没有 Ctrl/Esc/Tab,交互式 TUI(claude/codex/lazygit)在手机上无法操作;
/// 而半吊子的输入通道反而会让用户以为能远程操作,误按破坏性命令。看得到就好。
///
/// 刷新:进页拉一次 + 每 [_pollEvery] 拉一次(近实时跟随)。页面不可见时定时器暂停
/// (dispose 时取消),不烧流量。
class TerminalMirrorPage extends StatefulWidget {
  final RelayClient client;
  final String projectId;
  final String tabId;
  final String tabTitle;

  const TerminalMirrorPage({
    super.key,
    required this.client,
    required this.projectId,
    required this.tabId,
    required this.tabTitle,
  });

  @override
  State<TerminalMirrorPage> createState() => _TerminalMirrorPageState();
}

class _TerminalMirrorPageState extends State<TerminalMirrorPage> {
  static const _pollEvery = Duration(seconds: 2);

  final _scroll = ScrollController();
  Timer? _timer;
  String? _text;
  bool _alive = true;
  String? _error;
  bool _loading = true;
  /// 上一次是否停在底部:用户在往上翻历史时不要强制拽回底部。
  bool _stickToBottom = true;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      final gap = _scroll.position.maxScrollExtent - _scroll.offset;
      _stickToBottom = gap < 80;
    });
    _fetch();
    _timer = Timer.periodic(_pollEvery, (_) => _fetch());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _fetch() async {
    try {
      final resp = await widget.client.request("pty.tail", {
        "projectId": widget.projectId,
        "sessionId": widget.tabId,
      });
      final r = (resp["result"] as Map?)?.cast<String, dynamic>() ?? const {};
      final text = stripAnsi((r["data"] as String?) ?? "");
      if (!mounted) return;
      final atBottom = _stickToBottom;
      setState(() {
        _text = text;
        _alive = r["alive"] != false;
        _error = null;
        _loading = false;
      });
      if (atBottom) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = "$e";
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = _text;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(widget.tabTitle, overflow: TextOverflow.ellipsis),
            Row(children: [
              Container(
                width: 6,
                height: 6,
                margin: const EdgeInsets.only(right: 4),
                decoration: BoxDecoration(
                  color: _alive ? Mx.success : Mx.danger,
                  shape: BoxShape.circle,
                ),
              ),
              Text(
                _alive ? "只读镜像 · 实时跟随" : "会话已退出 · 显示最后输出",
                style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w400, color: Mx.muted),
              ),
            ]),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh, size: 18),
            tooltip: "刷新",
            onPressed: _fetch,
          ),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
            decoration: BoxDecoration(
              color: Mx.infoSoft,
              borderRadius: BorderRadius.circular(Mx.radiusMd),
              border: Border.all(color: Mx.border),
            ),
            child: const Row(children: [
              Icon(Icons.visibility_outlined, size: 13, color: Mx.info),
              SizedBox(width: 6),
              Expanded(
                child: Text(
                  "只读:手机不能向终端输入命令,操作请在电脑上进行",
                  style: TextStyle(fontSize: 11, color: Mx.info),
                ),
              ),
            ]),
          ),
        ),
        Expanded(
          child: Container(
            margin: const EdgeInsets.all(12),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: Mx.cardInner,
              borderRadius: BorderRadius.circular(Mx.radiusMd),
              border: Border.all(color: Mx.border),
            ),
            child: _loading
                ? const Center(child: CircularProgressIndicator(strokeWidth: 2))
                : _error != null
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Text(
                            "拉取失败(会话可能尚未启动):\n$_error",
                            textAlign: TextAlign.center,
                            style: const TextStyle(fontSize: 12, color: Mx.muted),
                          ),
                        ),
                      )
                    : text == null || text.isEmpty
                        ? const Center(
                            child: Text("暂无输出", style: TextStyle(fontSize: 12, color: Mx.faint)),
                          )
                        : SingleChildScrollView(
                            controller: _scroll,
                            child: SelectableText(
                              text,
                              style: const TextStyle(
                                fontFamily: "Consolas",
                                fontFamilyFallback: ["monospace"],
                                fontSize: 11.5,
                                height: 1.35,
                                color: Mx.textBright,
                              ),
                            ),
                          ),
          ),
        ),
      ]),
    );
  }
}
