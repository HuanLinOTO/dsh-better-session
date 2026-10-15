// 包面检查：**带 `dsh.bundle` 的包**（进 profile 的那些）才需要多语言声明——只有它们有插件清单页；
// 普通公共库（UI / 工具库）不参与，别拿这条去要求它们。
//
// 与 `check-deps` 同一种东西：**我们自己的规矩**的检查工具，不是测试——规矩变了改这里，不必动测试。
//
// 查两件：locale 出口在 `exports` 与 `publishConfig.exports` 里都在、`files` 带上它；上游 `readPluginMeta`
// 真能读出中英文标题与描述（漏了文件或出口就退化成英文 name）。
import { glob, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readPluginMeta } from "@deepseek-ai/dsh-app-boot";

interface BundlePackage {
  readonly name: string;
  readonly dir: string;
}

/** 找"带 `dsh.bundle` 的包"：那才是进 profile、有清单面的那些。 */
async function bundlePackages(root: string): Promise<BundlePackage[]> {
  const found: BundlePackage[] = [];
  for await (const file of glob("packages/*/*/package.json", { cwd: root })) {
    const dir = join(root, file, "..");
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
      name?: string;
      dsh?: { bundle?: unknown };
    };
    if (manifest.name === undefined || manifest.dsh?.bundle === undefined) continue;
    found.push({ name: manifest.name, dir });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 报出不合规矩的地方。
 *
 * @param root - 仓库根（缺省当前目录）。
 * @returns 问题清单（空 = 全过）；一条一个字符串。
 */
export async function reportLocaleFaces(root?: string): Promise<string[]> {
  const cwd = resolve(root ?? process.cwd());
  const problems: string[] = [];
  const packages = await bundlePackages(cwd);
  // 防空转：判据写窄了（字段改名、目录挪了）会静默变绿。
  if (packages.length === 0) {
    problems.push(`${cwd}: 没找到带 dsh.bundle 的包——判据是不是写窄了？`);
    return problems;
  }

  for (const pkg of packages) {
    const manifest = JSON.parse(await readFile(join(pkg.dir, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
      publishConfig?: { exports?: Record<string, unknown> };
      files?: string[];
    };
    if (manifest.exports?.["./locale/*.json"] !== "./locale/*.json") {
      problems.push(`${pkg.name}: exports 缺 ./locale/*.json`);
    }
    // 发布态读的是 publishConfig.exports：那里漏了，装出来的包就读不到 locale。
    const published = manifest.publishConfig?.exports ?? manifest.exports;
    if (published?.["./locale/*.json"] !== "./locale/*.json") {
      problems.push(`${pkg.name}: publishConfig.exports 缺 ./locale/*.json`);
    }
    if (!(manifest.files ?? []).includes("locale/*.json")) {
      problems.push(`${pkg.name}: files 缺 locale/*.json`);
    }

    const meta = readPluginMeta(pkg.name, pathToFileURL(join(pkg.dir, "package.json")).href);
    if (meta?.error !== undefined) {
      problems.push(`${pkg.name}: 读插件清单失败（${String(meta.error)}）`);
      continue;
    }
    // 本地化文本是 `{ en, <lang>: … }` 的语言表。
    const title = (meta?.title ?? {}) as Record<string, string>;
    const description = (meta?.description ?? {}) as Record<string, string>;
    for (const [field, table] of [
      ["标题", title],
      ["描述", description],
    ] as const) {
      if (!table["en"]) problems.push(`${pkg.name}: 缺英文${field}`);
      if (!table["zh"]) problems.push(`${pkg.name}: 缺中文${field}`);
    }
  }
  return problems;
}
