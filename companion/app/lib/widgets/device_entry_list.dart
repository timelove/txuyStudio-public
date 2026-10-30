import 'package:flutter/material.dart';

import '../relay/account.dart';
import '../relay/device_labels.dart';
import '../theme.dart';

/// 桌面端(电脑)选择列表:登录页 picking 阶段与「切换电脑」面板共用。
///
/// 每条卡片 = 一台发布过保险箱的电脑。标题优先显示**自定义标签**
/// (DeviceLabelStore,本机 SharedPreferences;✎ 行尾按钮改,清空即删),没有标签退
/// deviceId;有标签时 deviceId 降级进副标题。标签只是本地记号,中继/桌面端无感知。
class DeviceEntryList extends StatefulWidget {
  final List<VaultEntry> entries;
  final Map<String, DeviceInfo> devices;
  final void Function(VaultEntry) onPick;
  final String heading;
  final String description;
  /// 当前连接的电脑(打「当前」徽标;可空 = 不标,登录页场景)。
  final String? currentDeviceId;

  const DeviceEntryList({
    super.key,
    required this.entries,
    required this.devices,
    required this.onPick,
    required this.heading,
    required this.description,
    this.currentDeviceId,
  });

  @override
  State<DeviceEntryList> createState() => _DeviceEntryListState();
}

class _DeviceEntryListState extends State<DeviceEntryList> {
  Map<String, String> _labels = const {};

  @override
  void initState() {
    super.initState();
    DeviceLabelStore.loadAll().then((m) {
      if (mounted) setState(() => _labels = m);
    });
  }

  Future<void> _editLabel(VaultEntry e) async {
    final ctrl = TextEditingController(text: _labels[e.deviceId] ?? "");
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("设备标签"),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLength: 24,
          decoration: const InputDecoration(hintText: "例如:公司台式机 / 家里笔记本(清空即删除)"),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("保存")),
        ],
      ),
    );
    // 先取值再 dispose(controller dispose 后 .text 不可读)。
    final v = ctrl.text.trim();
    ctrl.dispose();
    if (ok != true) return;
    await DeviceLabelStore.setLabel(e.deviceId, v);
    if (!mounted) return;
    setState(() => _labels = {..._labels, e.deviceId: v});
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(widget.heading, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Text(widget.description, style: const TextStyle(fontSize: 12, color: Mx.muted)),
        const SizedBox(height: 12),
        for (final e in widget.entries) _card(e),
      ],
    );
  }

  Widget _card(VaultEntry e) {
    final online = widget.devices[e.deviceId]?.online == true;
    final label = (_labels[e.deviceId] ?? "").trim();
    final isCur = e.deviceId == widget.currentDeviceId;
    return Card(
      color: Mx.surface2,
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        leading: Icon(Icons.computer, size: 22, color: online ? Mx.success : Mx.muted),
        title: Text(
          label.isNotEmpty ? label : e.deviceId,
          style: label.isNotEmpty
              ? const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)
              : const TextStyle(fontSize: 13, fontFamily: "monospace"),
        ),
        subtitle: Text(
          "${label.isNotEmpty ? "${e.deviceId} · " : ""}${online ? "在线" : "离线(可连接,看离线快照)"}",
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 11, color: Mx.muted),
        ),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isCur)
              Container(
                margin: const EdgeInsets.only(right: 2),
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: Mx.accentSoft,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: Mx.selectedBorder),
                ),
                child: const Text("当前", style: TextStyle(fontSize: 10, color: Mx.accentBright)),
              ),
            IconButton(
              icon: Icon(label.isNotEmpty ? Icons.edit_outlined : Icons.label_outline, size: 16, color: Mx.muted),
              tooltip: "设备标签",
              onPressed: () => _editLabel(e),
            ),
          ],
        ),
        onTap: () => widget.onPick(e),
      ),
    );
  }
}
