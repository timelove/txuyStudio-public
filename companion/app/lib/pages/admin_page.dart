// 管理页(仅管理员):用户 + 邀请码 + 组织,三 tab。
// 全部走中继 admin API(操作有中继审计日志);手机端不直连数据库。
// 入口:主页「更多」菜单「用户管理」(AccountStore.isAdmin 控制)。
// 邀请码 = 注册准入门槛(registerMode=invite 的中继注册须携带):线下收款/邀请后发码。
// 组织 = 管理分组维度(用户/邀请码可挂组),不影响传输隔离(设备/快照仍按 user 路由)。

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../relay/account.dart';
import '../theme.dart';

class AdminPage extends StatefulWidget {
  final AccountSession session;
  const AdminPage({super.key, required this.session});

  @override
  State<AdminPage> createState() => _AdminPageState();
}

class _AdminPageState extends State<AdminPage> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 3, vsync: this);
  late Future<List<AdminUser>> _usersFuture;
  late Future<List<AdminInvite>> _invitesFuture;
  late Future<List<AdminOrg>> _orgsFuture;

  @override
  void initState() {
    super.initState();
    _reloadUsers();
    _reloadInvites();
    _reloadOrgs();
  }

  /// 超级账号 = 用户名 "admin"(与服务端 superAdminName 同口径):
  /// admins 组织授予/收回、超管改密/删除只放行给它。
  bool get _isSuper => widget.session.username == superAdminName;

  // 块体闭包:箭头体 `() => _x = asyncCall()` 会把赋值表达式的值(Future)当返回值,
  // 触发 setState「callback returned a Future」断言(打开页面即抛)。
  void _reloadUsers() {
    setState(() {
      _usersFuture = adminListUsers(widget.session);
    });
  }

  void _reloadInvites() {
    setState(() {
      _invitesFuture = adminListInvites(widget.session);
    });
  }

  void _reloadOrgs() {
    setState(() {
      _orgsFuture = adminListOrgs(widget.session);
    });
  }

  /// 弹组织下拉前拉一次列表;失败降级空列表(只显示「无组织」,不阻断操作)。
  Future<List<AdminOrg>> _fetchOrgsQuietly() async {
    try {
      return await adminListOrgs(widget.session);
    } catch (_) {
      return const [];
    }
  }

  Future<void> _toast(String msg) async {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(msg), duration: const Duration(seconds: 2)));
  }

  // ---------- 用户 tab 对话框 ----------

  Future<void> _createDialog() async {
    final user = TextEditingController();
    final pass = TextEditingController();
    final selected = <String>{};
    final orgs = await _fetchOrgsQuietly();
    if (!mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => AlertDialog(
          title: const Text("新建用户"),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: user, decoration: const InputDecoration(labelText: "账号", border: OutlineInputBorder(), isDense: true)),
              const SizedBox(height: 10),
              TextField(
                controller: pass,
                obscureText: true,
                decoration: const InputDecoration(labelText: "密码(8~128 位,字母+数字)", border: OutlineInputBorder(), isDense: true),
              ),
              const SizedBox(height: 12),
              const Align(
                alignment: Alignment.centerLeft,
                child: Text("组织(可多选;勾 admins 即管理员)", style: TextStyle(fontSize: 11, color: Mx.muted)),
              ),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 4,
                children: [
                  for (final o in orgs)
                    FilterChip(
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      visualDensity: VisualDensity.compact,
                      // admins(管理员角色)只有超级账号 admin 能勾(服务端同口径硬闸)。
                      onSelected: o.name == adminOrgName && !_isSuper
                          ? null
                          : (v) => setDialog(() => v ? selected.add(o.name) : selected.remove(o.name)),
                      label: Text(
                        o.name == adminOrgName ? "admins · 管理员" : o.name,
                        style: TextStyle(
                          fontSize: 11,
                          color: selected.contains(o.name)
                              ? (o.name == adminOrgName ? Mx.warning : Mx.violet)
                              : Mx.muted,
                        ),
                      ),
                      selected: selected.contains(o.name),
                    ),
                ],
              ),
              if (!_isSuper)
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text("管理员组织(admins)仅超级账号 admin 可设置", style: TextStyle(fontSize: 10, color: Mx.muted)),
                ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("创建")),
          ],
        ),
      ),
    );
    if (ok != true) return;
    if (!isStrongPassword(pass.text)) {
      await _toast(weakPasswordTip);
      return;
    }
    try {
      await adminCreateUser(widget.session, user.text.trim(), pass.text, selected.toList());
      await _toast("已创建 ${user.text.trim()}");
      _reloadUsers();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  /// 编辑成员组织(全量替换):勾选 admins 即授予/收回管理员角色——用户可在多个组织。
  Future<void> _editOrgsDialog(AdminUser u) async {
    final orgs = await _fetchOrgsQuietly();
    if (!mounted) return;
    final selected = {...u.orgs};
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => AlertDialog(
          title: Text("${u.username} 的组织"),
          content: orgs.isEmpty
              ? const SizedBox(width: 260, child: Text("暂无组织可分配(先到组织 tab 新建)", style: TextStyle(fontSize: 12, color: Mx.muted)))
              : SizedBox(
                  width: double.infinity,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      for (final o in orgs)
                        CheckboxListTile(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          controlAffinity: ListTileControlAffinity.leading,
                          value: selected.contains(o.name),
                          title: Text(
                            o.name == adminOrgName ? "admins(管理员角色)" : o.name,
                            style: TextStyle(fontSize: 13, color: o.name == adminOrgName ? Mx.warning : Mx.text),
                          ),
                          subtitle: o.note.isEmpty ? null : Text(o.note, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 10, color: Mx.muted)),
                          // admins 只有超级账号 admin 能改选(授予/收回管理员身份)。
                          onChanged: o.name == adminOrgName && !_isSuper
                              ? null
                              : (v) => setDialog(() => v == true ? selected.add(o.name) : selected.remove(o.name)),
                        ),
                      if (!_isSuper)
                        const Align(
                          alignment: Alignment.centerLeft,
                          child: Padding(
                            padding: EdgeInsets.only(top: 6),
                            child: Text("管理员组织(admins)仅超级账号 admin 可设置", style: TextStyle(fontSize: 10, color: Mx.muted)),
                          ),
                        ),
                    ],
                  ),
                ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("保存")),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      await adminSetUserOrgs(widget.session, u.username, selected.toList());
      await _toast("组织已更新${selected.contains(adminOrgName) ? "(含管理员角色)" : ""}");
      _reloadUsers();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  Future<void> _passwordDialog(AdminUser u) async {
    final pass = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text("修改 ${u.username} 的密码"),
        content: TextField(
          controller: pass,
          obscureText: true,
          decoration: const InputDecoration(labelText: "新密码(8~128 位,字母+数字)", border: OutlineInputBorder(), isDense: true),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认")),
        ],
      ),
    );
    if (ok != true) return;
    if (!isStrongPassword(pass.text)) {
      await _toast(weakPasswordTip);
      return;
    }
    try {
      await adminSetPassword(widget.session, u.username, pass.text);
      await _toast("密码已修改(已登录会话保持,必要时手动吊销)");
      _reloadUsers();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  Future<bool> _confirm(String title, String body) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认")),
        ],
      ),
    );
    return ok == true;
  }

  Future<void> _killSessions(AdminUser u) async {
    if (!await _confirm("吊销 ${u.username} 的全部会话?", "该用户所有已登录设备(桌面端/手机端)将立即下线,需重新登录。")) return;
    try {
      final n = await adminKillSessions(widget.session, u.username);
      await _toast("已吊销 $n 个会话");
      _reloadUsers();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  Future<void> _deleteUser(AdminUser u) async {
    if (!await _confirm("删除用户 ${u.username}?", "同时吊销其全部会话与保险箱数据,不可恢复。")) return;
    try {
      await adminDeleteUser(widget.session, u.username);
      await _toast("已删除 ${u.username}");
      _reloadUsers();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  // ---------- 邀请码 tab ----------

  Future<void> _createInviteDialog() async {
    final note = TextEditingController();
    final customDays = TextEditingController();
    var maxUses = 1;
    var expiresInHours = 168; // 7 天;-1=永不过期;0=自定义天数(天数输入框接管)
    var org = "";
    final orgs = await _fetchOrgsQuietly();
    if (!mounted) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDialog) => AlertDialog(
          title: const Text("生成邀请码"),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: note, decoration: const InputDecoration(labelText: "备注(给谁/为什么,可空)", border: OutlineInputBorder(), isDense: true)),
              const SizedBox(height: 10),
              DropdownButtonFormField<int>(
                initialValue: maxUses,
                decoration: const InputDecoration(labelText: "可用次数", border: OutlineInputBorder(), isDense: true),
                items: const [
                  DropdownMenuItem(value: 1, child: Text("1 次(一次性)")),
                  DropdownMenuItem(value: 5, child: Text("5 次")),
                  DropdownMenuItem(value: 10, child: Text("10 次")),
                  DropdownMenuItem(value: 50, child: Text("50 次(团体码)")),
                ],
                onChanged: (v) => setDialog(() => maxUses = v ?? 1),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<int>(
                initialValue: expiresInHours,
                decoration: const InputDecoration(labelText: "有效期", border: OutlineInputBorder(), isDense: true),
                items: const [
                  DropdownMenuItem(value: 24, child: Text("1 天")),
                  DropdownMenuItem(value: 168, child: Text("7 天")),
                  DropdownMenuItem(value: 720, child: Text("30 天")),
                  DropdownMenuItem(value: -1, child: Text("永不过期")),
                  // 0 = 自定义:选中后出现天数输入框(2026-10-30 用户诉求)。
                  DropdownMenuItem(value: 0, child: Text("自定义天数…")),
                ],
                onChanged: (v) => setDialog(() => expiresInHours = v ?? 168),
              ),
              if (expiresInHours == 0) ...[
                const SizedBox(height: 10),
                TextField(
                  controller: customDays,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: "有效天数(1~3650)",
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ],
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: org,
                decoration: const InputDecoration(labelText: "注册后进组织", border: OutlineInputBorder(), isDense: true),
                items: [
                  const DropdownMenuItem(value: "", child: Text("不进组织")),
                  // admins 不敞开邀请码通道:码会被转发/捡用,拿到码不应等于拿到管理员。
                  for (final o in orgs)
                    if (o.name != adminOrgName) DropdownMenuItem(value: o.name, child: Text(o.name)),
                ],
                onChanged: (v) => setDialog(() => org = v ?? ""),
              ),
            ],
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("生成")),
          ],
        ),
      ),
    );
    final noteText = note.text.trim();
    final customDaysText = customDays.text.trim();
    note.dispose();
    customDays.dispose();
    if (ok != true || !mounted) return;
    // 自定义天数(下拉选 0):换算小时;空/非法兜底 7 天。
    var hours = expiresInHours;
    if (hours == 0) {
      final d = int.tryParse(customDaysText) ?? 7;
      hours = (d.clamp(1, 3650)) * 24;
    }
    try {
      final inv = await adminCreateInvite(
        widget.session,
        maxUses: maxUses,
        expiresInHours: hours,
        note: noteText,
        org: org,
      );
      _reloadInvites();
      await _showInviteResult(inv);
    } catch (e) {
      await _toast(e.toString());
    }
  }

  /// 生成结果展示:大号码 + 一键复制(转达场景:直接截图/复制发给被邀请人)。
  Future<void> _showInviteResult(AdminInvite inv) async {
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("邀请码已生成"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            SelectableText(
              inv.code,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold, letterSpacing: 2, fontFamily: "monospace", color: Mx.textBright),
            ),
            const SizedBox(height: 8),
            Text(
              "${inv.maxUses == 1 ? "一次性" : "可用 ${inv.maxUses} 次"} · ${inv.expiresLabel ?? "7 天"}有效\n对方在注册时填写此码即可",
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 11, height: 1.6, color: Mx.muted),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () {
              Clipboard.setData(ClipboardData(text: inv.code));
              Navigator.pop(ctx);
            },
            child: const Text("复制并关闭"),
          ),
        ],
      ),
    );
  }

  Future<void> _revokeInvite(AdminInvite inv) async {
    if (!await _confirm("作废邀请码?", "码:${inv.code}\n未用完的剩余次数一并作废,已用该码注册的账号不受影响。")) return;
    try {
      await adminDeleteInvite(widget.session, inv.code);
      await _toast("已作废");
      _reloadInvites();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("管理"),
        bottom: TabBar(
          controller: _tabs,
          isScrollable: true,
          tabs: const [Tab(text: "用户"), Tab(text: "邀请码"), Tab(text: "组织")],
        ),
      ),
      body: Stack(children: [
        TabBarView(
          controller: _tabs,
          children: [_usersView(), _invitesView(), _orgsView()],
        ),
        // FAB 随 tab 切换:三 tab 统一右下角悬浮入口(用户/邀请码/组织各一个动作)。
        // TabController 是 Listenable,index 在切换动画结束后更新,AnimatedBuilder 驱动重建。
        AnimatedBuilder(
          animation: _tabs,
          builder: (context, _) {
            if (_tabs.index == 0) {
              return _fab(Icons.person_add, "新建用户", _createDialog);
            }
            if (_tabs.index == 1) {
              return _fab(Icons.confirmation_number_outlined, "生成邀请码", _createInviteDialog);
            }
            return _fab(Icons.add_business, "新建组织", _createOrgDialog);
          },
        ),
      ]),
    );
  }

  Widget _fab(IconData icon, String label, VoidCallback onPressed) => Padding(
        padding: const EdgeInsets.all(16),
        child: Align(
          alignment: Alignment.bottomRight,
          child: FloatingActionButton.extended(
            onPressed: onPressed,
            icon: Icon(icon, size: 20),
            label: Text(label),
          ),
        ),
      );

  // ---------- 用户 tab 视图 ----------

  Widget _usersView() {
    return FutureBuilder<List<AdminUser>>(
      future: _usersFuture,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snap.hasError) {
            return Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.error_outline, size: 30, color: Mx.danger),
                  const SizedBox(height: 8),
                  Text("${snap.error}", style: const TextStyle(fontSize: 12, color: Mx.muted)),
                  const SizedBox(height: 10),
                  OutlinedButton(onPressed: _reloadUsers, child: const Text("重试")),
                ],
              ),
            );
          }
          final users = snap.data ?? const [];
          if (users.isEmpty) {
            return const Center(child: Text("暂无用户", style: TextStyle(fontSize: 13, color: Mx.muted)));
          }
          return RefreshIndicator(
            onRefresh: () async => _reloadUsers(),
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: users.length,
              separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
              itemBuilder: (context, i) {
                final u = users[i];
                final isSelf = u.userId == widget.session.userId;
                final date = DateTime.fromMillisecondsSinceEpoch(u.createdAt * 1000);
                // 管理员徽标来自 admins 组织(金色);其余组织紫色徽标放 subtitle 行,可挂多个。
                final plainOrgs = u.orgs.where((o) => o != adminOrgName).toList();
                return ListTile(
                  leading: CircleAvatar(
                    radius: 16,
                    backgroundColor: u.inAdminOrg ? Mx.brandGradient.colors.first : Mx.surface2,
                    child: Text(
                      u.username.isNotEmpty ? u.username.substring(0, 1).toUpperCase() : "?",
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                        color: u.inAdminOrg ? Mx.accentContrast : Mx.muted,
                      ),
                    ),
                  ),
                  title: Row(
                    children: [
                      Flexible(child: Text(u.username, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
                      if (u.inAdminOrg) ...[
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(color: Mx.warningSoft, borderRadius: BorderRadius.circular(4)),
                          child: const Text("管理员", style: TextStyle(fontSize: 10, color: Mx.warning)),
                        ),
                      ],
                      if (isSelf) ...[
                        const SizedBox(width: 6),
                        const Text("(本机)", style: TextStyle(fontSize: 11, color: Mx.muted)),
                      ],
                    ],
                  ),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (plainOrgs.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2, bottom: 3),
                          child: Wrap(
                            spacing: 4,
                            runSpacing: 3,
                            children: [
                              for (final o in plainOrgs)
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                                  decoration: BoxDecoration(color: Mx.violetSoft, borderRadius: BorderRadius.circular(4)),
                                  child: Text(o, style: const TextStyle(fontSize: 10, color: Mx.violet)),
                                ),
                            ],
                          ),
                        ),
                      Text(
                        "${date.year}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')} 创建 · 活跃会话 ${u.sessions}",
                        style: const TextStyle(fontSize: 11, color: Mx.muted),
                      ),
                    ],
                  ),
                  trailing: PopupMenuButton<String>(
                    icon: const Icon(Icons.more_vert, size: 18),
                    color: Mx.surface,
                    onSelected: (v) {
                      switch (v) {
                        case "orgs":
                          _editOrgsDialog(u);
                        case "passwd":
                          _passwordDialog(u);
                        case "kill":
                          _killSessions(u);
                        case "delete":
                          _deleteUser(u);
                      }
                    },
                    itemBuilder: (_) => [
                      const PopupMenuItem(value: "orgs", height: 40, child: Row(children: [
                        Icon(Icons.workspaces_outline, size: 16, color: Mx.violet), SizedBox(width: 10), Text("编辑组织", style: TextStyle(fontSize: 13)),
                      ])),
                      const PopupMenuItem(value: "passwd", height: 40, child: Row(children: [
                        Icon(Icons.password, size: 16, color: Mx.muted), SizedBox(width: 10), Text("修改密码", style: TextStyle(fontSize: 13)),
                      ])),
                      const PopupMenuItem(value: "kill", height: 40, child: Row(children: [
                        Icon(Icons.phonelink_erase, size: 16, color: Mx.warning), SizedBox(width: 10), Text("吊销会话", style: TextStyle(fontSize: 13)),
                      ])),
                      const PopupMenuItem(value: "delete", height: 40, child: Row(children: [
                        Icon(Icons.person_remove, size: 16, color: Mx.danger), SizedBox(width: 10), Text("删除用户", style: TextStyle(fontSize: 13)),
                      ])),
                    ],
                  ),
                );
              },
            ),
          );
        },
      );
  }

  // ---------- 邀请码 tab 视图 ----------

  Widget _invitesView() {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: Row(children: [
          const Expanded(
            child: Text("发给被邀请人,对方注册时填写;线下收款后发码即「付费注册」。生成入口在右下角 +。",
                style: TextStyle(fontSize: 10, height: 1.4, color: Mx.muted)),
          ),
          // 手动刷新(用户 2026-10-30:邀请码次数有限,不做自动/推送刷新)。
          IconButton(
            icon: const Icon(Icons.refresh, size: 18),
            tooltip: "刷新邀请码列表",
            onPressed: _reloadInvites,
          ),
        ]),
      ),
      Expanded(
        child: FutureBuilder<List<AdminInvite>>(
          future: _invitesFuture,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snap.hasError) {
              return Center(child: Text("${snap.error}", style: const TextStyle(fontSize: 12, color: Mx.muted)));
            }
            final invites = snap.data ?? const [];
            if (invites.isEmpty) {
              return const Center(child: Text("暂无邀请码", style: TextStyle(fontSize: 13, color: Mx.muted)));
            }
            return RefreshIndicator(
              onRefresh: () async => _reloadInvites(),
              child: ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                itemCount: invites.length,
                separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
                itemBuilder: (context, i) {
                  final inv = invites[i];
                  final (color, label) = inv.expired
                      ? (Mx.faint, "已过期")
                      : inv.exhausted
                          ? (Mx.muted, "已用完")
                          : (Mx.success, inv.remaining == 1 ? "可用 1 次" : "可用 ${inv.remaining} 次");
                  return ListTile(
                    leading: Icon(
                      inv.available ? Icons.confirmation_number : Icons.confirmation_number_outlined,
                      size: 20,
                      color: color,
                    ),
                    title: Row(
                      children: [
                        Flexible(
                          child: Text(inv.code,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 14, letterSpacing: 1.5, fontFamily: "monospace", color: Mx.textBright)),
                        ),
                        const SizedBox(width: 6),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(color: Mx.successSoft, borderRadius: BorderRadius.circular(4)),
                          child: Text(label, style: TextStyle(fontSize: 10, color: color)),
                        ),
                      ],
                    ),
                    subtitle: Text(
                      "已用 ${inv.uses}/${inv.maxUses} · ${inv.expiresLabel ?? "7 天"}失效"
                      "${inv.org.isEmpty ? "" : " · 组 ${inv.org}"}${inv.note.isEmpty ? "" : " · ${inv.note}"}",
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, color: Mx.muted),
                    ),
                    trailing: PopupMenuButton<String>(
                      icon: const Icon(Icons.more_vert, size: 18),
                      color: Mx.surface,
                      onSelected: (v) {
                        if (v == "copy") {
                          Clipboard.setData(ClipboardData(text: inv.code));
                          _toast("已复制 ${inv.code}");
                        } else if (v == "revoke") {
                          _revokeInvite(inv);
                        }
                      },
                      itemBuilder: (_) => [
                        const PopupMenuItem(value: "copy", height: 40, child: Row(children: [
                          Icon(Icons.copy, size: 16, color: Mx.muted), SizedBox(width: 10), Text("复制", style: TextStyle(fontSize: 13)),
                        ])),
                        const PopupMenuItem(value: "revoke", height: 40, child: Row(children: [
                          Icon(Icons.block, size: 16, color: Mx.danger), SizedBox(width: 10), Text("作废", style: TextStyle(fontSize: 13)),
                        ])),
                      ],
                    ),
                  );
                },
              ),
            );
          },
        ),
      ),
    ]);
  }

  // ---------- 组织 tab ----------

  Future<void> _createOrgDialog() async {
    final name = TextEditingController();
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("新建组织"),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(controller: name, decoration: const InputDecoration(labelText: "组织名(1-32 位字母数字_.-)", border: OutlineInputBorder(), isDense: true)),
            const SizedBox(height: 10),
            TextField(controller: note, decoration: const InputDecoration(labelText: "备注(可空)", border: OutlineInputBorder(), isDense: true)),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("创建")),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await adminCreateOrg(widget.session, name.text.trim(), note.text.trim());
      await _toast("组织 ${name.text.trim()} 已创建");
      _reloadOrgs();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  Future<void> _deleteOrg(AdminOrg o) async {
    if (!await _confirm(
      "删除组织 ${o.name}?",
      o.members > 0 ? "组织内仍有 ${o.members} 名成员,需先转移或移出后才能删除。" : "仅清空组织分组;挂在该组的邀请码一并解除关联,码本身仍可用。",
    )) {
      return;
    }
    try {
      await adminDeleteOrg(widget.session, o.name);
      await _toast("已删除 ${o.name}");
      _reloadOrgs();
    } catch (e) {
      await _toast(e.toString());
    }
  }

  Widget _orgsView() {
    return FutureBuilder<List<AdminOrg>>(
      future: _orgsFuture,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snap.hasError) {
          return Center(child: Text("${snap.error}", style: const TextStyle(fontSize: 12, color: Mx.muted)));
        }
        final orgs = snap.data ?? const [];
        if (orgs.isEmpty) {
          return const Center(child: Text("暂无组织(纯分组维度,按需建)", style: TextStyle(fontSize: 13, color: Mx.muted)));
        }
        return RefreshIndicator(
          onRefresh: () async => _reloadOrgs(),
          child: ListView.separated(
            physics: const AlwaysScrollableScrollPhysics(),
            itemCount: orgs.length,
            separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
            itemBuilder: (context, i) {
              final o = orgs[i];
              // admins 为内置管理员角色组织:盾牌图标 + 锁定不可删(角色真源)。
              final isBuiltin = o.name == adminOrgName;
              return ListTile(
                leading: CircleAvatar(
                  radius: 16,
                  backgroundColor: isBuiltin ? Mx.warningSoft : Mx.brandGradient.colors.first,
                  child: isBuiltin
                      ? const Icon(Icons.shield_outlined, size: 16, color: Mx.warning)
                      : Text(o.name.isNotEmpty ? o.name.substring(0, 1).toUpperCase() : "?", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Mx.accentContrast)),
                ),
                title: Row(
                  children: [
                    Flexible(child: Text(o.name, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14))),
                    if (isBuiltin) ...[
                      const SizedBox(width: 6),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                        decoration: BoxDecoration(color: Mx.warningSoft, borderRadius: BorderRadius.circular(4)),
                        child: const Text("内置", style: TextStyle(fontSize: 10, color: Mx.warning)),
                      ),
                    ],
                  ],
                ),
                subtitle: Text(
                  "${o.members} 名成员${o.note.isEmpty ? "" : " · ${o.note}"}",
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 11, color: Mx.muted),
                ),
                trailing: isBuiltin
                    ? const Icon(Icons.lock_outline, size: 16, color: Mx.faint)
                    : PopupMenuButton<String>(
                        icon: const Icon(Icons.more_vert, size: 18),
                        color: Mx.surface,
                        onSelected: (v) {
                          if (v == "delete") _deleteOrg(o);
                        },
                        itemBuilder: (_) => [
                          const PopupMenuItem(value: "delete", height: 40, child: Row(children: [
                            Icon(Icons.delete_outline, size: 16, color: Mx.danger), SizedBox(width: 10), Text("删除组织", style: TextStyle(fontSize: 13)),
                          ])),
                        ],
                      ),
              );
            },
          ),
        );
      },
    );
  }
}
