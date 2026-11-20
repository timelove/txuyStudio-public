use std::{
    env, fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;
const DEFAULT_CREDENTIALS: &str = r"secrets\minio\credentials.json";

#[derive(Debug)]
struct Args {
    credentials: PathBuf,
    bucket: String,
    base_url: String,
    version: String,
    notes_file: PathBuf,
    desktop_setup: PathBuf,
    desktop_signature: PathBuf,
    android_apk: Option<PathBuf>,
    dry_run: bool,
}

#[derive(Debug, Deserialize)]
struct CredentialsFile {
    url: String,
    #[serde(rename = "accessKey")]
    access_key: String,
    #[serde(rename = "secretKey")]
    secret_key: String,
}

#[derive(Debug, Serialize)]
struct DesktopManifest<'a> {
    version: &'a str,
    notes: &'a str,
    pub_date: String,
    platforms: DesktopPlatforms<'a>,
}
#[derive(Debug, Serialize)]
struct DesktopPlatforms<'a> {
    #[serde(rename = "windows-x86_64")]
    windows_x86_64: DesktopTarget<'a>,
}
#[derive(Debug, Serialize)]
struct DesktopTarget<'a> {
    signature: &'a str,
    url: String,
}
#[derive(Debug, Serialize)]
struct AndroidManifest {
    version: String,
    name: String,
    notes: String,
    #[serde(rename = "publishedAt")]
    published_at: String,
    #[serde(rename = "downloadUrl")]
    download_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse(env::args().skip(1))?;
    let base_url = normalize_base_url(&args.base_url)?;
    validate_version(&args.version)?;
    let notes = fs::read_to_string(&args.notes_file)
        .with_context(|| format!("读取更新日志失败: {}", args.notes_file.display()))?;
    require_file(&args.desktop_setup, "桌面安装包")?;
    require_file(&args.desktop_signature, "桌面签名")?;
    if let Some(apk) = &args.android_apk {
        require_file(apk, "Android APK")?;
    }

    let setup_name = file_name(&args.desktop_setup)?;
    // 全部产物挂 app/ 前缀(桶匿名读只开 app/*,2026-11-18 用户定);客户端 base
    // URL 配到 .../txuy/app,拼 /desktop/latest.json、/android/latest.json 即命中。
    let setup_key = format!("app/desktop/{}/{}", args.version, setup_name);
    let signature_key = format!("{}.sig", setup_key);
    let signature = fs::read_to_string(&args.desktop_signature)
        .with_context(|| format!("读取签名失败: {}", args.desktop_signature.display()))?
        .trim()
        .to_owned();
    if signature.is_empty() {
        bail!("桌面签名文件为空");
    }
    let desktop_manifest = serde_json::to_vec_pretty(&DesktopManifest {
        version: &args.version,
        notes: &notes,
        pub_date: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        platforms: DesktopPlatforms {
            windows_x86_64: DesktopTarget {
                signature: &signature,
                url: format!("{}/{}", base_url, setup_key),
            },
        },
    })?;
    let android: Option<(String, Vec<u8>)> = args.android_apk.as_ref().map(|apk| {
        let name = file_name(apk).expect("validated APK path");
        let key = format!("app/android/{}/{}", args.version, name);
        let manifest = serde_json::to_vec_pretty(&AndroidManifest {
            version: args.version.clone(),
            name: format!("txuyStudio companion v{}", args.version),
            notes: notes.clone(),
            published_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            download_url: format!("{}/{}", base_url, key),
        })
        .expect("Android manifest serialization");
        (key, manifest)
    });

    println!("desktop object: {}", setup_key);
    if let Some((key, _)) = &android {
        println!("android object: {}", key);
    }
    if args.dry_run {
        return Ok(());
    }

    let credentials = read_credentials(&args.credentials)?;
    let client = Client::new();
    upload_file(
        &client,
        &credentials,
        &args.bucket,
        &setup_key,
        &args.desktop_setup,
        "application/vnd.microsoft.portable-executable",
    )
    .await?;
    upload_file(
        &client,
        &credentials,
        &args.bucket,
        &signature_key,
        &args.desktop_signature,
        "text/plain; charset=utf-8",
    )
    .await?;
    if let Some(apk) = &args.android_apk {
        let (key, _) = android.as_ref().expect("Android manifest exists");
        upload_file(
            &client,
            &credentials,
            &args.bucket,
            key,
            apk,
            "application/vnd.android.package-archive",
        )
        .await?;
    }
    upload_bytes(
        &client,
        &credentials,
        &args.bucket,
        "app/desktop/latest.json",
        &desktop_manifest,
        "application/json; charset=utf-8",
    )
    .await?;
    if let Some((_, manifest)) = android {
        upload_bytes(
            &client,
            &credentials,
            &args.bucket,
            "app/android/latest.json",
            &manifest,
            "application/json; charset=utf-8",
        )
        .await?;
    }
    println!("发布完成: v{} -> {}", args.version, args.bucket);
    Ok(())
}

