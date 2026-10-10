// 上游同步的步骤清单：`patch` 改上游工作树，`prebuild` 生成源码面消费的产物、编译 native addon。
// 用 TS 写就是为了每个阶段、每条步骤旁边写得下「为什么」。
//
// 执行器与步骤类型见 `.agents/skills/dsh-plugin-upstream-sync/scripts/steps.ts`；两阶段的语义与
// 各步骤类型的判据在 `dsh-plugin-upstream-sync` 技能里。
import type { Step } from "../.agents/skills/dsh-plugin-upstream-sync/scripts/steps.ts";

// 从 sync 的干净基线跑一次（不是每条步骤都幂等）。
export const patch: Step[] = [
  // 本部署不用的子代理实现，整包裁掉（连带它们的依赖不进 workspace）。
  { type: "rm", path: "packages/subagent/subagent-claude-code" },
  { type: "rm", path: "packages/subagent/subagent-codex" },
  // 指向上游不入库的测试快照的符号链接（断链）；本仓库不跑这条 acp e2e，删掉免得断链被遍历到。
  { type: "rm", path: "apps/cli/tests/profiles/acp/cordis.yml" },
  // 写端双协议：让 typert 的 `Remote`/`RemoteScope` 与 cordis 的 `Inject` 同时接受 TC39 与 legacy
  // 两种调用约定（类型面也一样）——本仓库根 tsconfig 开着 `experimentalDecorators`。
  { type: "git", patch: "decorator-dual-protocol.patch" },
  // subprocess runner 的转译器改由 `DSH_SOURCE_LOADER` 注入（上游默认的 `tsx/esm` 本仓库里没有）。
  { type: "git", patch: "source-loader.patch" },
  {
    type: "exports",
    // 生成物出口：目标是 `prebuild` 阶段写出的 `.ts`（不是 `lib/*.js`），所以按出口名显式改指。
    generated: {
      "./typert": "./lib/typert.host.ts",
      "./client/typert": "./lib/typert.client.ts",
      "./remote": "./lib/typert.remote-client.ts",
    },
    // 出口名 ≠ 源文件名：这些出口的目标按包显式指定（`lib→src` 同构规则推不出来）。typert 分析
    // 要求每个 export 解析到**存在的**源文件，未映射的出口会让生成失败。
    explicit: {
      "@deepseek-ai/dsh-app-boot": {
        "./worker/profile-resolution-bootstrap": "./src/profile-resolution/worker-bootstrap.ts",
      },
      "@deepseek-ai/dsh-client-ui-theme": { "./brand-font.css": "./src/styles/brand-font.css" },
      "@deepseek-ai/dsh-host-directory-picker-native": {
        "./worker": "./src/win32-dialog-worker.ts",
      },
      "@deepseek-ai/dsh-subprocess-local": { "./runner": "./src/bin.ts" },
    },
  },
  // 给 typert analyzer 的「数据出口」跳过列表补 `css`：`.css` 与 `svg`/`png` 同类（无 TS API），
  // 上游 `client/ui-theme` 的 `brand-font.css` 出口否则会在分析期被判成「missing source」。
  {
    type: "text",
    file: "packages/typert/generator/src/analyzer.ts",
    pattern: "json\\|ya\\?ml\\|svg\\|png\\|jpe\\?g\\|webp",
    to: "css|json|ya?ml|svg|png|jpe?g|webp",
  },
];

// 前置是 sync + patch 的干净基线：typert 分析靠上游根的 face tsconfig 找贡献者包，而本阶段末尾
// 会把 tsconfig 删掉——重跑请从 sync 开始。
export const prebuild: Step[] = [
  // typert 产物写成 `.ts`：开发与桌面形态不再为 `./typert` / `./remote` 出口构建上游。它读上游
  // 根的 face tsconfig（`tsconfig.host.json` / `tsconfig.client.json`）找贡献者包，所以必须排在
  // 下面那条 `rm` 之前。
  { type: "typert" },
  // 只编不得不编译的 addon（`.node` 是二进制产物，源码面消费不了）。
  { type: "native" },
  // 删上游全部 tsconfig：口径唯一——按文件就近找 tsconfig 的工具只会读到根上那一份。
  { type: "rm", glob: "**/tsconfig*.json" },
];
