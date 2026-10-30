// 中继客户端:WS 长连接 + hello 握手 + 密文请求/响应匹配 + 快照拉取 + 断线重连。
// 协议:.work/design/20261023-mobile-relay/protocol-v1.md。

import 'dart:async';
import 'package:flutter/foundation.dart';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'crypto.dart';
import 'credentials.dart';

enum RelayConnState { disconnected, connecting, online }

class RelayClient {
  final PairCredentials cred;
  final String selfId;
  late final List<int> _key;

  WebSocketChannel? _ws;
  RelayConnState state = RelayConnState.disconnected;
  String? lastError;
  DateTime? onlineSince;

  final _stateCtrl = StreamController<RelayConnState>.broadcast();
  Stream<RelayConnState> get stateStream => _stateCtrl.stream;

  /// 桌面端推送的解密后事件帧(`{"ev":"chat.event","data":{provider,projectId,tabId,payload}}`)。
  /// 广播流:对话页订阅后按 (projectId, tabId) 过滤。
  final _eventCtrl = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get events => _eventCtrl.stream;

  int _reqSeq = 0;
  final _pending = <String, Completer<Map<String, dynamic>>>{};
  Completer<Map<String, dynamic>?>? _snapshotWaiter;
  Timer? _pingTimer;
  Timer? _retryTimer;
  bool _closedByUser = false;
  // hello 被拒(bad token)= session 已被吊销/删除(删号/吊销会话/改密后服务器清理),
  // 重连必然再被拒;置位后停止自动重连,引导退出登录。手动 reconnectNow 可复位重试。
  bool _authDead = false;

  /// 当前 socket 的代次。旧 socket 迟到的 onDone/onError/bye 一律用代次丢弃,
  /// 否则会出现「连上→被中继踢旧→bye 触发 drop→重连→再被踢」的死循环。
  int _gen = 0;

  RelayClient({required this.cred, required this.selfId}) {
    _key = parseKey(cred.pairKeyB64);
  }

  void connect() {
    _closedByUser = false;
    final gen = ++_gen;
    _setState(RelayConnState.connecting);
    try {
      final ws = WebSocketChannel.connect(Uri.parse(cred.url));
      _ws = ws;
      ws.stream.listen(
        (d) => _onData(d, gen),
        onError: (e) => _drop("stream: $e", gen),
        onDone: () => _drop("closed", gen),
      );
      _send({"type": "hello", "userId": cred.userId, "deviceId": selfId, "role": "phone", "token": cred.token});
    } catch (e) {
      _drop("connect: $e", gen);
    }
  }

  /// 立即重连(页面回到前台时用):不等 5s 退避,先把旧 socket 关干净再连。
  void reconnectNow() {
    if (_closedByUser) return;
    _authDead = false; // 手动重连 = 显式意愿,允许再试一次(仍会再被拒则重新置位)
    _retryTimer?.cancel();
    _retryTimer = null;
    _pingTimer?.cancel();
    _pingTimer = null;
    final ws = _ws;
    _ws = null;
    try {
      ws?.sink.close();
    } catch (_) {}
    connect();
  }

