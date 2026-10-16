// 术语表的两条机械规矩（`just test` 与 `just lint` 都会跑）。判据在
// [`GLOSSARY-MAP.md`](../../../../.agents/GLOSSARY-MAP.md)：词只定义一次、每层一份表、表就是「哪个上下文在哪一层」的
// 唯一清单。这里只管**登记与形状**，不判断「内容是不是术语」——那要人读。
//
// 1. **双向登记**：表里链到的每个 `GLOSSARY.md` 都要存在；仓库里每个 `.agents/GLOSSARY.md` 都要在表里链到。
//    漏一边就等于「有表没边界声明」或「有边界没表」——上下文归属当场说不清。这轮暴露的头号问题就是它。
// 2. **每行都声明归属**：表里每个上下文的「术语表」列要么是链接、要么显式写 `—（无独立词汇）`。
//    空格子意味着「这个上下文有没有自己的词」没人回答过。
//
// 不查条目内容形状（`**词**：`）：正文里也会用 `**加粗**` 强调词（`**规则块**的稳定标识…`），机械上分不开
// 「词条」与「正文加粗」，硬查只会误报。也不查 H1 与表里上下文名的文本一致性——表写的是边界视角的名字
// （「会话编辑（跨包）」），文件 H1 是那份表自己的名字（「会话编辑（跨包词汇）」），两者本就不必逐字相同。
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MAP = join(ROOT, ".agents/GLOSSARY-MAP.md");
const SKIP_DIRS = new Set([
  ".git",
  ".scratch",
  ".tmp",
  "dist",
  "lib",
  "node_modules",
  "target",
  "vendor",
]);

const toRepoPath = (file: string): string => relative(ROOT, file).split(sep).join("/");

/** 仓库里每一份 `.agents/GLOSSARY.md`（记录树的那份，不是任意同名文件）。 */
async function glossaryFiles(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.name === ".agents") {
      if ((await readdir(path)).includes("GLOSSARY.md")) found.push(join(path, "GLOSSARY.md"));
      continue;
    }
    await glossaryFiles(path, found);
  }
  return found;
}

/** 表里链到的所有 `GLOSSARY.md`（相对表所在目录解析成仓库路径）。 */
function linkedGlossaries(map: string): Set<string> {
  const linked = new Set<string>();
  for (const match of map.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const href = match[1] ?? "";
    if (!href.endsWith("GLOSSARY.md")) continue;
    linked.add(toRepoPath(resolve(dirname(MAP), href)));
  }
  return linked;
}

describe("术语表的登记", () => {
  it("GLOSSARY-MAP 与各层 GLOSSARY.md 双向登记一致", async () => {
    const linked = linkedGlossaries(await readFile(MAP, "utf8"));
    const files = (await glossaryFiles(ROOT)).map(toRepoPath);
    // 防空转：表被清空或扫描规则写窄了，下面两条会同时变空而"通过"。
    expect(linked.size).toBeGreaterThanOrEqual(10);
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect([...linked].filter((path) => !files.includes(path)).sort()).toEqual([]);
    expect(files.filter((path) => !linked.has(path)).sort()).toEqual([]);
  });

  it("MAP 表里每个上下文都声明了自己的词汇归属（链接或 `—`）", async () => {
    const rows = (await readFile(MAP, "utf8"))
      .split("\n")
      // 只取「上下文 | 术语表 | 边界」那张表的数据行：三列、首列不是表头也不是分隔线。
      .filter((line) => line.startsWith("|") && line.split("|").length >= 4)
      .filter((line) => !/^\|[\s-]+\|/u.test(line) && !line.startsWith("| 上下文"));
    const undecided = rows
      .filter((line) => {
        const cell = line.split("|")[2] ?? "";
        return !cell.includes("](") && !cell.includes("—");
      })
      .map((line) => `| ${(line.split("|")[1] ?? "").trim()} |`);
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(undecided).toEqual([]);
  });
});
