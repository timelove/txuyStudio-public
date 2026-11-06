// E2E 加密:base64(nonce[12] || ciphertext || mac[16]),ChaCha20-Poly1305。
// 与 Rust crypto.rs / TS @noble/ciphers 完全同格式(三语言对等已验证)。

import 'dart:convert';
import 'dart:math';
import 'package:cryptography/cryptography.dart';

final _chacha = Chacha20.poly1305Aead();
final _random = Random.secure();

/// 加密明文 → 线格式 base64。
Future<String> seal(List<int> key, List<int> plaintext) async {
  final nonce = List<int>.generate(12, (_) => _random.nextInt(256));
  final box = await _chacha.encrypt(
    plaintext,
    secretKey: SecretKey(key),
    nonce: nonce,
  );
  final buf = [...nonce, ...box.cipherText, ...box.mac.bytes];
  return base64Encode(buf);
}

/// 解密线格式 base64 → 明文;失败抛异常(密钥不符/数据损坏)。
Future<List<int>> open(List<int> key, String payload) async {
  final raw = base64Decode(payload);
  if (raw.length < 12 + 16) throw const FormatException("payload too short");
  final nonce = raw.sublist(0, 12);
  final ct = raw.sublist(12, raw.length - 16);
  final mac = raw.sublist(raw.length - 16);
  return _chacha.decrypt(
    SecretBox(ct, nonce: nonce, mac: Mac(mac)),
    secretKey: SecretKey(key),
  );
}

/// 32B 随机密钥(配对 payload 里解析出的 pairKey 用)。
List<int> parseKey(String base64Key) {
  final raw = base64Decode(base64Key);
  if (raw.length != 32) throw FormatException("pairKey len ${raw.length} != 32");
  return raw;
}
