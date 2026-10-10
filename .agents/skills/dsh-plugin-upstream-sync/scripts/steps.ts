import { glob, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pathExists, runInherited, type UpstreamPaths } from "./common.ts";
import { rewriteExports } from "./exports.ts";

// `<vendor>/steps.ts` 的两阶段清单（`export const patch` / `export const prebuild`）与执行器；任一步骤
// 失败即失败——上游已变化，评估更新 / 删除 / 新增，不跳过。清单用 TS 写：每条步骤就地注释「为什么」。
//
// - `patch`：改上游工作树（裁剪、打补丁、exports 改写），**从 sync 的干净基线跑一次**；不是所有步骤都
//   幂等（`text` 第二次跑就"未匹配"），重复执行请先 sync。
// - `prebuild`：生成源码面消费的产物（typert 生成物）、编译不得不编译的 native addon、删上游 tsconfig
//   （口径收口）。顺序有依赖：typert 分析靠上游根的 face tsconfig（`tsconfig.host.json` /
//   `tsconfig.client.json`）找贡献者包，删 tsconfig 只能排在它之后——因此重跑同样从 sync 开始。

export type Step =
  | { type: "rm"; path: string }
  | { type: "rm"; glob: string }
  | { type: "text"; file: string; pattern: string; flags?: string; to?: string }
  | { type: "git"; patch: string }
  | {
      type: "exports";
      /** 出口名 → 生成物文件：目标是 `prebuild` 阶段写出的 `.ts`，不是 `lib/*.js`。 */
      generated: Record<string, string>;
      /** 包名 →（出口名 → 源文件）：`lib→src` 同构规则推不出来的出口。 */
      explicit: Record<string, Record<string, string>>;
    }
  | { type: "typert" }
  | { type: "native" };

export type Phase = "patch" | "prebuild";

// 脚本一律用 `pnpm dlx @oxc-node/cli` 驱动（oxc transformer + resolver 直跑 TS），不走 `node --import`。
const OXC_CLI = ["dlx", "@oxc-node/cli"];

