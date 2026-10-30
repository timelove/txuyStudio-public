// BaoCode P4.2 — alwaysAllowMemory 单元测试
// 跑法:bun test src/lib/__tests__/alwaysAllowMemory.test.ts
import { describe, expect, it } from "bun:test";
import {
  EMPTY_HISTORY,
  type AlwaysAllowHistory,
  readAlwaysAllowHistory,
  recordAlwaysAllowDecision,
  suggestAlwaysAllow,
  writeAlwaysAllowHistory,
} from "../alwaysAllowMemory";

class MemStorage {
  private store = new Map<string, string>();
  getItem(k: string) {
    return this.store.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.store.set(k, v);
  }
  removeItem(k: string) {
    this.store.delete(k);
  }
  clear() {
    this.store.clear();
  }
}

describe("readAlwaysAllowHistory", () => {
  it("空 storage → EMPTY_HISTORY", () => {
    expect(readAlwaysAllowHistory("Bash", new MemStorage())).toEqual(EMPTY_HISTORY);
  });
  it("无 storage(null)→ EMPTY_HISTORY(Node 兼容)", () => {
    expect(readAlwaysAllowHistory("Bash", null)).toEqual(EMPTY_HISTORY);
  });
  it("坏 JSON → EMPTY_HISTORY(静默)", () => {
    const s = new MemStorage();
    s.setItem("mx.alwaysAllow.Bash", "not-json{");
    expect(readAlwaysAllowHistory("Bash", s)).toEqual(EMPTY_HISTORY);
  });
  it("合法 history → 还原", () => {
    const s = new MemStorage();
    s.setItem("mx.alwaysAllow.Edit", JSON.stringify({ allowOnce: 1, allowAlways: 3, deny: 0, lastDecision: "allowAlways" }));
    expect(readAlwaysAllowHistory("Edit", s)).toEqual({
      allowOnce: 1,
      allowAlways: 3,
      deny: 0,
      lastDecision: "allowAlways",
    });
  });
  it("部分字段缺失 → 缺字段用 default", () => {
    const s = new MemStorage();
    s.setItem("mx.alwaysAllow.Bash", JSON.stringify({ allowAlways: 2 }));
    expect(readAlwaysAllowHistory("Bash", s).allowAlways).toBe(2);
    expect(readAlwaysAllowHistory("Bash", s).allowOnce).toBe(0);
  });
});

describe("writeAlwaysAllowHistory", () => {
  it("正常写", () => {
    const s = new MemStorage();
    writeAlwaysAllowHistory("Edit", { allowOnce: 1, allowAlways: 2, deny: 0, lastDecision: "allowAlways" }, s);
    expect(s.getItem("mx.alwaysAllow.Edit")).toContain("allowAlways");
  });
  it("null storage → noop(不抛)", () => {
    expect(() => writeAlwaysAllowHistory("X", { ...EMPTY_HISTORY }, null)).not.toThrow();
  });
});

describe("recordAlwaysAllowDecision", () => {
  it("计数累加 + lastDecision 更新", () => {
    const h0: AlwaysAllowHistory = { ...EMPTY_HISTORY };
    const h1 = recordAlwaysAllowDecision("Bash", "allowOnce", h0);
    expect(h1.allowOnce).toBe(1);
    expect(h1.lastDecision).toBe("allowOnce");
    const h2 = recordAlwaysAllowDecision("Bash", "allowAlways", h1);
    expect(h2.allowAlways).toBe(1);
    expect(h2.allowOnce).toBe(1);
    expect(h2.lastDecision).toBe("allowAlways");
  });
  it("原 history 不变(不可变)", () => {
    const h0: AlwaysAllowHistory = { ...EMPTY_HISTORY };
    recordAlwaysAllowDecision("Bash", "allowOnce", h0);
    expect(h0.allowOnce).toBe(0);
  });
});

describe("suggestAlwaysAllow", () => {
  it("无历史 → allowOnce(安全默认)", () => {
    expect(suggestAlwaysAllow(EMPTY_HISTORY)).toBe("allowOnce");
  });
  it("多数 allowAlways → allowAlways", () => {
    expect(suggestAlwaysAllow({ allowOnce: 1, allowAlways: 5, deny: 1, lastDecision: "allowAlways" })).toBe("allowAlways");
  });
  it("多数 deny → deny", () => {
    expect(suggestAlwaysAllow({ allowOnce: 1, allowAlways: 0, deny: 4, lastDecision: "deny" })).toBe("deny");
  });
  it("平衡(allowOnce 多)→ allowOnce", () => {
    expect(suggestAlwaysAllow({ allowOnce: 3, allowAlways: 1, deny: 0, lastDecision: "allowOnce" })).toBe("allowOnce");
  });
  it("完全平衡 → allowOnce(tie-break 安全默认)", () => {
    expect(suggestAlwaysAllow({ allowOnce: 1, allowAlways: 1, deny: 1, lastDecision: null })).toBe("allowOnce");
  });
});
