# @local/devkit

本地私有工具链（不发布、不进发布清单）：仓库各包的 tsdown 配置预设与**构建期机械判据**——host 与 client
两个入口的打包规则（client 走 CJS 单文件工厂、内联库走普通库产物）、bundle patch 的真源与渲染、包出口推导、
CSS 内联与标准装饰器降级。

## 用法

```ts
import { defineCordisPluginConfig } from "@local/devkit";
import { bundlePatch, renderPatch, type PatchBundleOptions } from "@local/devkit/patch";

export default defineCordisPluginConfig({
  entries: { rows: "./src/rows.ts" }, // 额外入口（index / client 按约定探测）
  inline: ["@morlay/dsh-client-ui-primitives"], // 打进产物、不进依赖清单
});
```

出口：`.`（构建预设与 client 规则）、`./patch`（bundle patch）、`./dts`（声明生成与合并）、

`./tsconfig.json`（共享 TS 配置）。

两条线（开发线与发布线）的分工与不变量、`exports` 推导与内联面的约定见[规范 how-to-write](./.agents/standards/how-to-write.md)；规范面本身在[仓库规范](../../.agents/standards/how-to-write.md)与[如何验证](../../.agents/standards/how-to-verify.md)。
