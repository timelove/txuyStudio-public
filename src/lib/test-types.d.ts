// Bun test runner 类型声明 — 项目未装 vitest/jest,统一用 `bun test`(Bun 内置)。
// 详细 API 见 https://bun.sh/docs/test/writing-tests

declare module "bun:test" {
  type AnyFn = (...args: any[]) => any;
  type AsyncAnyFn = (...args: any[]) => Promise<any> | any;
  interface DescribeOptions {
    skip?: boolean;
    todo?: boolean;
    timeout?: number;
  }
  interface ItOptions {
    skip?: boolean;
    todo?: boolean;
    timeout?: number;
  }

  export const describe: {
    (name: string, fn: () => void): void;
    (options: DescribeOptions, name: string, fn: () => void): void;
    each: <T extends readonly any[] | [any]>(
      cases: readonly T[],
    ) => (name: string, fn: (...args: T extends readonly (infer U)[] ? U[] : any[]) => void) => void;
    skip: (name: string, fn: () => void) => void;
    todo: (name: string, fn: () => void) => void;
  };
  export const it: {
    (name: string, fn: AsyncAnyFn): void;
    (name: string, fn: AnyFn): void;
    (options: ItOptions, name: string, fn: AsyncAnyFn): void;
    (options: ItOptions, name: string, fn: AnyFn): void;
    skip: (name: string, fn: AsyncAnyFn) => void;
    skip: (name: string, fn: AnyFn) => void;
    todo: (name: string, fn: AsyncAnyFn) => void;
    each: <T extends readonly any[] | [any]>(
      cases: readonly T[],
    ) => (name: string, fn: (...args: T extends readonly (infer U)[] ? U[] : any[]) => void) => void;
  };
  export const test: typeof it;
  export const beforeAll: (fn: AsyncAnyFn, timeout?: number) => void;
  export const beforeEach: (fn: AsyncAnyFn, timeout?: number) => void;
  export const afterAll: (fn: AsyncAnyFn, timeout?: number) => void;
  export const afterEach: (fn: AsyncAnyFn, timeout?: number) => void;

  export const expect: any;

  export const jest: {
    fn: (impl?: AnyFn) => any;
    spyOn: (obj: any, method: string) => any;
    mock: (mod: any) => any;
  };
}
