import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useTranslation } from "react-i18next";
import type { OpenFile } from "../domain/fileTree";
import type { ModelPool } from "../domain/fileTree";
import { useSettings } from "../settings/SettingsProvider";

/**
 * 文件编辑器(探针右栏 text 态)。单 `<Editor>` 实例 + **model 池**:每个打开文件一个
 * `monaco.editor.ITextModel`(按 `Uri.file(path)` 全局存活),切文件时 `editor.setModel(model)`
 * + save/restoreViewState 保留滚动/光标/折叠。
 *
 * **为何不用多 editor 实例 + display 切换(TerminalPane 范式)**:xterm 终端绑死 PTY 不能换 model,
 * 必须常驻;Monaco 相反,model 是一等公民,天生为 setModel 切换设计。多 editor 还有 display:none
 * 布局错乱 + 20 实例内存(60-100MB)问题。model 池(VS Code 做法)1 editor + 20 model 约 10-20MB。
 *
 * **跨 unmount 存活**:model 池 ref 提升到 FileTreePane(不随本组件 unmount);viewState 存 OpenFile
 * (FileTreePane state)。本组件切到 image/binary pane 会 unmount,再切回 text remount——model
 * (按 URI 全局)与 viewState(OpenFile)都跨 unmount 存活。
 *
 * **`<Editor>` 当壳但不传 path/value/defaultValue**:传 value(controlled)会和打字打架;传 path
 * 会触发它自建隐藏 model 缓存与手动池冲突。onMount 立即 setModel 覆盖它的默认 model。
 *
 * 批次4:只读(mode=preview)。批次5 加 edit 模式(readOnly toggle + onChange→dirty + 5s 保存)。
 */
type FileEditorProps = {
  /** 活动文件(只处理 kind==="text")。 */
  file: OpenFile;
  /** model 池(提升到 FileTreePane,跨本组件 unmount 存活)。 */
  modelPool: ModelPool;
  /** mode:preview=只读、edit=可编辑(批次5)。 */
  mode: "preview" | "edit";
  /** viewState 变化时上提到 FileTreePane(存 OpenFile.viewState)。 */
  onViewStateChange: (path: string, viewState: unknown) => void;
  /** 内容变化时上提(FileTreePane 启动 5s 保存 + 标 dirty)。仅 edit 模式触发。 */
  onContentChange: (path: string) => void;
};

export function FileEditor({ file, modelPool, mode, onViewStateChange, onContentChange }: FileEditorProps) {
  const { t } = useTranslation();
  const { fontSize } = useSettings();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  // 当前 editor 挂载的 model path(用于 path 变化时 saveViewState 旧 model)。
  const currentPathRef = useRef<string | null>(null);

  /** 取或建 model(按 URI 全局)。content/language 仅建时用(已有 model 复用,不覆盖编辑内容)。 */
  const getOrCreateModel = (monaco: typeof Monaco, path: string, content: string, language: string) => {
    const uri = monaco.Uri.file(path);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(content, language, uri);
      modelPool.set(path, model);
    }
    return model;
  };

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    const model = getOrCreateModel(monaco, file.path, file.content ?? "", file.language);
    editor.setModel(model);
    // 恢复 viewState(跨 unmount 存活在 OpenFile)。
    if (file.viewState) {
      editor.restoreViewState(file.viewState as Monaco.editor.ICodeEditorViewState);
    }
    currentPathRef.current = file.path;
    // 内容变化 → 上提(FileTreePane 启动 5s 保存 + 标 dirty)。仅 edit 模式有意义,但统一上提由父层判 mode。
    editor.onDidChangeModelContent(() => {
      const p = currentPathRef.current;
      if (p) onContentChange(p);
    });
  };

  // path 变化:saveViewState(旧)→ 上提 → setModel(新)→ restoreViewState(新)。
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    if (currentPathRef.current === file.path) return;

    // 存旧 model 的 viewState 上提(若旧 path 还在 OpenFile 里)。
    // Monaco editor 在 model 被 dispose 时同步 setModel(null) 解绑(_modelData=null),
    // saveViewState() 此时返回 null(不抛),故无需额外 guard。
    if (currentPathRef.current) {
      const vs = editor.saveViewState();
      if (vs) onViewStateChange(currentPathRef.current, vs);
    }
    const model = getOrCreateModel(monaco, file.path, file.content ?? "", file.language);
    editor.setModel(model);
    if (file.viewState) {
      editor.restoreViewState(file.viewState as Monaco.editor.ICodeEditorViewState);
    }
    currentPathRef.current = file.path;
  }, [file.path, file.content, file.language, file.viewState, onViewStateChange]);

  // mode 变化:切 readOnly(preview↔edit)。
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.updateOptions({ readOnly: mode === "preview", domReadOnly: mode === "preview" });
  }, [mode]);

  // unmount cleanup:存当前 viewState 上提(model 池在 FileTreePane,不 dispose)。
  // model 池靠下方 <Editor keepCurrentModel> 跨本组件 unmount 存活(pe 不再自动 dispose),
  // 故此处 model 仍活,saveViewState 正常返回;释放交 FileTreePane.disposeModel。
  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      if (!editor || !currentPathRef.current) return;
      const vs = editor.saveViewState();
      if (vs) onViewStateChange(currentPathRef.current, vs);
    };
  }, [onViewStateChange]);

  return (
    <Editor
      theme="mx-dark"
      // keepCurrentModel:堵住 @monaco-editor/react unmount(pe)自动 dispose 当前 model。
      // model 池提升到 FileTreePane 跨 unmount 存活,但 pe()(keepCurrentModel 默认 false)会在
      // unmount 时 getModel()?.dispose()——md edit→preview / 活动文件切 image|binary|null 都触发
      // unmount,把仍开着的活动文件 model dispose,池里留悬空 entry,之后 render 期 mdModel.getValue()
      // 抛 "Model is disposed!" → 黑屏。keepCurrentModel 让 pe() 只 saveViewState 不 dispose;
      // 释放交 FileTreePane.disposeModel(关文件/LRU/切 rootPath/unmount 批量 dispose)。
      keepCurrentModel
      // 不传 path/value/defaultValue:onMount 里 setModel 接管。
      options={{
        readOnly: mode === "preview",
        domReadOnly: mode === "preview",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: mode === "edit" ? "line" : "none",
        fontFamily: "var(--mx-mono, Consolas, monospace)",
        fontSize,
        lineNumbersMinChars: 4,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
        wordWrap: "on",
        automaticLayout: true,
      }}
      onMount={onMount}
      loading={<div className="grid h-full place-items-center text-[11px] text-[var(--mx-faint)]">{t("preview.editorLoading")}</div>}
    />
  );
}
