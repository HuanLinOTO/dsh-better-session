import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateTypert } from "../index.ts";

// 端到端：造一个最小上游包 + 一棵声明树，断言三件套产物都出来了。

async function fixture(
  options: { client?: boolean } = {},
): Promise<{ upstreamRoot: string; dtsRoot: string }> {
  const upstreamRoot = await mkdtemp(join(tmpdir(), "typert-upstream-"));
  const dtsRoot = await mkdtemp(join(tmpdir(), "typert-dts-"));
  const pkg = join(upstreamRoot, "packages", "demo", "demo");
  await mkdir(join(pkg, "src"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    `${JSON.stringify({
      name: "@x/demo",
      exports: {
        ".": "./src/index.ts",
        ...(options.client === true ? { "./client": "./src/client/index.ts" } : {}),
      },
      ...(options.client === true ? { dsh: { client: { entry: "./src/client/index.ts" } } } : {}),
    })}\n`,
  );
  await writeFile(
    join(pkg, "src", "index.ts"),
    [
      "/** Demo service. */",
      "export class Demo extends TypertRemoteService {",
      "  constructor(ctx: Context) { super(ctx, 'demo', { namespace: 'demo' }) }",
      "  /** Read a payload. */",
      "  @Remote",
      "  async read(payload: Payload): Promise<Payload> { return payload }",
      "}",
      "",
    ].join("\n"),
  );
  const dtsPkg = join(dtsRoot, "vendor", "x", "packages", "demo", "demo", "src");
  await mkdir(dtsPkg, { recursive: true });
  await writeFile(join(dtsPkg, "types.d.ts"), "export interface Payload {\n    id: string;\n}\n");
  return { upstreamRoot, dtsRoot };
}

describe("typert 产物生成", () => {
  it("产出 host / client / remote-client 三件套，并带上 invocation 与反射", async () => {
    const { upstreamRoot, dtsRoot } = await fixture({ client: true });
    const artifacts = await generateTypert({ upstreamRoot, dtsRoot });
    expect(artifacts).toHaveLength(1);
    const files = artifacts[0]?.files ?? [];
    const host = files.find((file) => file.path.endsWith("typert.host.ts"))?.text ?? "";
    expect(host).toContain("export const TYPERT: unknown = {");
    expect(host).toContain("id: '@x/demo#demo/read'");
    expect(host).toContain("'id': z.string(),");
    expect(host).toContain('"summary": "Demo service."');
    expect(files.some((file) => file.path.endsWith("typert.client.ts"))).toBe(true);
    const remote = files.find((file) => file.path.endsWith("typert.remote-client.ts"))?.text ?? "";
    expect(remote).toContain("export const TYPERT_REMOTE: TypertRemoteContribution = {");
    expect(remote).toContain("declare module '@deepseek-ai/dsh-typert-protocol' {");
    expect(remote).toContain("read: (payload: Payload) => Promise<RemoteResult<Payload>>");
  });

  it("没有 @Remote 方法的包不产物", async () => {
    const { upstreamRoot, dtsRoot } = await fixture();
    const pkg = join(upstreamRoot, "packages", "demo", "demo", "src", "index.ts");
    await writeFile(pkg, "export class Nothing {}\n");
    expect(await generateTypert({ upstreamRoot, dtsRoot })).toEqual([]);
  });
});
