import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * 根级错误边界:捕获子树 render/生命周期/effect 同步抛错,渲染错误态而非整窗黑屏。
 *
 * 背景:本应用长期无 ErrorBoundary,任何组件 render 抛错(如 Monaco 对已 dispose 的 model
 * 操作 throw)会冒泡到 React 根,整棵树卸载 → 整窗纯深色「黑屏」无任何提示。本边界兜底,
 * 把错误信息 + stack 显式渲染出来,并提供「重置」恢复(重新挂载子树)。
 *
 * 注意:passive effect(useEffect)里的同步 throw 在不同 React 版本下不一定触发回退 UI,
 * 根因仍需在抛错点消除(见 [[FileEditor]] 的 disposed model guard);本边界主要兜 render/
 * 生命周期错误 + 把错误暴露给用户/开发者(而非无信息黑屏)。
 *
 * 文案硬编码中文(非 i18n):错误态是最后兜底,此时 i18n/React 子树可能已异常,不应再依赖它们。
 */
type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] 子树抛错:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid h-screen place-items-center bg-[#0b1020] p-6 text-center">
        <div className="max-w-xl">
          <div className="text-sm font-semibold text-[#f87171]">渲染出错</div>
          <pre className="mx-scroll-pretty mt-3 max-h-[40vh] overflow-auto rounded bg-[rgba(0,0,0,0.4)] p-3 text-left text-[11px] leading-relaxed text-[#cbd5e1]">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            className="mt-4 rounded-[var(--mx-radius-sm)] border border-[var(--mx-border)] px-3 py-1 text-xs text-[#cbd5e1] transition-colors hover:bg-[var(--mx-hover-bg)]"
          >
            重置
          </button>
        </div>
      </div>
    );
  }
}
