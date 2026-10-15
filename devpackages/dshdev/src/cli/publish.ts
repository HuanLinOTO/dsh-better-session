// CI 的**发布步骤**（发布一律走 CI；本地别跑它）。
//
// 由 `pnpm -r --filter './packages/*/*' --workspace-concurrency=1 exec dshdev publish` 在每个包目录下唤起，
// 只处理**当前包**：只发布 `@morlay/*`（上游由 deepseek-harness 自己发）、已发布过的跳过、按版本算 dist-tag。
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_REGISTRY = "https://npm.pkg.github.com/";

/** 稳定版 → latest；`-alpha.*` → alpha；其余预发布（rc / beta / …）→ next。 */
export function distTagOf(version: string): string {
  const dash = version.indexOf("-");
  if (dash < 0) return "latest";
  const prerelease = version.slice(dash + 1).split("+")[0] ?? "";
  return prerelease.split(".")[0] === "alpha" ? "alpha" : "next";
}

// 捕获 stdout/stderr 地跑子进程：非零退出不抛，交给调用方按退出码判断。
async function capture(command: string, args: string[]): Promise<{ status: number | null; stderr: string }> {
  try {
    const { stderr } = await execFileAsync(command, args, { encoding: "utf8" });
    return { status: 0, stderr };
  } catch (error: unknown) {
    const failure = error as { code?: unknown; stderr?: unknown };
    return {
      status: typeof failure.code === "number" ? failure.code : null,
      stderr: typeof failure.stderr === "string" ? failure.stderr : "",
    };
  }
}

// 继承 stdio 地跑子进程（发布日志直接进当前终端），返回退出码。
function runInherited(command: string, args: string[]): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  });
}

/**
 * 发布当前目录这个包（若还没发过）。
 *
 * @param options - `cwd`（缺省当前目录）、`registry`（缺省 GitHub Packages）。
 */
export async function runPublish(options: {
  readonly cwd?: string;
  readonly registry?: string;
  readonly branch?: string;
}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const { name, version } = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };

  if (!name.startsWith("@morlay/")) {
    console.log(`skip ${name}: only @morlay/* packages are published from this repo`);
    return 0;
  }

  const view = await capture("pnpm", ["view", `${name}@${version}`, "version", "--registry", registry]);
  if (view.status === 0) {
    console.log(`skip ${name}: ${version} already published`);
    return 0;
  }
  if (!(view.stderr.includes("ERR_PNPM_PACKAGE_NOT_FOUND") || view.stderr.includes("ERR_PNPM_FETCH_404"))) {
    process.stderr.write(view.stderr);
    return 1;
  }

  const tag = distTagOf(version);
  console.log(`to publish: ${name}@${version} (tag: ${tag})`);
  const status = await runInherited("pnpm", [
    "publish",
    "--access=public",
    `--tag=${tag}`,
    `--publish-branch=${options.branch ?? process.env["GITHUB_REF_NAME"] ?? "main"}`,
    "--registry",
    registry,
  ]);
  // 409 = 并发下已被别的 job 发过，不算失败。
  return status === 0 || status === 409 ? 0 : (status ?? 1);
}
