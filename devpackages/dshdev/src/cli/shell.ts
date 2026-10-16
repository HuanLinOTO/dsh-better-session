/**
 * 壳的装配（**prebuild**）：把 `@morlay/dsh-desktop-shell` 装到打包工作目录里，成为 Electron 的 app 目录。
 *
 * 边界就到这里为止：**产物只落在 `<workspace>/node_modules/.dshdev/shell/`**（打包工作目录，与 runtime /
 * seed 并列），源码树里的 `packages/desktop/dsh-desktop-shell/dist` 不再被 dev / bundle 依赖。
 *
 * 装配内容（壳要什么给什么）：
 * - `main.mjs`：**自动生成**的入口（真 JS；Electron 的 app 目录必须有它）。它只报包根、按包名加载
 *   业务入口——源码树里不需要一份手写的引导；
 * - **整包的源码**（`src/`、清单、本地化）——入口由 `main.mjs` 按包名加载，走清单的 `exports`；
 * - **不再产 `dist/`**：preload 的 CJS 由宿主机现场打包（见 `@morlay/dsh-desktop-host/preload-source`），
 *   壳在窗口创建前取走；
 * - `package.json`（`main` 指引导）与 `locale/`。
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundlePreload } from "@morlay/dsh-desktop-host/preload-source";
import { logOf } from "@local/devkit/log";
import { findWorkspaceRoot, runPnpm } from "./workspace.ts";

const log = logOf("dshdev");

// 壳包根：源码树里那个包（装配的输入）。工具里不写死包名，一律由 node 解析。
export const SHELL_PACKAGE_ROOT = dirname(
  fileURLToPath(import.meta.resolve("@morlay/dsh-desktop-shell/package.json")),
);

/** 装配后的壳（Electron 的 app 目录）。 */
export interface AssembledShell {
  /** app 目录（`.dshdev/shell`）。 */
  readonly root: string;
  /** 入口（`main`）：手写的引导。 */
  readonly entry: string;
}

/**
 * 装配壳这一单元（app 目录）。
 *
 * 内容是"壳 + 它的依赖"：依赖交给 `pnpm deploy`（无外链的真目录），源码与本地化整包拷过来，入口按包名生成。
 *
 * @param workRoot - 打包工作目录（调用方给的就是 `node_modules/.dshdev`）。
 * @returns 装配后的 app 目录与入口。
 */
export async function prepareShell(workRoot: string): Promise<AssembledShell> {
  const root = join(workRoot, "shell");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  log.info("shell %o", { dir: root, package: "@morlay/dsh-desktop-shell" });

  // 壳这一单元的依赖：**交给 `pnpm deploy`**（扁平解析面，事后由 `linkClosureTopLevel` 挂平），而不是
  // 手写链接或逐个挑包。它要什么由壳包自己的清单说了算（与壳构建时内联的同一份名单）。
  // `pnpm --filter` 要在**工作区根**跑（那里才有 `pnpm-workspace.yaml`）。
  await runPnpm(
    ["--filter", "@morlay/dsh-desktop-shell", "deploy", "--prod", "--ignore-scripts", root],
    await findWorkspaceRoot(SHELL_PACKAGE_ROOT),
  );
  log.info("shell.ready %o", { entries: await readdir(root) });
  // preload 的 CJS 在**这里**打好（运行时只读文件）：打包器是 native 模块，读不了 app.asar 内的源码。
  const preloadDir = join(root, "dist");
  await mkdir(preloadDir, { recursive: true });
  await writeFile(join(preloadDir, "preload.cjs"), await bundlePreload({ shellRoot: root }));
  log.info("shell.preload %o", { file: join("dist", "preload.cjs") });

  // 入口**自动生成**：Electron 的 app 目录必须有一个真 JS 入口，内容就三件事——报出包根、让 Node 能跑
  // `node_modules` 下的 `.ts`、按**包名**加载业务入口（走本目录清单的 `exports`）。
  const entry = join(root, "main.mjs");
  await writeFile(
    entry,
    [
      "// 由 `dshdev` 装配时生成（见 devpackages/dshdev/src/cli/shell.ts）：不手写、不参与仓库构建。",
      "globalThis.__DSH_SHELL_ROOT__ = import.meta.dirname;",
      "",
      "// Electron 打包后不把主进程的 stderr 送出去，这里兜一层：入口失败时至少留下原因。",
      "try {",
      "  // 先让 Node（含 Electron 的主进程）能跑 `node_modules` 下的 `.ts`：这条链的源码都是 TS（app 目录",
      "  // 是 deploy 出来的、上游包经 exports 指到 src），而 Node 内建的类型剥离拒绝对 `node_modules` 动手。",
      "  // 那份注册钩子在**随包 runtime** 里（`../runtime/loader/`，dev 由 dshdev 备、打包由 prepareRuntime 备）。",
      '  await import(new URL("../runtime/loader/register.mjs", import.meta.url).href);',
      "  // 业务入口：按**包名**加载，走壳包清单的 `exports`（指向 `src/index.ts`）。",
      '  await import("@morlay/dsh-desktop-shell");',
      "} catch (error) {",
      '  console.error("[dsh-shell] 入口失败:", error);',
      "  throw error;",
      "}",
      "",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, entry };
}
