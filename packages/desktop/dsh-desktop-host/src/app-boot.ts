// **按 profile root 装配**这一步的唯一实现：profile root 由调用方给（dev 是 app 目录本身，打包是
// `$DSH_HOME/profiles/<name>`），装配清单来自它的 `package.json` 的 `dsh.profile.bundles`。
//
// web 形态（[`./web.ts`](./web.ts)）与桌面形态（[`./index.ts`](./index.ts)）都走这里——两形态同一条路，
// 差异只有 profile 名、形态自己的 overlay 与内层参数。**别再各写一份**：哪一层生效必须两边同源，
// 否则"dev 正常、打包不对"这类问题只能靠猜（曾经如此）。
//
// 这一层为什么薄：装配在「profile root 已定」之后是**数据**——清单、bundle 各自的 patch、profile 自己的
// `cordis.patch.yml`、以及形态自己的 overlay；代码只剩「读哪个目录、挂哪些 overlay、谁写根配置」。
// loader 的装载机制仍复用上游（`loadProfileDirectory` + `runProfile`），不另起第二套启动路径
// （理由见 `../.agents/designs/20260929-桌面host的运行时面与依赖边界.md`）。

import { join } from "node:path";
import {
  loadLayeredEnv,
  loadProfileDirectory,
  reportSkippedBundles,
} from "@deepseek-ai/dsh-app-boot";
import { runProfile } from "@deepseek-ai/dsh/profile-boot";
import type { RunProfileOptions } from "@deepseek-ai/dsh/profile-boot";

/** One booted app profile: the settled root context and its shutdown controller. */
export type AppProfileBoot = Awaited<ReturnType<typeof runProfile>>;

// **解析锚点 = profile 自己的清单**。
//
// 上游 `resolveBundleDir` 是两轮：先 `installAnchor`、再 `<profileDir>/package.json`——那是"官方安装面与
// profile 面分开"的年代的形状。完整闭包整体解压进 profile 之后两面合一：没有另一个安装面可指，锚点就是
// profile 自己（`@deepseek-ai/dsh` 也在它的 `node_modules` 里）。
/**
 * 闭包根（安装锚点）：官方 bundles 与 `dsh` 都由它解析。
 *
 * @param profileDir - profile 根（它的 `node_modules` 里是随包 tar 解压出来的完整闭包）。
 * @returns 锚点清单的绝对路径。
 */
export function installAnchorOf(profileDir: string): string {
  return join(profileDir, "package.json");
}

/** Inputs for one app profile boot. */
export interface AppProfileOptions {
  /** profile root：app 目录本身，或它的部署副本。 */
  readonly profileDir: string;
  /** 形态名（`desktop` / `web`）：给 `profileContext.name` 与按 profile 名门控的行。 */
  readonly profile: string;
  /** 形态自己的 overlay patch 文件，按 argv 顺序排在 bundle 层与 profile 自己的 patch 之后。 */
  readonly patchFiles?: readonly string[];
  /** 交给树的内层参数，由注入的 app 插件自己解析（如 web 的 `--port`）。 */
  readonly args?: readonly string[];
  /** 应用自己的包操作通道；缺省时插件页的包操作回退到进程 PATH。 */
  readonly packageManager?: RunProfileOptions["packageManager"];
}

/**
 * 按 app 目录装配并启动一次 profile：bundle 层来自 app 的清单，patch 栈是
 * 「bundle 层 → app 目录自己的 `cordis.patch.yml` → `patchFiles`」；空根配置 `cordis.yml`
 * 写在 profile root 内（由 `runProfile` 每次启动重写）。
 * @param options - profile root、安装根、形态名、overlay 与内层参数。
 * @returns 装配完成的上下文与关停控制器。
 * @throws 清单、bundle 自身的 patch、或 overlay 读不出来时（跳过的 bundle 只上报，不抛）。
 */
export async function bootAppProfile(options: AppProfileOptions): Promise<AppProfileBoot> {
  const installAnchor = installAnchorOf(options.profileDir);
  const profile = loadProfileDirectory("dsh", options.profileDir, installAnchor);
  // 加载跳过原因由启动方上报（与上游 desktop-host 同一口径）。
  reportSkippedBundles("dsh", profile);
  return await runProfile({
    environment: loadLayeredEnv("dsh"),
    profile: options.profile,
    resolvedProfile: { profile, installAnchor },
    patchFiles: [...(options.patchFiles ?? [])],
    args: [...(options.args ?? [])],
    ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
  });
}
