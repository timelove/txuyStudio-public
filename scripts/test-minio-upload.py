# -*- coding: utf-8 -*-
"""MinIO 经 nginx 代理地址(http://47.102.87.100/minio-file)上传/下载连通性测试。
AWS V4 签名与 src-tauri release_publisher.rs 同款算法。不打印 secretKey。"""
import hashlib, hmac, datetime, sys, urllib.request

ENDPOINT = "http://47.102.87.100/minio-file/s3"   # nginx 代理 base(剥此后缀转发 MinIO)
BUCKET = "txuy"
KEY = "test/upload-test.txt"
ACCESS = "ttN9MkSOpV12wYjjQFal"
SECRET = "iCc22bApeSDd5Q4Fm4ty4NGibkz3ZcwiZbHCm28G"

def sign(method, url, payload_hash, now):
    u = urllib.request.urlparse(url)
    host = u.netloc
    # nginx 剥 endpoint path 前缀后 MinIO 收到的是 /txuy/... —— V4 验签按后端
    # 收到的路径算,故 canonical_uri 必须去掉代理前缀(host 用请求原样 Host)。
    canonical_path = u.path[len(urllib.request.urlparse(ENDPOINT).path):] or "/"
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    short = now.strftime("%Y%m%d")
    ctype = "text/plain; charset=utf-8"
    headers = f"content-type:{ctype}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
    signed = "content-type;host;x-amz-content-sha256;x-amz-date"
    canonical = f"{method}\n{canonical_path}\n\n{headers}\n{signed}\n{payload_hash}"
    scope = f"{short}/us-east-1/s3/aws4_request"
    sts = f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"
    def hb(k, d): return hmac.new(k, d.encode(), hashlib.sha256).digest()
    sk = hb(hb(hb(hb(("AWS4" + SECRET).encode(), short), "us-east-1"), "s3"), "aws4_request")
    sig = hmac.new(sk, sts.encode(), hashlib.sha256).hexdigest()
    return {
        "Content-Type": ctype,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
        "Authorization": f"AWS4-HMAC-SHA256 Credential={ACCESS}/{scope}, SignedHeaders={signed}, Signature={sig}",
    }

def req(method, url, body=None):
    ph = hashlib.sha256(body or b"").hexdigest()
    r = urllib.request.Request(url, data=body, method=method)
    for k, v in sign(method, url, ph, datetime.datetime.utcnow()).items():
        r.add_header(k, v)
    try:
        resp = urllib.request.urlopen(r, timeout=20)
        return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

body = f"txuy upload test {datetime.datetime.utcnow().isoformat()}".encode()
st, out = req("PUT", f"{ENDPOINT}/{BUCKET}/{KEY}", body)
print(f"PUT  {BUCKET}/{KEY} -> {st}", out[:200].decode(errors="replace") if st >= 400 else "")
if st >= 400:
    sys.exit(1)

st2, got = req("GET", f"{ENDPOINT}/{BUCKET}/{KEY}")
print(f"GET  {BUCKET}/{KEY} -> {st2}")
if st2 >= 400:
    sys.exit(1)
print("roundtrip:", "OK" if got == body else f"MISMATCH (sent {len(body)}B, got {len(got)}B)")
