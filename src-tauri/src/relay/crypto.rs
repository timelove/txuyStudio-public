//! E2E 加密封装:base64(nonce[12] || ciphertext+tag[16]),ChaCha20-Poly1305。
//! 密钥 = 配对二维码里的 pairKey(32B)。中继只见密文,本模块是两端共同的唯一封包格式。

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};

/// 加密明文 → base64(nonce || ct+tag)。
pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<String, String> {
    let cipher = ChaCha20Poly1305::new(key.into());
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("seal: {e}"))?;
    let mut buf = Vec::with_capacity(12 + ct.len());
    buf.extend_from_slice(nonce.as_slice());
    buf.extend_from_slice(&ct);
    Ok(B64.encode(buf))
}

/// 解密 base64(nonce || ct+tag) → 明文。
pub fn open(key: &[u8; 32], payload: &str) -> Result<Vec<u8>, String> {
    let raw = B64
        .decode(payload)
        .map_err(|e| format!("open base64: {e}"))?;
    if raw.len() < 12 + 16 {
        return Err("open: payload too short".into());
    }
    let (nonce, ct) = raw.split_at(12);
    let cipher = ChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(Nonce::from_slice(nonce), ct)
        .map_err(|e| format!("open: {e}"))
}

/// 32B 随机密钥 → base64(配对二维码 pairKey 字段)。
pub fn generate_pair_key() -> [u8; 32] {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

