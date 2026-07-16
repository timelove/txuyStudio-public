import { useTranslation } from "react-i18next";
import type { OpenFile } from "../domain/fileTree";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/Tooltip";

/**
 * 文件预览面板(探针右栏,纯展示组件)。
 *
 * M2 重构:从「自带 readFile 生命周期的有状态单文件预览」改为**纯展示**——接收已加载的
 * `OpenFile`,按 kind 渲染:图片(base64 data URL)/ 二进制(不可预览)/ 错误 / 加载中。
 * readFile 生命周期与标签池管理上移到 [[FileTreePane]];text 文件由 [[FileEditor]] 渲染
 * (model 池),不进本组件。
 *
 * 防 NUL/非 UTF-8 判二进制、图片扩展名集合与后端 `is_image_ext` 保持一致。
 */

/** 图片扩展名(与后端 is_image_ext 一致;小写)。 */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

/** 扩展名 → Monaco language id。未命中返回 "plaintext"。 */
export function guessLang(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript", json: "json", jsonc: "json",
    rs: "rust", py: "python", go: "go", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    rb: "ruby", php: "php", swift: "swift", scala: "scala", sh: "shell",
    bash: "shell", zsh: "shell", ps1: "powershell", bat: "bat", cmd: "bat",
    md: "markdown", markdown: "markdown", yaml: "yaml", yml: "yaml",
    toml: "ini", ini: "ini", css: "css", scss: "scss", less: "less",
    html: "html", htm: "html", xml: "xml", svg: "xml", sql: "sql",
    dockerfile: "dockerfile", makefile: "makefile", graphql: "graphql",
    gql: "graphql", lua: "lua", r: "r", dart: "dart", elixir: "elixir",
    ex: "elixir", erl: "erlang", clj: "clojure", cljs: "clojure",
    vim: "vim", pl: "perl", pm: "perl", f90: "fortran", f: "fortran",
    asm: "asm", s: "asm", vue: "html", svelte: "html",
  };
  // Dockerfile / Makefile 等无扩展名文件按 basename 识别。
  const base = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  return map[ext] ?? "plaintext";
}

/** 是否图片(与后端 is_image_ext 一致)。 */
export function isImage(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext);
}

/** 字节 → 人类可读(如 1.2 KB / 3.4 MB)。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 提取 path 的 basename(显示在标签/顶栏)。 */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * 探针右栏主体。file=null → 空态(未选文件);loading → 加载中;否则按 file.kind 分发。
 * text 不进本组件(FileTreePane 用 FileEditor 渲染);本组件只管 image/binary/error。
 */
export function FilePreview({ file, loading }: { file: OpenFile | null; loading: boolean }) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#0b1020]">
      {/* 顶栏:文件名 + 大小(image/binary/error 态)。 */}
      {file && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--mx-border)] px-2 py-1 text-[10px] text-[var(--mx-muted)]">
          <Tooltip>
          <TooltipTrigger asChild>
          <span className="truncate font-mono">{basename(file.path)}</span>
          </TooltipTrigger>
          <TooltipContent>{file.path}</TooltipContent>
          </Tooltip>
          {file.size > 0 && <span className="shrink-0 tabular-nums text-[var(--mx-faint)]">{formatBytes(file.size)}</span>}
        </div>
      )}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {loading && (
          <div className="grid h-full place-items-center text-[11px] text-[var(--mx-faint)]">{t("common.loading")}</div>
        )}
        {!loading && !file && (
          <div className="grid h-full place-items-center px-4 text-center text-[11px] text-[var(--mx-faint)]">
            {t("preview.selectFile")}
          </div>
        )}
        {!loading && file?.kind === "error" && (
          <div className="grid h-full place-items-center px-4 text-center text-[11px] text-[#f87171]">
            {t("preview.readError", { error: file.error ?? "" })}
          </div>
        )}
        {!loading && file?.kind === "binary" && (
          <div className="grid h-full place-items-center px-4 text-center text-[11px] text-[var(--mx-faint)]">
            <div>
              <div>{t("preview.binary")}</div>
              {file.size > 0 && <div className="mt-1 tabular-nums">{formatBytes(file.size)}</div>}
            </div>
          </div>
        )}
        {!loading && file?.kind === "image" && file.content && file.mime && (
          <div className="mx-scroll-pretty grid h-full place-items-center overflow-auto p-2">
            <img
              src={`data:${file.mime};base64,${file.content}`}
              alt={basename(file.path)}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
      </div>
    </div>
  );
}
