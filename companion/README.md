# companion/ 启动脚本

移动伴侣(手机/网页遥控桌面端)的一键启动入口。App 源码在 `companion/app/`
(Flutter),启动器与源码同仓管理。

## 用法

| 脚本 | 作用 |
|---|---|
| `start-relay.bat` | 启动中继服务(:8787);桌面端与网页端都连它 |
| `start-web.bat` | 启动网页版(`app/` 这个 Flutter 项目),浏览器访问 http://localhost:8899 |

**启动顺序**:先 `start-relay.bat`,再启动桌面端(`bun run tauri dev` 或正式版),
最后 `start-web.bat`。

> cmd 里运行注意:若 shell 设了 `NoDefaultCurrentDirectoryInExePath=1`(VS Code /
> Claude Code 终端常见),要写 `.\start-web.bat`,不能只写文件名。双击运行不受影响。

> **端口守卫**:`start-web.bat` 启动前先查 `:8899`。若已被占用(常见是上次没退干净的
> `flutter run`),脚本会直接退出并打印占用进程 PID、`tasklist` 查看命令和
> `taskkill /PID <pid> /F` 结束命令,不会带着旧 bundle 硬起。

两个 bat 都是 **CRLF + 纯 ASCII**(提示文案用英文),这是刻意的:非 ASCII 字符写在
`.bat` 里会被默认代码页误解析,炸出 `'��' is not recognized` 之类无关报错;保留
`chcp 65001` 是为了让 relay / Flutter 自己输出的 UTF-8 中文日志正常显示。

## 配对

桌面端 → 设置 → 移动伴侣,任一方式:

- 点「复制配对 JSON」→ 网页配对页点「从剪贴板读取并配对」
- 或直接把 `#pair=...` 直达链接贴进浏览器(打开即自动配对)

## 说明

- 视觉:奶油金主题,与桌面端 `[data-theme="cream-gold"]` 同口径,色板单一真源在
  `app/lib/theme.dart`(桌面端改动时同步这里)
- Flutter SDK 固定用 `D:\work\Android\flutterVersion\flutter3.47.7`(旧 3.13.6 保留不冲突)
- 已内置国内 pub 镜像(`pub.flutter-io.cn`),避免 `pub get` 卡住
- 网页端为**开发模式**(热重载);正式静态包见后续 `build-web` 计划
- Windows 原生桌面版/Android APK 为后续阶段(需补 VS C++ 桌面工作负载)

协议与设计文档:`.work/design/20261023-mobile-relay/`