// `typert` 步骤：直接编排上游 analyzer/emitter 生成 typert 产物，写成 `.ts`
// （`lib/typert.<face>.ts`、`lib/typert.remote-client.ts`），避免开发 / 桌面形态为这两个出口再构建一次上游。
// 它不调用 `WorkspaceTypertGenerator.generate`——那条路径带 lib 形态的强制契约校验。
async function generateTypertArtifacts(dir: string): Promise<void> {
  const entry = pathToFileURL(join(dir, "packages", "typert", "generator", "src", "index.ts")).href;
  const generator = (await import(entry)) as {
    WorkspaceCaches: new () => object;
    WorkspaceAnalyzer: new (options: Record<string, unknown>) => {
      discoverPackages(): { package: string }[];
      analyze(): { faces: readonly { packages: readonly { name: string; root: string }[] }[] };
    };
    FaceModelEmitter: new (face: unknown) => {
      emit(packageName: string): {
        face: string;
        js: string;
        remote?: { js: string; dts: string };
      };
    };
  };
  const caches = new generator.WorkspaceCaches();
  const discovered = new generator.WorkspaceAnalyzer({ root: dir, caches }).discoverPackages();
  const packages = discovered.map((candidate) => candidate.package);
  if (packages.length === 0) {
    // 静默跳过会掩盖"上游 face tsconfig 被提前删掉"这类错误（分析器正是靠根 `tsconfig.host.json` /
    // `tsconfig.client.json` 找贡献者包），所以这里直接失败。
    throw new Error("typert: 没有发现贡献者包（face tsconfig 是否还在？）");
  }
  console.log(`[steps] typert: 分析 ${packages.length} 个包…`);
  const workspace = new generator.WorkspaceAnalyzer({
    root: dir,
    packages,
    caches,
    checkDiagnostics: false,
  }).analyze();
  let artifacts = 0;
  let remotes = 0;
  for (const face of workspace.faces) {
    const emitter = new generator.FaceModelEmitter(face);
    for (const packageModel of face.packages) {
      const artifact = emitter.emit(packageModel.name);
      const outDir = join(dir, packageModel.root, "lib");
      await mkdir(outDir, { recursive: true });
      // `js` 是运行时值；`dts` 是声明。合成一份 `.ts` 时：
      // - 值声明带上原声明的类型（`TYPERT` 保持 unknown，与上游「不让业务包依赖运行时注册表」一致）；
      // - 丢掉 dts 里与值重名的 `export declare const`、重复的 `export default` 与失效的 sourceMappingURL；
      // - 保留 `import type` 与 `declare module`（remote 的类型增强靠它）。
      const hostTs = artifact.js.replace(
        /^export const TYPERT = \{$/mu,
        "export const TYPERT: unknown = {",
      );
      await writeFile(join(outDir, `typert.${artifact.face}.ts`), hostTs);
      if (artifact.remote !== undefined) {
        const withType = artifact.remote.js.replace(
          /^export const TYPERT_REMOTE = \{$/mu,
          "export const TYPERT_REMOTE: TypertRemoteContribution = {",
        );
        const enhancement = artifact.remote.dts
          .split("\n")
          .filter(
            (line) =>
              !line.startsWith("export declare const TYPERT_REMOTE") &&
              !line.startsWith("export default ") &&
              !line.startsWith("//# sourceMappingURL"),
          )
          .join("\n");
        await writeFile(join(outDir, "typert.remote-client.ts"), `${withType}\n${enhancement}`);
        remotes += 1;
      }
      artifacts += 1;
    }
  }
  console.log(`[steps] typert: 生成 ${artifacts} 份 face 产物（其中 ${remotes} 份 remote-client）`);
}

// `native` 步骤：只编**不得不编译**的 addon（`.node` 是二进制产物，源码面消费不了）。其余上游产物都由
// 源码面取代，所以这里直接跑上游自己的 native 构建脚本。
//
// **不经过 `pnpm run`**：上游自带 pnpm workspace，在它目录里跑 pnpm（`run` 在 node_modules 缺失时还会
// **隐式 install**）会造出上游自己的顶层 `node_modules`，与根 workspace 的链接形成双副本——实测让 client
// 测试成片失败，且根 install 不加 `--force` 认不出差别、复不了原。native 构建要的依赖由根 install 提供。
async function buildNativeAddon(dir: string): Promise<void> {
  console.log("[steps] native: native/system/scripts/build.ts --host-addon-only");
  await runInherited(
    "pnpm",
    [...OXC_CLI, "native/system/scripts/build.ts", "--host-addon-only"],
    dir,
  );
}

async function runStep(step: Step, paths: UpstreamPaths): Promise<void> {
  const { dir, patchesRoot } = paths;
  if (step.type === "rm") {
    if ("glob" in step) {
      // 按 glob 删（`rm` 的批量形态）：`fs.glob` 自带展开，不引入 glob 依赖；`node_modules` 永不进范围。
      let removed = 0;
      for await (const entry of glob(step.glob, {
        cwd: dir,
        exclude: (path) => path.includes("node_modules"),
      })) {
        await rm(join(dir, entry), { recursive: true, force: true });
        removed += 1;
      }
      console.log(`[steps] rm ${step.glob}（${removed} 项）`);
      return;
    }
    // 单路径删除：目标不存在即失败——上游把这块挪走 / 改名了，清单该跟着改。
    if (!(await pathExists(join(dir, step.path)))) {
      throw new Error(`rm 目标不存在: ${step.path}（上游已变化，评估本步骤）`);
    }
    console.log(`[steps] rm ${step.path}`);
    await rm(join(dir, step.path), { recursive: true, force: true });
    return;
  }
  if (step.type === "text") {
    const file = join(dir, step.file);
    if (!(await pathExists(file))) throw new Error(`patch 目标不存在: ${step.file}`);
    const content = await readFile(file, "utf8");
    const pattern = new RegExp(step.pattern, step.flags ?? "");
    if (!pattern.test(content)) throw new Error(`patch 正则未匹配: ${step.file}`);
    const next = content.replace(pattern, step.to ?? "");
    if (next === content) throw new Error(`patch 未产生变化: ${step.file}`);
    console.log(`[steps] text ${step.file}`);
    await writeFile(file, next);
    return;
  }
  if (step.type === "git") {
    const patch = join(patchesRoot, step.patch);
    if (!(await pathExists(patch))) throw new Error(`patch 文件不存在: ${patch}`);
    console.log(`[steps] git apply ${step.patch}`);
    await runInherited("git", ["apply", patch], dir);
    return;
  }
  if (step.type === "exports") {
    console.log("[steps] exports -> src");
    await rewriteExports(dir, { generated: step.generated, explicit: step.explicit });
    return;
  }
  if (step.type === "typert") {
    console.log("[steps] typert -> lib/*.ts");
    await generateTypertArtifacts(dir);
    return;
  }
  if (step.type === "native") {
    await buildNativeAddon(dir);
    return;
  }
  throw new Error(`未知步骤: ${JSON.stringify(step)}`);
}

// 清单是 TS（`<vendor>/steps.ts`，好让每个阶段、每条步骤旁边写得下为什么）：动态 import 它，按名取阶段。
async function loadPhase(phase: Phase, stepsPath: string): Promise<Step[]> {
  if (!(await pathExists(stepsPath))) {
    console.error(`步骤清单不存在: ${stepsPath}`);
    process.exit(1);
  }
  const module = (await import(pathToFileURL(stepsPath).href)) as Partial<
    Record<Phase, Step[] | undefined>
  >;
  const list = module[phase];
  if (!Array.isArray(list)) {
    console.error(`步骤清单缺 "${phase}" 导出: ${stepsPath}`);
    process.exit(1);
  }
  return list;
}

export async function runPhase(phase: Phase, paths: UpstreamPaths): Promise<void> {
  const list = await loadPhase(phase, paths.stepsPath);
  console.log(`[${phase}] ${list.length} 个步骤 @ ${paths.stepsPath}`);
  for (const step of list) await runStep(step, paths);
}
