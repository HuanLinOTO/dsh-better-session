mod vendor 'vendor/justfile'
mod pg 'packages/session/session-rdb/tool/pg/justfile'
mod custom 'apps/dsh-custom-next/justfile'

default:
    just --list

mise *args:
    mise {{ args }}

view *args:
    pnpm view {{ args }}

dep *args:
    pnpm install {{ args }}

update:
    pnpm dlx -r \
        --filter "./devpackages/*"  \
        --filter "./packages/*/*" \
        taze latest -w

prepare:
    just vendor sync
    just vendor patch
    just dep
    just vendor prebuild

clean:
    rm -f pnpm-lock.yaml;
    pnpm clean

clean-dist:
    rm -rf target/dts/*
    pnpm exec -r \
        --filter "./devpackages/*"  \
        --filter "./packages/*/*" \
        rm -rf dist/* 

fmt:
    pnpm exec oxfmt .

# 我们自己的规矩的检查工具（不是测试）：包面（`dsh.bundle` 的包才有 locale 那套）与运行期依赖声明，
# 外加文档的两条硬规矩——行内代码里像工作区路径的东西要解析得到真实文件、md 链接要存在
# （判据与例外表见 `.agents/standards/describing-facts.md`）。文档那两条住在 devkit 的 spec 里，这里定向跑；
# `just test` 跑全仓时同样覆盖它们。
lint:
    pnpm exec oxlint .
    pnpm exec dshdev check-locale
    pnpm exec vitest run --reporter=dot \
        devpackages/devkit/src/__tests__/doc-references.spec.ts \
        devpackages/devkit/src/__tests__/markdown-links.spec.ts

# 发布一律走 CI；这一条是 CI 的发布步骤（逐包唤起，只发 `@morlay/*` 里版本是新的那些）。
publish:
    pnpm -r --filter './packages/*/*' --workspace-concurrency=1 exec dshdev publish

# 全仓声明（一步、两个 face）：生成到 target/dts，各包构建只按路径取自己的那份来合并。
# 插件包构建：`@deepseek-ai/*` 经 exports 指到 src 后，tsdown 加载 config（→ @local/devkit → 上游源码）
# 需要 TS 转译（Node 原生 strip-only 不支持 parameter properties / 枚举 / 装饰器）——由 pnpm-workspace.yaml
# 的 `nodeOptions` 统一挂 oxc 注册，这里不再写 `--import`。
build *args:
    pnpm -r --filter './packages/*/*' run build {{ args }}

version *args:
    pnpm -r --filter './packages/*/*' version {{ args }}

test:
    pnpm exec vitest run
