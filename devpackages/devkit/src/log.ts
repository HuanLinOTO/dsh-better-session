import { format } from "node:util";

/**
 * CLI 工具的日志出口：**名字交给出口**（`logOf(scope)`），消息走 printf 风格——值与结构作为参数传
 * （`%s` / `%o`），不拼 `key=value` 文本。与运行时那条链的 `ctx.logger` 同一套写法（那边是
 * `ctx.logger(name)` + printf 参数），于是全仓的日志只有一个风格。
 *
 * 分工（见 `.agents/standards/how-to-write.md`）：
 * - 运行时插件（cordis 树内）→ `ctx.logger`；
 * - 壳（Electron 主进程，无树）→ 壳自己的 `shellLog`（落 `$DSH_HOME/logs/shell.log`）；
 * - CLI 工具（`dshdev`、`dts-prepare`、`typert-generator`…，无树）→ 这里；
 * - 注入到页面/preload 的脚本（浏览器里跑）与构建期插件（面向构建者）→ 仍用 `console`。
 */

/** 一个带名字的日志出口。 */
export interface Log {
  /** 进度与里程碑：stdout（面向正在跑命令的人）。 */
  readonly info: (message: string, ...args: readonly unknown[]) => void;
  /** 失败：stderr。错误本身也当参数传（`%o` / `%s`），别拼进文本。 */
  readonly fail: (message: string, ...args: readonly unknown[]) => void;
}

/**
 * 取一个具名日志出口。
 * @param scope - 这个名字前缀（如 `dshdev` / `dshdev bundle`）。
 * @returns `info` 与 `fail` 两个出口，都按 printf 风格格式化。
 */
export function logOf(scope: string): Log {
  return {
    info(message, ...args) {
      process.stdout.write(`${scope}: ${format(message, ...args)}\n`);
    },
    fail(message, ...args) {
      process.stderr.write(`${scope}: ${format(message, ...args)}\n`);
    },
  };
}
