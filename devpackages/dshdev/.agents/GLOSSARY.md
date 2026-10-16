# 桌面化（工具与壳）

这一层的词：把任意工作区**装配**成能跑、能打包的部署时，那些"格"叫什么。
取值分形态见 [设计 数据与工作目录的 layout](./designs/20261014-数据与工作目录的-layout.md)；
边界见仓库根 [`GLOSSARY-MAP.md`](../../../.agents/GLOSSARY-MAP.md)。

## 术语

### 格（目录）

**profileDir（装配根）**：
这份部署**装配出来**的那一格——清单、`cordis.yml`、`node_modules`（或指向它的链接）都在这里；
上游按它当 profile root 装配。dev 是工作区里的 app 目录（`DSH_DESKTOP_DEV_PROFILE_DIR` 或进程 cwd）；
bundle 是 `<dataDir>/profiles/desktop`（profile 名是固定常量 `PROFILE_NAME`）。
_避免使用_：profile 目录、app 目录（只在 dev 恰好重合）

**dataDir（`$DSH_HOME`）**：
**用户数据**那一格——会话、设置、附件、日志、`profiles/`。dev 缺省是 `<profileDir>/.dsh-store`；
bundle 由 app 的 `dsh.desktop.dataDir` 解析（`xdg` / `env` / 绝对路径）。
_避免使用_：home、数据目录

**解析根（resolution root）**：
**依赖解析**的基准——`node_modules/.pnpm`、包清单、缓存都相对它。dev 是工作区根（profileDir 在它里面，
`node_modules` 与 lockfile 也在那里）；bundle 就是 profileDir 自己（它带自己的 `node_modules`）。
_避免使用_：repoRoot（那是它在 dev 下的一个取值，不是它的定义）

**闭包根（安装锚点，install anchor）**：
**官方 bundles 与 `dsh`** 的解析基准——`<闭包根>/node_modules/@deepseek-ai/dsh/package.json`。
三种形态的取值：dev 是工作区 store、`--prod` 是 deploy 目录、bundle 是 **profile 自己**（随包 tar 解压出来的那份）。
_避免使用_：安装根（说"根"会和 profileDir / 解析根混）

**buildCache**：
**构建**工作缓存（`<workspace>/node_modules/.dshdev`）。只在构建机上存在，不随产物走。
_避免使用_：构建目录、out

### 依赖面的三份（别互相顶替）

**壳**：
`Resources/app/node_modules`——壳自己的依赖，含 `@morlay/dsh-desktop-host`。

**profile（依赖面）**：
`$DSH_HOME/profiles/desktop/node_modules`——**行加载面**：官方 bundles + `dsh` + 全部传递依赖（随包 tar 解压）。
（这不是 `profileDir` 那一格：那个是装配根。）

**runtime**：
`Resources/runtime`——**只有工具链**：`node` / `pnpm` / loader，**没有** `node_modules`。这个包名在别处不指这份依赖。

_避免使用_：闭包（说清是哪一份）

### 形态

**形态（form）**：
同一套"格"的**三种取值组合**——`dev`（在工作区里跑，改完即生效）、`--prod`（不打包，跑打包形态的解析面）、
`bundle`（把部署打成 .app）。
三种形态共用同一条链（页面、前端链、loader、装配清单），只是"装配根在哪、解析根在哪、
闭包根在哪、谁提供 runtime"这几格的取值不同；判据是 `DSH_DEV_FORM`（有没有值）。
_避免使用_：开发模式 / 打包模式（像是两套东西）
