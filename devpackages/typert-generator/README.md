# @local/typert-generator

Typert 产物生成器：把上游包的源码与声明树合成 `lib/typert.*.ts`——**不建类型图**，只用 oxc 的 AST
（方法面来自源码，类型面来自声明树），所以既不依赖任何 TypeScript 版本，也不需要上游的 tsconfig。

它替代的是上游 generator 的那一步：后者给每个包各建一次 tsgo 类型图（分钟级），这里全量跑完只要几秒。

## 用法

```ts
import { generateTypert } from "@local/typert-generator";

await generateTypert({
  upstreamRoot: "vendor/deepseek-harness", // 上游 clone（产物里的 sourceLocation 相对它）
  dtsRoot: "target/dts", // 声明树（路径可配置，见 @local/devkit 的 generateWorkspaceDts）
  write: true, // 缺省只返回文本（预演 / 对照）
});
```

产物三件：`lib/typert.host.ts`（宿主面 TYPERT）、`lib/typert.client.ts`（client 面，双面包才有）、
`lib/typert.remote-client.ts`（远端客户端的 wire 描述 + `declare module` 类型增强）。

预演（不写盘，打印产物）：
`pnpm dlx @oxc-node/cli devpackages/typert-generator/src/cli.ts vendor/deepseek-harness target/dts [包名…]`

## 规则住在哪

| 规则                                                         | 位置                                       |
| ------------------------------------------------------------ | ------------------------------------------ |
| 类型语法 → zod（15 种形式、修饰符、递归 `z.lazy`）           | [`src/schema.ts`](./src/schema.ts)         |
| 方法面与产物文本（命名、格式、`cancellation`、`typeSymbol`） | [`src/index.ts`](./src/index.ts)           |
| 包反射（JSDoc → description / summary / tags、成员签名）     | [`src/reflection.ts`](./src/reflection.ts) |
| AST 机械活（解析、遍历、JSDoc、位置）                        | [`src/ast.ts`](./src/ast.ts)               |

判据与用例在 [`src/__tests__/`](./src/__tests__)；上游同步链里它挂在 `vendor/steps.ts` 的 `prebuild` 阶段。
