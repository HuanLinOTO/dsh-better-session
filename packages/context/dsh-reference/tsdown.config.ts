import { defineConfig } from "tsdown";
import { cordisPlugin } from "@local/tsdown-plugin-cordis";

// host 插件在 `agent/pre-step` 扩展点用，没有 client 入口，构建只需要 ESM。
//
// Windows 规避（见升级 PR）：`inline` 点名在 win32 上把内联目标解析成反斜杠绝对路径的
// 运行期 import（不可分发）。改为把 `@morlay/dsh-client-ui-primitives` 声明为正式
// `dependencies` 条目（构建期 external、部署期随包安装），不再走 inline。
export default defineConfig({
  plugins: [
    cordisPlugin({}),
  ],
});
