import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { mockProjects } from "./mock/mockProjects";
import { AppShell } from "./components/AppShell";
import { I18nProvider } from "./i18n/I18nProvider";
import { useTranslation } from "react-i18next";
import type { BackendAppSnapshot } from "./domain/appState";
import type { ProjectId, ProjectSnapshot } from "./domain/projects";
import { deriveProjects } from "./domain/projectDeriver";

/**
 * 多项目工作台根组件。
 *
 * 阶段2：项目列表来自后端 `hydrate_window` 持久化状态（不再直连 mock）。
 * 纯浏览器环境（`bun run dev`，无 Tauri）invoke 会抛错，回退 `mockProjects`，
 * 保证前端开发不依赖桌面运行时。
 *
 * 阶段4（独立项目窗口）：
 * - 启动期读 `getCurrentWindow().label` + URL query 判定模式：
 *   `main` → 主窗口；`project-<id>` 或 `?mode=project` → 单项目窗口。
 * - `hydrate_window` 传入真实 windowLabel + routeHint，独立窗口后端只回该单个项目。
 * - 主窗口维护 `detachedProjectIds`（运行期标记，不持久化），已弹出的项目在主窗口隐藏；
 *   监听 `project-window-closed` 事件恢复显示。重启 = 所有项目自动 dock back（不持久化）。
 *
 * 加载态：hydrate 期间渲染深色 `LoadingSurface`（避免白屏无反馈）。
 * `hydrate_window` 套 8s 超时兜底——后端卡住也自动回退 mock，不再永久白屏。
 */
const HYDRATE_TIMEOUT_MS = 8000;

/** 独立项目窗口 label 前缀，与后端 `windows.rs` 对齐。 */
const PROJECT_WINDOW_PREFIX = "project-";

/** 启动期解析窗口身份。非 Tauri 环境（纯浏览器 dev）回退 main 模式。 */
function resolveWindowMode(): { isMain: boolean; label: string; routeProjectId: string | null } {
  try {
    const label = getCurrentWindow().label;
    // URL query 作为 hint（后端建窗时注入 ?mode=project&projectId=<id>）。
    const params = new URLSearchParams(globalThis.location.search);
    const mode = params.get("mode");
    const qProjectId = params.get("projectId");
    if (label.startsWith(PROJECT_WINDOW_PREFIX) || mode === "project") {
      // routeProjectId 优先取 query，回退 label 去前缀（label 形如 project-<id>）。
      const pid = qProjectId ?? (label.startsWith(PROJECT_WINDOW_PREFIX) ? label.slice(PROJECT_WINDOW_PREFIX.length) : null);
      return { isMain: false, label, routeProjectId: pid };
    }
    return { isMain: true, label: label || "main", routeProjectId: null };
  } catch {
    // 非 Tauri 环境：纯浏览器 dev，按主窗口走（走 mock 兜底）。
    return { isMain: true, label: "main", routeProjectId: null };
  }
}

