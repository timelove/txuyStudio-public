/**
 * `!` 命令内联执行 PowerShell 的前端模型与归并纯函数。
 *
 * 后端(`src-tauri/src/shell_run`)spawn 一次性 powershell 子进程,逐行读 stdout/stderr
 * 并分类成 `ShellEventPayload` emit `shell-event` 事件。本文件:
 * - 定义事件 payload 类型(与后端 `ShellEventPayload` 的 snake_case kind 标签对齐);
 * - 定义归并后的 UI 消息模型(`ShellMessage`);
 * - 提供归并纯函数,把事件流归并成消息列表。
 *
 * **与 claude 流完全独立**:shell 消息不进 `ClaudeStreamState.messages`(那里只含
 * user/assistant/compact,且 hasPendingPlan 等派生逻辑依赖末条消息语义,塞 shell 会污染)。
 * 本文件是独立的状态 + 归并,零 React/Tauri 依赖,与 `claudeStream.ts` 同风格。
 */

// —— 后端事件 payload(与 `ShellEventPayload` 的 snake_case kind 标签对齐) ——

/** 后端 emit 的 shell-event 事件外壳。 */
export type ShellEvent = {
  projectId: string;
  tabId: string;
  payload: ShellEventPayload;
};

/** 分类后的 shell 事件。`kind` 标签是 snake_case(后端 `#[serde(tag="kind", rename_all="snake_case")]`)。 */
export type ShellEventPayload =
  | { kind: "start"; id: string; command: string }
  | { kind: "output"; id: string; chunk: string; stream: "stdout" | "stderr" }
  | { kind: "done"; id: string; exitCode: number | null }
  | { kind: "interrupted"; id: string };

// —— 归并后的 UI 模型 ——

/** 单条 `!` 命令的执行状态(驱动 ShellRow 的状态药丸 + 输出折叠)。 */
export type ShellStatus = "running" | "done" | "error" | "interrupted";

/**
 * 归并后的 UI 消息(一条 `!` 命令的执行)。
 *
 * - `output`:逐行累积的输出(stdout/stderr 拼接,stderr 行前缀标记由渲染层着色区分)。
 *   为保留 stream 信息用于着色,output 存 `OutputLine[]` 而非裸 string。
 * - `status`:running(执行中)/ done(正常结束 exit 0)/ error(非 0 exit)/ interrupted(用户中断)。
 * - `exitCode`:done/error 时的退出码。
 */
export type ShellOutputLine = { stream: "stdout" | "stderr"; text: string };

export type ShellMessage = {
  id: string;
  role: "shell";
  command: string;
  output: ShellOutputLine[];
  status: ShellStatus;
  exitCode?: number | null;
  /** 发起时刻(ms epoch),用于消息排序。 */
  timestamp: number;
};

/** applyShellEvent 的累积状态(类比 `ClaudeStreamState`,但极简)。 */
export type ShellRunState = {
  messages: ShellMessage[];
  /** 是否有命令在执行(驱动发送按钮锁定)。 */
  running: boolean;
};

export const initialShellRunState: ShellRunState = {
  messages: [],
  running: false,
};

/**
 * 剥离 ANSI 转义序列(CSI SGR 颜色 `[3X;1m`、光标移动等)。
 *
 * PowerShell 的 Format-Table / 多数 CLI(git --color / rg)在管道输出中仍可能带 ANSI 颜色码,
 * 前端 `<pre>` 不解析它们会显示成 `[32;1m...[0m` 乱码。ShellRow 用 stream 字段自己着色
 * (stdout 默认 / stderr 红),不依赖 ANSI,故归并时统一剥离得到干净文本。
 *
 * 覆盖 CSI(`ESC [`)与 OSC(`ESC ]`)序列,以及裸 ESC + 单字符(如 `ESC c`)。
 */
const ANSI_RE = /\x1b\][^\x07]*\x07?|\x1b\[[0-9;?]*[A-Za-z]|\x1b[@-Z\\-_]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * 纯函数:把一个事件 payload 归并进 state,返回新 state(不可变更新)。
 *
 * 归并规则:
 * - start:push 一条 running 消息(空 output),running=true。
 * - output:找到 id 对应消息,output 追加一行(stream 区分 stdout/stderr)。
 * - done:找到 id 对应消息,置 status(done 若 exitCode=0 / error 若非 0)+ exitCode;running 复位
 *   (仅当该 id 是当前 running 的那条)。
 * - interrupted:找到 id 对应消息置 interrupted;running 复位。id 为空(后端兜底)→ 复位当前 running 的。
 */
export function applyShellEvent(state: ShellRunState, payload: ShellEventPayload): ShellRunState {
  const messages = [...state.messages];

  switch (payload.kind) {
    case "start": {
      // 去重:同 id 已有消息(双 listener 等异常路径重复投递)不重复 push,否则幽灵消息
      // 永久 running(其 done 只会配对到首条)。幂等返回原 state。
      if (messages.some((m) => m.id === payload.id)) return state;
      // 陈旧兜底:后端同 tab 单命令语义,新 start 出现说明旧命令已结束(其 done/interrupted
      // 事件丢失,如 app 重载)。仍 running 的旧消息标记 interrupted,防永久「运行中」假状态。
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].status === "running") {
          messages[i] = { ...messages[i], status: "interrupted" };
        }
      }
      messages.push({
        id: payload.id,
        role: "shell",
        command: payload.command,
        output: [],
        status: "running",
        timestamp: Date.now(),
      });
      return { messages, running: true };
    }
    case "output": {
      const idx = messages.findIndex((m) => m.id === payload.id);
      if (idx === -1) return { messages, running: state.running };
      const prev = messages[idx];
      messages[idx] = {
        ...prev,
        output: [...prev.output, { stream: payload.stream, text: stripAnsi(payload.chunk) }],
      };
      return { messages, running: state.running };
    }
    case "done": {
      const idx = messages.findIndex((m) => m.id === payload.id);
      const isCurrentRunning = idx !== -1 && messages[idx].status === "running";
      if (idx !== -1) {
        const prev = messages[idx];
        // exitCode===0 → done;非 0 → error;null(无法获取)→ done(中性,不误报失败)。
        messages[idx] = {
          ...prev,
          status: payload.exitCode == null ? "done" : payload.exitCode === 0 ? "done" : "error",
          exitCode: payload.exitCode,
        };
      }
      // running 复位:仅当本条是当前 running 的(避免旧命令的 done 误复位新命令的 running)。
      return { messages, running: isCurrentRunning ? false : state.running };
    }
    case "interrupted": {
      if (payload.id) {
        const idx = messages.findIndex((m) => m.id === payload.id);
        const isCurrentRunning = idx !== -1 && messages[idx].status === "running";
        if (idx !== -1) {
          messages[idx] = { ...messages[idx], status: "interrupted" };
        }
        return { messages, running: isCurrentRunning ? false : state.running };
      }
      // id 为空(后端兜底中断):复位当前 running 的那条。
      const runningIdx = messages.findIndex((m) => m.status === "running");
      if (runningIdx !== -1) {
        messages[runningIdx] = { ...messages[runningIdx], status: "interrupted" };
        return { messages, running: false };
      }
      return { messages, running: state.running };
    }
    default:
      return state;
  }
}
