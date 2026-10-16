# @morlay/dsh-sandbox-local

可配置沙箱与审批的**运行时策略面** bundle：替换官方 `ctx.sandbox`（进程沙箱）与 `ctx.fs`（文件系统围栏），在官方
语义之上叠加 `access` 规则，并接管模型看到的运行时快照（`sandbox:policy` / `approval:policy`）。

## 用法

`access` 的两种写法等价（数组每项一条，或多行文本每行一条；空行忽略）：

```yaml
- id: sandbox-local
  config:
    access:
      - "rw {{ env.XDG_CACHE_HOME }}"
      - "r- {{ env.XDG_CONFIG_HOME }}"
      - "-- mise.*.toml"
      - "-- **/*.pem"
```

规则语法、命中优先级、平台表达能力、六个字段，以及两条运行时快照的接管方式见
[设计 可配置沙箱的规则面与平台降级](./.agents/designs/20260929-可配置沙箱的规则面与平台降级.md)。

## 装配

行数据在本包的 `./rows` 出口（禁官方 `sandbox` / `fs-sandbox` 两行 + 插入本包一行）；采用它的部署 bundle 是
[`@morlay/sandbox-profile`](../../bundles/sandbox-profile/README.md)——它渲染出这份 patch，并在同一份 patch 里按 id
给 `sandbox-local` 的 `access` 值。部署侧只需把那个 bundle 列进 `dsh.profile.bundles`。
