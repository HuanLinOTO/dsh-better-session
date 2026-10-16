# @morlay/dsh-oxc-node

**本仓库的 TS 运行时入口**：注册 Node 的 module hooks，让 `node_modules` 下的 `.ts` 也能直接跑（ESM only）。

为什么需要它：Node 内建的 type stripping 拒绝对 `node_modules` 里的文件动手，而 `@oxc-node/core` 也刻意
放行那类文件（转译本身当然能做，只是那层策略不放）。这里自己注册 hooks、直接调 `oxc-transform`，
于是"源码面"（`exports` 指向 `src/*.ts` 的包）在壳与宿主里都能直接加载。

## 用法

```
node --import <本包>/register.mjs <入口>
```

- **壳**不直接依赖它：随包运行时（`<Resources>/runtime/loader`）里放着一份，壳按**路径**把它交给宿主
  与子进程（见 `packages/desktop/dsh-desktop-shell/src/index.ts` 的 `loader`）；
- **工具**（`@local/dshdev`）依赖它，并在备 runtime 时把这一份连同它的依赖层一起拷进
  `<buildCache>/runtime/loader`（见 `devpackages/dshdev/src/cli/prepare-runtime.ts` 的 `prepareLoader`）。

依赖方向因此是"**devpackages → packages**"：`@local/*` 只出现在工具链里，不落到任何发布包的运行时依赖上。