impl Args {
    fn parse<I>(mut it: I) -> Result<Self>
    where
        I: Iterator<Item = String>,
    {
        let mut out = Self {
            credentials: PathBuf::from(DEFAULT_CREDENTIALS),
            bucket: "txuy".into(),
            base_url: String::new(),
            version: String::new(),
            notes_file: PathBuf::new(),
            desktop_setup: PathBuf::new(),
            desktop_signature: PathBuf::new(),
            android_apk: None,
            dry_run: false,
        };
        while let Some(arg) = it.next() {
            if arg == "--dry-run" {
                out.dry_run = true;
                continue;
            }
            let mut value = || -> Result<String> {
                it.next().with_context(|| format!("缺少 {} 的值", arg))
            };
            match arg.as_str() {
                "--credentials" => out.credentials = value()?.into(),
                "--bucket" => out.bucket = value()?,
                "--base-url" => out.base_url = value()?,
                "--version" => out.version = value()?,
                "--notes-file" => out.notes_file = value()?.into(),
                "--desktop-setup" => out.desktop_setup = value()?.into(),
                "--desktop-signature" => out.desktop_signature = value()?.into(),
                "--android-apk" => out.android_apk = Some(value()?.into()),
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                _ => bail!("未知参数: {}", arg),
            }
        }
        if out.base_url.is_empty()
            || out.version.is_empty()
            || out.notes_file.as_os_str().is_empty()
            || out.desktop_setup.as_os_str().is_empty()
            || out.desktop_signature.as_os_str().is_empty()
        {
            print_help();
            bail!("缺少必填参数");
        }
        Ok(out)
    }
}

fn print_help() {
    println!("参数: --base-url URL --version VERSION --notes-file FILE --desktop-setup EXE --desktop-signature SIG [--android-apk APK] [--dry-run]");
}

fn read_credentials(path: &Path) -> Result<CredentialsFile> {
    let raw = fs::read_to_string(path)
        .with_context(|| format!("读取 MinIO 凭据失败: {}", path.display()))?;
    let raw: CredentialsFile = serde_json::from_str(&raw).context("解析 credentials.json 失败")?;
    if raw.url.trim().is_empty() || raw.access_key.is_empty() || raw.secret_key.is_empty() {
        bail!("credentials.json 缺少 url/accessKey/secretKey");
    }
    Ok(CredentialsFile {
        url: normalize_minio_endpoint(&raw.url),
        ..raw
    })
}

async fn upload_file(
    client: &Client,
    credentials: &CredentialsFile,
    bucket: &str,
    key: &str,
    path: &Path,
    content_type: &str,
) -> Result<()> {
    let bytes = tokio::fs::read(path)
        .await
        .with_context(|| format!("读取上传文件失败: {}", path.display()))?;
    upload_bytes(client, credentials, bucket, key, &bytes, content_type).await
}

async fn upload_bytes(
    client: &Client,
    credentials: &CredentialsFile,
    bucket: &str,
    key: &str,
    bytes: &[u8],
    content_type: &str,
) -> Result<()> {
    let url = Url::parse(&format!(
        "{}/{}/{}",
        credentials.url.trim_end_matches('/'),
        bucket,
        key
    ))
    .context("MinIO endpoint URL 无效")?;
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let short_date = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest(bytes));
    let host = url.host_str().context("MinIO URL 缺少 host")?;
    // 经 nginx 路径前缀反代(如 http://host/minio-file/s3)时,代理剥掉前缀后
    // MinIO 收到的是 /{bucket}/... —— V4 验签按后端收到的路径算,canonical_uri
    // 必须去掉 endpoint 的 path 前缀。直连(无 path)时原样。
    let ep_path = Url::parse(credentials.url.trim_end_matches('/'))
        .map(|u| u.path().trim_end_matches('/').to_string())
        .unwrap_or_default();
    let canonical_uri: &str = if ep_path.is_empty() {
        url.path()
    } else {
        url.path().strip_prefix(&ep_path).unwrap_or(url.path())
    };
    let canonical_headers = format!(
        "content-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        content_type, host, payload_hash, amz_date
    );
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "PUT\n{}\n\n{}\n{}\n{}",
        canonical_uri, canonical_headers, signed_headers, payload_hash
    );
    let scope = format!("{}/us-east-1/s3/aws4_request", short_date);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        scope,
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let signature = hex::encode(hmac_bytes(
        &signing_key(&credentials.secret_key, &short_date),
        string_to_sign.as_bytes(),
    ));
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        credentials.access_key, scope, signed_headers, signature
    );
    let response = client
        .request(Method::PUT, url)
        .header("Content-Type", content_type)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", amz_date)
        .header("Authorization", authorization)
        .body(bytes.to_vec())
        .send()
        .await
        .context("请求 MinIO 上传接口失败")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        bail!("上传 {} 失败: {} {}", key, status, body);
    }
    println!("uploaded {} ({} bytes)", key, bytes.len());
    Ok(())
}

fn signing_key(secret: &str, date: &str) -> Vec<u8> {
    let date_key = hmac_bytes(format!("AWS4{}", secret).as_bytes(), date.as_bytes());
    let region_key = hmac_bytes(&date_key, b"us-east-1");
    let service_key = hmac_bytes(&region_key, b"s3");
    hmac_bytes(&service_key, b"aws4_request")
}
fn hmac_bytes(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC key");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}
fn normalize_minio_endpoint(url: &str) -> String {
    let marker = "/console/api/v1/service-account-credentials";
    url.split_once(marker)
        .map(|(prefix, _)| prefix)
        .unwrap_or(url)
        .trim_end_matches('/')
        .to_owned()
}
fn normalize_base_url(value: &str) -> Result<String> {
    let value = value.trim().trim_end_matches('/');
    if !(value.starts_with("https://") || value.starts_with("http://")) || value.len() <= 8 {
        bail!("--base-url 必须是 http(s) URL");
    }
    Ok(value.to_owned())
}
fn validate_version(version: &str) -> Result<()> {
    if version.is_empty()
        || version.contains('/')
        || version.contains('\\')
        || version.contains("..")
    {
        bail!("版本号非法: {}", version);
    }
    Ok(())
}
fn require_file(path: &Path, label: &str) -> Result<()> {
    if !path.is_file() {
        bail!("{}不存在: {}", label, path.display());
    }
    Ok(())
}
fn file_name(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .with_context(|| format!("无法取得文件名: {}", path.display()))
}
