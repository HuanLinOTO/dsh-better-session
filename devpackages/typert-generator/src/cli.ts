import { resolve } from "node:path";
import { generateTypert } from "./index.ts";

// 预演 / 对照用 CLI（不写产物）：
//   pnpm dlx @oxc-node/cli devpackages/typert-generator/src/cli.ts <upstreamRoot> <dtsRoot> [包名…]
// 上游同步链里的正式入口走 `generateTypert({ write: true })`（见 vendor/steps.ts 的 prebuild 阶段）。
const [upstreamRoot, dtsRoot, ...packages] = process.argv.slice(2);
if (upstreamRoot === undefined || dtsRoot === undefined) {
  console.error("用法: cli.ts <upstreamRoot> <dtsRoot> [包名…]");
  process.exit(1);
}
const artifacts = await generateTypert({
  upstreamRoot: resolve(upstreamRoot),
  dtsRoot: resolve(dtsRoot),
  ...(packages.length === 0 ? {} : { packages }),
});
for (const artifact of artifacts) {
  for (const file of artifact.files)
    console.log(`=== ${artifact.package} → ${file.path} ===\n${file.text}`);
}
console.error(
  `[typert] 包 ${String(artifacts.length)} 个，invocation ${String(
    artifacts.reduce((total, artifact) => total + artifact.invocations, 0),
  )} 条`,
);
