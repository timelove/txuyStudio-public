// BaoCode P0.3 借鉴 — 命令智能归类
//
// 借鉴:[BaoCode `step_folds.dart: commandAction()`](https://github.com/baocode-dev/baocode)
// 把 shell 命令归类为 read / search / list / run,让 StepFolds 折叠行读起来
// 语义化("Read 2 files, ran 1 command" 而非 "Ran 3 commands")。
//
// 实现要点:
// - 'cd ... &&' 前缀先去掉(cwd 切换不算行为意图)
// - '2>&1' / '2>/dev/null' 尾巴去掉(错误流重定向不算意图)
// - 含 [\n;>] / && / || / | → run(链/管道/重定向必然是组合行为)
// - 首 word 判定:
//   read:    cat | head | tail | nl | bat | less
//   search:  grep | egrep | rg | ag | find | fd
//   list:    ls | tree
//   其它:    run(sed 不含 -i 单独有 read 分支,见下)
//
// `sed -n '...' file` 当 read,'-i' 含则 run(原地编辑)。

export type CommandClass = "read" | "search" | "list" | "run";

export function classifyCommand(command: string): CommandClass {
  if (typeof command !== "string") return "run";
  let line = command.trim();
  if (line.length === 0) return "run";

  // 1. 'cd ... &&' 前缀剥离(cwd 切换不算真实意图)
  line = line.replace(/^cd\s+[^;&|]+\s*&&\s*/, "");

  // 2. 错误流重定向剥离(语义不变)
  line = line.replace(/\s+2>&1/g, "");
  line = line.replace(/\s+2>\/dev\/null/g, "");

  // 3. chain / pipeline / 重定向 → 一律 run(含单 | 是 baocode 规则的扩展,
  //    baocode 原文只判 || 不判 |,我们把单 | 也判为组合以覆盖 "cat a | grep b")
  if (/[\n;>]|&&|\|\||\|/.test(line)) return "run";

  // 4. 首 word 归类
  const words = line.split(/\s+/).filter(Boolean);
  const first = words[0] ?? "";

  if (first === "cat" || first === "head" || first === "tail" ||
      first === "nl" || first === "bat" || first === "less") {
    return "read";
  }
  if (first === "grep" || first === "egrep" || first === "rg" ||
      first === "ag" || first === "find" || first === "fd") {
    return "search";
  }
  if (first === "ls" || first === "tree") {
    return "list";
  }
  if (first === "sed") {
    // sed -n <pattern> file → 只读
    // 拆出短选项族(-nEi / -inE / -i 等),scattered GNU 短选项族任一含 i 都算有
    const opts = words
      .filter((w) => w.startsWith("-") && !w.startsWith("--"))
      .join("");
    const hasN = /n/.test(opts);
    const hasI = /i/.test(opts);
    if (hasN && !hasI) return "read";
    return "run";
  }

  return "run";
}