export default function App() {
  const mode = useMemo(resolveWindowMode, []);
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<ProjectId | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  /** 后端持久化的界面语言(hydrate 后传入 I18nProvider 作权威初始值;非 Tauri 兜底用 localStorage/系统)。 */
  const [locale, setLocale] = useState<string | null | undefined>(undefined);

  // 主窗口运行期标记：哪些项目已弹出为独立窗口（隐藏在主窗口列表里）。不持久化。
  const [detachedProjectIds, setDetachedProjectIds] = useState<Set<ProjectId>>(new Set());

  // 启动 hydrate：按窗口身份传 windowLabel/routeHint。独立窗口后端只回该单个项目。
  useEffect(() => {
    let cancelled = false;

    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
      Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error(`hydrate timed out after ${ms}ms`)), ms),
        ),
      ]);

    const fallbackToMock = () => {
      // 单项目模式无 mock 对应项 → 给空列表（独立窗口在浏览器 dev 下无意义）。
      if (mode.isMain) {
        setProjects(mockProjects.projects);
        setActiveProjectId(mockProjects.activeProjectId);
      }
      setLoadState("ready");
    };

    withTimeout(
      invoke<BackendAppSnapshot>("hydrate_window", {
        windowLabel: mode.label,
        routeHint: mode.routeProjectId,
      }),
      HYDRATE_TIMEOUT_MS,
    )
      .then((snap) => {
        if (cancelled) return;
        setProjects(deriveProjects(snap));
        setActiveProjectId(snap.activeProjectId);
        setLocale(snap.locale ?? null);
        setLoadState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        // 非 Tauri 环境、命令不可用或超时 → 回退 mock，保证前端可见、不白屏。
        console.warn("[App] hydrate failed, falling back to mockProjects:", err);
        fallbackToMock();
      });

    return () => {
      cancelled = true;
    };
  }, [mode]);

  // 主窗口：监听独立窗口关闭事件，恢复该项目的显示。
  // 独立窗口 dock back 或被直接叉掉 → 后端 emit "project-window-closed"(payload = window_label)。
  // payload 形如 "project-<projectId>"，解析出 projectId 后从 detached 集合移除。
  useEffect(() => {
    if (!mode.isMain) return;
    let unlisten: (() => void) | undefined;
    listen<string>("project-window-closed", (e) => {
      const label = e.payload;
      if (typeof label !== "string") return;
      if (label.startsWith(PROJECT_WINDOW_PREFIX)) {
        const pid = label.slice(PROJECT_WINDOW_PREFIX.length);
        setDetachedProjectIds((prev) => {
          if (!prev.has(pid)) return prev;
          const next = new Set(prev);
          next.delete(pid);
          return next;
        });
      }
    })
      .then((u) => {
        unlisten = u;
        return null;
      })
      .catch((err) => console.warn("[App] listen project-window-closed failed:", err));
    return () => {
      unlisten?.();
    };
  }, [mode.isMain]);

  const handleSelect = useCallback((projectId: ProjectId) => {
    // 乐观更新：UI 立即切换，后端落 active。
    setActiveProjectId(projectId);
    invoke("set_active_project", { projectId }).catch((err) => {
      console.warn("[App] set_active_project failed:", err);
    });
  }, []);

  const handleAdd = useCallback(async () => {
    // 后端调起系统文件夹选择器；返回最新快照。
    try {
      const snap = await invoke<BackendAppSnapshot>("open_project");
      setProjects(deriveProjects(snap));
      setActiveProjectId(snap.activeProjectId);
    } catch (err) {
      console.error("[App] open_project failed:", err);
    }
  }, []);

  const handleCloseProject = useCallback(async (projectId: ProjectId) => {
    // 后端 kill 该项目所有 PTY + 移除记录 + 落盘;返回最新 snap(可能为空 active)。
    try {
      const snap = await invoke<BackendAppSnapshot>("close_project", { projectId });
      setProjects(deriveProjects(snap));
      setActiveProjectId(snap.activeProjectId);
      // 关闭的项目若曾 detached,也清掉标记。
      setDetachedProjectIds((prev) => {
        if (!prev.has(projectId)) return prev;
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
    } catch (err) {
      console.error("[App] close_project failed:", err);
    }
  }, []);

  // 主窗口:把项目弹出为独立窗口。后端建窗后,标记 detached 让主窗口隐藏该项目。
  // 若该窗口已存在,后端会聚焦复用(仍标记 detached,幂等)。
  const handleDetach = useCallback(async (projectId: ProjectId) => {
    try {
      const label = await invoke<string>("open_project_window", { projectId });
      // label 形如 project-<projectId>;校验一致后标记。
      if (label === `${PROJECT_WINDOW_PREFIX}${projectId}`) {
        setDetachedProjectIds((prev) => {
          if (prev.has(projectId)) return prev;
          const next = new Set(prev);
          next.add(projectId);
          return next;
        });
      }
    } catch (err) {
      console.error("[App] open_project_window failed:", err);
    }
  }, []);

  // 独立窗口:dock back 回主窗口。关掉自己即可,后端 emit 事件让主窗口恢复显示。
  const handleDockBack = useCallback(async () => {
    if (mode.isMain) return;
    try {
      await invoke("close_project_window", { windowLabel: mode.label });
    } catch (err) {
      console.error("[App] close_project_window failed:", err);
    }
  }, [mode]);

  if (loadState === "loading") {
    return (
      <I18nProvider initialLocale={locale}>
        <LoadingSurface />
      </I18nProvider>
    );
  }

  // 单项目模式:hydrate 后端已只回该单个项目,projects 即 [该项目];主窗口为全量列表。
  // detachedProjectIds 仅主窗口有意义(标记哪些项目已弹出、应在主窗口隐藏)。
  return (
    <I18nProvider initialLocale={locale}>
      <AppShell
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={handleSelect}
        onAddProject={mode.isMain ? handleAdd : undefined}
        onCloseProject={mode.isMain ? handleCloseProject : undefined}
        onDetachProject={mode.isMain ? handleDetach : undefined}
        detachedProjectIds={mode.isMain ? detachedProjectIds : new Set()}
        singleProjectMode={!mode.isMain}
        onDockBack={mode.isMain ? undefined : handleDockBack}
      />
    </I18nProvider>
  );
}

/** 启动加载占位：深色全屏 + 品牌标入场动画 + indeterminate 进度条。
 *
 * 与 `index.html` 中的 `#boot-splash` 视觉一致（深色 + 居中渐变 M），
 * 首帧切换不可见；在 hydrate 期间通过 logo 呼吸 + 进度条循环提供持续反馈，
 * 避免「等很久但不知道在做什么」。
 */
function LoadingSurface() {
  const { t } = useTranslation();
  return (
    <div className="mx-boot grid min-h-screen place-items-center bg-[#070a12]">
      <div className="flex flex-col items-center gap-3">
        <div className="mx-boot-logo grid h-7 w-7 place-items-center rounded-none font-extrabold text-white bg-[linear-gradient(135deg,#7c3aed,#22d3ee)]">
          M
        </div>
        <div className="mx-boot-bar h-[2px] w-28 overflow-hidden bg-white/5">
          <div className="mx-boot-bar-fill h-full bg-[linear-gradient(90deg,transparent,#22d3ee,transparent)]" />
        </div>
        <div className="text-xs text-[#94a3b8]">{t("app.loadingWorkspace")}</div>
      </div>
    </div>
  );
}