  void _onData(Object? data, int gen) {
    if (gen != _gen) return; // 旧 socket 的迟到帧

    Map<String, dynamic> m;
    try {
      m = jsonDecode(data as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (m["type"]) {
      case "hello_ack":
        if (m["ok"] == true) {
          debugPrint("[relay] online (hello_ack ok)");
          lastError = null;
          _setState(RelayConnState.online);
          onlineSince = DateTime.now();
          _pingTimer?.cancel();
          _pingTimer = Timer.periodic(const Duration(seconds: 30), (_) => _send({"type": "ping"}));
        } else {
          // bad token = 凭证已死(session 被吊销/删除),停止自动重连避免无限循环;
          // 其他拒绝原因保持重连(可能是服务端瞬时状态)。
          _authDead = m["error"] == "bad token";
          _drop(_authDead ? "登录已失效,请退出后重新登录" : "hello rejected: ${m["error"]}", gen);
        }
        break;
      case "recv":
        _onRecv(m);
        break;
      case "send_result":
        if (m["ok"] != true) {
          // 桌面端离线:所有在途请求立即失败(不等超时)。
          final reason = m["reason"] ?? "send failed";
          for (final c in _pending.values) {
            c.completeError(StateError("desktop offline: $reason"));
          }
          _pending.clear();
        }
        break;
      case "snapshot_data":
        if (m["from"] == cred.desktopDeviceId && _snapshotWaiter != null) {
          final w = _snapshotWaiter!;
          _snapshotWaiter = null;
          final enc = m["enc"] as String?;
          if (enc == null || (m["ts"] ?? 0) == 0) {
            w.complete(null);
          } else {
            () async {
              final plain = utf8.decode(await open(_key, enc));
              w.complete(jsonDecode(plain) as Map<String, dynamic>);
            }().catchError((e) => w.complete(null));
          }
        }
        break;
      case "bye":
        _drop("replaced: ${m["reason"] ?? "bye"}", gen);
        break;
      default:
        break; // pong / error / snapshot_result 等
    }
  }

  Future<void> _onRecv(Map<String, dynamic> m) async {
    final enc = m["enc"] as String?;
    if (enc == null) return;
    try {
      final plain = utf8.decode(await open(_key, enc));
      final frame = jsonDecode(plain) as Map<String, dynamic>;
      final id = frame["id"] as String?;
      if (id != null && _pending.containsKey(id)) {
        debugPrint("[relay] recv resp $id ok=${frame["ok"]}");
        _pending.remove(id)!.complete(frame);
        return;
      }
      // 无 id = 桌面端主动推送(chat.event 等),交给订阅方。
      if (frame["ev"] != null) _eventCtrl.add(frame);
    } catch (e) {
      // 解密失败(密钥不符/损坏):不该发生,静默记。
      lastError = "decrypt: $e";
    }
  }

  /// 密文请求(15s 超时;桌面端离线由 send_result 立即触发失败)。
  Future<Map<String, dynamic>> request(String method, [Map<String, dynamic>? params]) {
    final id = "req-${++_reqSeq}";
    final completer = Completer<Map<String, dynamic>>();
    _pending[id] = completer;
    () async {
      final body = jsonEncode({"id": id, "method": method, "params": params ?? {}});
      final enc = await seal(_key, utf8.encode(body));
      _send({"type": "send", "to": cred.desktopDeviceId, "enc": enc});
    }().catchError((e) {
      _pending.remove(id)?.completeError(StateError("seil: $e"));
    });
    return completer.future.timeout(const Duration(seconds: 15), onTimeout: () {
      _pending.remove(id);
      throw TimeoutException("relay request $method");
    });
  }

  /// 拉离线快照(密文 blob 存于中继;电脑离线也可看)。经主 listener 分发,不另挂流。
  Future<Map<String, dynamic>?> fetchSnapshot() {
    final completer = Completer<Map<String, dynamic>?>();
    _snapshotWaiter = completer;
    _send({"type": "snapshot_get", "from": cred.desktopDeviceId});
    return completer.future.timeout(const Duration(seconds: 10), onTimeout: () {
      _snapshotWaiter = null;
      return null;
    });
  }

  void _send(Map<String, dynamic> m) {
    final ws = _ws;
    if (ws == null) return; // 未连接:调用方的 pending 会走 15s 超时
    try {
      ws.sink.add(jsonEncode(m));
    } catch (e) {
      _drop("send: $e", _gen);
    }
  }

  void _setState(RelayConnState s) {
    state = s;
    _stateCtrl.add(s);
  }

  /// 断线收尾。关键:**必须把当前 socket 关掉**——不关的话中继按 deviceId 踢旧
  /// 连接时会把 bye 送回同一个客户端实例,触发「连上 → 被踢 → 重连 → 再被踢」
  /// 的死循环(表现就是「一直掉线」)。同时自增代次,让这条 socket 之后迟到的
  /// onDone/onError 全部失效。
  void _drop(String reason, int gen) {
    if (gen != _gen) return;
    _gen++;
    lastError = reason;
    _pingTimer?.cancel();
    _pingTimer = null;
    _retryTimer?.cancel();
    _retryTimer = null;
    final ws = _ws;
    _ws = null;
    try {
      ws?.sink.close();
    } catch (_) {}
    if (state != RelayConnState.disconnected) _setState(RelayConnState.disconnected);
    for (final c in _pending.values) {
      c.completeError(StateError("relay dropped: $reason"));
    }
    _pending.clear();
    _snapshotWaiter?.complete(null);
    _snapshotWaiter = null;
    if (!_closedByUser && !_authDead && _retryTimer == null) {
      _retryTimer = Timer(const Duration(seconds: 5), () {
        _retryTimer = null;
        connect();
      });
    }
  }

  void dispose() {
    _closedByUser = true;
    _pingTimer?.cancel();
    _retryTimer?.cancel();
    _ws?.sink.close();
    _stateCtrl.close();
    _eventCtrl.close();
  }
}
