// BaoCode P0.1 借鉴 — 图片缩放 + 字节嗅探
//
// 借鉴:[BaoCode `composer_images.dart`](https://github.com/baocode-dev/baocode)
// - > 1568px → 缩放到 1568px 长边(Claude/GPT-4V max side 限制)
// - > 3.75MB → 同上缩压
// - sniff:image/png | image/jpeg | image/gif | image/webp,MAGIC bytes 嗅探(不依赖 MIME)
//
// 设计原则:
// - sniffMediaType 是纯函数(只读 Uint8Array 前 N 字节),Node/Bun 环境可单测
// - prepareImage 走 OffscreenCanvas(浏览器原生,Node 测不起),GUI 手动验证
//   阈值常量与 baocode 一致,后续可以根据目标模型调整

export type SupportedImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export interface PreparedImage {
  bytes: Uint8Array;
  mediaType: SupportedImageMediaType;
  /** 缩放后的尺寸(原样则与输入一致)。null 表未 sniff 不予处理。 */
  width: number;
  height: number;
  /** true 表经过缩放重存,false 表原样落出。 */
  scaled: boolean;
}

/** 模型通用长边限 — Claude Code / GPT-4V 实测 ~1568px。 */
export const MAX_IMAGE_SIDE = 1568;

/** 5MB once base64-encoded。3.75MB 二进制 = 5MB base64。 */
export const MAX_IMAGE_BYTES = 3_750_000;

/**
 * 嗅探字节首部,推断图片类型。
 *
 * 不依赖 MIME(`File.type` 在某些剪贴板/拖拽路径为空或错),
 * 直接按 MAGIC bytes 判定:[png] / [jpeg SOI] / [gif87a/89a] / [RIFF...WEBP]。
 *
 * 节点环境(无 Image)也能调,适合 runtime 边界(进入 Claude panes 前)。
 */
export function sniffMediaType(bytes: Uint8Array): SupportedImageMediaType | null {
  const len = bytes.length;
  const startsWith = (magic: readonly number[], at = 0): boolean => {
    if (len < at + magic.length) return false;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[at + i] !== magic[i]) return false;
    }
    return true;
  };

  // PNG:89 50 4E 47 0D 0A 1A 0A
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  // JPEG:FF D8 FF
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF:GIF87a / GIF89a(头 4 字节"GIF8" + index 4 是 7/9 + index 5 是 'a')
  if (
    startsWith([0x47, 0x49, 0x46, 0x38]) &&
    len >= 6 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP:RIFF .... WEBP(52 49 46 46 .... 57 45 42 50)
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

/**
 * 全量预处理:sniff + (>1568px 或 >3.75MB)走 OffscreenCanvas 缩放,重存 PNG。
 *
 * 返回 null 表字节不是支持的图片类型(调用方按文本处理或提示用户)。
 *
 * 仅浏览器调用 — 内部依赖 `OffscreenCanvas` + `createImageBitmap`。Node 环境
 * 直接抛 `Error("OffscreenCanvas unavailable")`。建议调用方先 `sniffMediaType`
 * 过滤 mime,再尝试本函数;失败捕获后降级处理。
 */
export async function prepareImage(
  bytes: Uint8Array,
): Promise<PreparedImage | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    throw new Error("OffscreenCanvas unavailable; prepareImage 需浏览器环境调用");
  }
  const mediaType = sniffMediaType(bytes);
  if (mediaType === null) return null;

  // 强制 ArrayBuffer-backed 副本:TS 5.7 把 Uint8Array 标成 Uint8Array<ArrayBufferLike>,
  // 其中可能含 SharedArrayBuffer 后端,lib.dom 的 BlobPart 不接受 → 复制确保 ArrayBuffer 后端。
  const buf = bytes.slice().buffer;
  const blob = new Blob([buf], { type: mediaType });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    const width = bitmap.width;
    const height = bitmap.height;
    const longest = Math.max(width, height);
    const oversized = longest > MAX_IMAGE_SIDE || bytes.length > MAX_IMAGE_BYTES;
    if (!oversized) {
      return { bytes, mediaType, width, height, scaled: false };
    }
    const scale = Math.min(1.0, MAX_IMAGE_SIDE / longest);
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    const outBytes = new Uint8Array(await outBlob.arrayBuffer());
    return {
      bytes: outBytes,
      mediaType: "image/png",
      width: targetW,
      height: targetH,
      scaled: true,
    };
  } finally {
    bitmap.close();
  }
}

/**
 * 把文件或 blob 转 Uint8Array。sniff/prepare 都接收 Uint8Array,便于测试纯函数化。
 */
export async function toBytes(input: Blob | File): Promise<Uint8Array> {
  const buffer = await input.arrayBuffer();
  return new Uint8Array(buffer);
}
