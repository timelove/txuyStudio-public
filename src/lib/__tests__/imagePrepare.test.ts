// BaoCode P0.1 — imagePrepare 单元测试
//
// 跑法(项目根目录):
//   bun test src/lib/__tests__/imagePrepare.test.ts
//
// 覆盖:s sniffMediaType 4 类 + 边界(空 / 截断 / 错头)
// prepareImage 在 Node/Bun 环境 OffscreenCanvas 缺,只能测「无 OffscreenCanvas 即抛」边界,
// 真正的缩放逻辑在 GUI 端 paste 4000×3000 验证。

import { describe, expect, it } from "bun:test";
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, sniffMediaType } from "../imagePrepare";

describe("sniffMediaType", () => {
  describe("png", () => {
    it("识别完整 PNG MAGIC(89 50 4E 47 0D 0A 1A 0A)", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff]);
      expect(sniffMediaType(bytes)).toBe("image/png");
    });

    it("只取前 4 字节命中也认(image/png 普遍做法)", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      expect(sniffMediaType(bytes)).toBe("image/png");
    });
  });

  describe("jpeg", () => {
    it("识别 JPEG SOI(FF D8 FF)", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(sniffMediaType(bytes)).toBe("image/jpeg");
    });

    it("JPEG APP0 但 SOI 完整 → 仍认 image/jpeg", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1]);
      expect(sniffMediaType(bytes)).toBe("image/jpeg");
    });
  });

  describe("gif", () => {
    it("识别 GIF87a", () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0xff, 0xff]);
      expect(sniffMediaType(bytes)).toBe("image/gif");
    });

    it("识别 GIF89a", () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff, 0xff]);
      expect(sniffMediaType(bytes)).toBe("image/gif");
    });

    it("GIF magic 后缺版本位 → null", () => {
      // GIF84a 不是合法 gif 标识(只有 87a/89a)
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x34, 0x61]);
      expect(sniffMediaType(bytes)).toBeNull();
    });
  });

  describe("webp", () => {
    it("识别 RIFF....WEBP", () => {
      // RIFF(0-3) + 文件大小(4-7) + WEBP(8-11)
      const bytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x1a, 0x00, 0x00, 0x00, // file size (LE,任意)
        0x57, 0x45, 0x42, 0x50, // WEBP
        0x56, 0x50, 0x38, 0x4c, // VP8L(典型 payload 头,这里不重要)
      ]);
      expect(sniffMediaType(bytes)).toBe("image/webp");
    });

    it("缺 WEBP 标记 → null(AVI/WAV 都是 RIFF 头)", () => {
      const bytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46,
        0x24, 0x00, 0x00, 0x00,
        0x41, 0x56, 0x49, 0x20, // AVI
      ]);
      expect(sniffMediaType(bytes)).toBeNull();
    });
  });

  describe("boundary / negative", () => {
    it("空字节 → null", () => {
      expect(sniffMediaType(new Uint8Array(0))).toBeNull();
    });

    it("单字节(无 MAGIC) → null", () => {
      expect(sniffMediaType(new Uint8Array([0x89]))).toBeNull();
    });

    it("截断 PNG(只到 50 4E,缺第三字节) → null", () => {
      const bytes = new Uint8Array([0x89, 0x50]);
      expect(sniffMediaType(bytes)).toBeNull();
    });

    it("纯文本(假装是 png) → null", () => {
      const bytes = new Uint8Array([0x70, 0x6e, 0x67, 0x21]); // "png!"
      expect(sniffMediaType(bytes)).toBeNull();
    });

    it("错头 PNG(MAGIC 第二字节错) → null", () => {
      const bytes = new Uint8Array([0x89, 0x00, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(sniffMediaType(bytes)).toBeNull();
    });

    it("bmp(0x42 0x4D)→ null(未实现 bmp sniff)", () => {
      // baocode 也只支持 4 类,bmp 走概率中 TIFF/bmp 边界,显式拒绝即可
      const bytes = new Uint8Array([0x42, 0x4d, 0xff, 0xff, 0x00, 0x00]);
      expect(sniffMediaType(bytes)).toBeNull();
    });
  });
});

describe("constants", () => {
  it("MAX_IMAGE_SIDE = 1568(baocode 对齐)", () => {
    expect(MAX_IMAGE_SIDE).toBe(1568);
  });

  it("MAX_IMAGE_BYTES = 3.75MB(对应 5MB base64)", () => {
    expect(MAX_IMAGE_BYTES).toBe(3_750_000);
  });
});
