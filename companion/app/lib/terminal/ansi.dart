/// ANSI / 终端控制序列的纯文本降级(只读镜像用)。
///
/// 手机端不渲染真终端(v1 无 xterm 依赖,见设计文档「已知取舍:shell 只读」),把后端
/// `pty.tail` 返回的原始字节串剥成可读文本。目标不是像素级还原 TUI,而是「看得出最后
/// 发生了什么」:命令输出、报错、提示符。
///
/// 处理顺序(顺序有意义):
/// 1. 先删 CSI / OSC / 单字符转义(`ESC [ … m` 之类)——OSC 里可能带文件名/URL,直接删。
/// 2. 回车覆盖:`\r` 回到行首。PowerShell 进度条靠 `\r` 反复重绘,直接删 `\r` 会把几十帧
///    拼成一行;这里按「同段内 `\r` 之后的内容覆盖之前」的近似处理。
/// 3. 退格 `\b`:删前一个字符(交互式编辑残留)。
/// 4. 折叠成行列并丢掉尾部空行。
library;

final _csi = RegExp(r'\x1b\[[0-9;?]*[ -/]*[@-~]');
final _osc = RegExp(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)');
final _otherEsc = RegExp(r'\x1b[@-Z\\-_]');
final _control = RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]');

/// 把一段 PTY 原始输出降级成纯文本。
String stripAnsi(String raw) {
  var s = raw.replaceAll(_osc, '').replaceAll(_csi, '').replaceAll(_otherEsc, '');
  // 回车覆盖:同一行内 `\r` 之后的内容才是最终可见的。
  s = s.split('\n').map((line) {
    if (!line.contains('\r')) return line;
    final parts = line.split('\r');
    final buf = StringBuffer();
    for (final p in parts) {
      if (p.isEmpty) continue;
      // 近似:后一段整体覆盖前一段(真终端只覆盖等宽部分,纯文本下够用)。
      buf
        ..clear()
        ..write(p);
    }
    return buf.toString();
  }).join('\n');
  // 退格。
  final out = StringBuffer();
  for (final ch in s.split('')) {
    if (ch == '\b') {
      final cur = out.toString();
      if (cur.isNotEmpty) {
        out
          ..clear()
          ..write(cur.substring(0, cur.length - 1));
      }
      continue;
    }
    out.write(ch);
  }
  s = out.toString().replaceAll(_control, '');
  // 丢尾部空行(PTY transcript 常以若干空行/换行收尾)。
  final lines = s.split('\n');
  while (lines.isNotEmpty && lines.last.trim().isEmpty) {
    lines.removeLast();
  }
  return lines.join('\n');
}
