import { logOf } from "@local/devkit/log";
// CI 的**登录步骤**：把 token 写进全局 `~/.npmrc`（`pnpm publish` 需要认证，且它拒绝脏 working tree，
// 所以不落在仓库里）。本地别跑它。
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY_HOST = "npm.pkg.github.com";

/**
 * 写入发布用的 token。
 *
 * @param token - 缺省取 `NODE_AUTH_TOKEN`。
 * @returns 进程退出码（0 成功）。
 */
const log = logOf("dshdev");

export async function runLogin(token?: string): Promise<number> {
  const value = token ?? process.env["NODE_AUTH_TOKEN"];
  if (value === undefined || value === "") {
    process.stderr.write("dshdev login: NODE_AUTH_TOKEN is required\n");
    return 1;
  }
  await writeFile(join(homedir(), ".npmrc"), `//${REGISTRY_HOST}/:_authToken=${value}\n`);
  log.info(`wrote ~/.npmrc for ${REGISTRY_HOST}`);
  return 0;
}
