import { describe, expect, it } from "vitest";
import { missingOfficialPackagesError } from "../cli/prepare-seed.ts";

function message(): string {
  return missingOfficialPackagesError(new Map([["@deepseek-ai/dsh-missing", ["@morlay/plugin"]]]))
    .message;
}

describe("desktop seed missing official packages error", () => {
  it("keeps the missing package detail", () => {
    expect(message()).toContain("deployed closure is missing official packages");
    expect(message()).toContain("@deepseek-ai/dsh-missing (required by @morlay/plugin)");
  });

  // 提示不再指向"重新生成注入面"那套（壳包已没有那个生成器）：缺包是**清单与依赖不一致**，
  // 该去对的就是这两处。
  it("points at the app's bundles and dependencies instead of a generator", () => {
    expect(message()).toContain("dsh.profile.bundles");
    expect(message()).not.toContain("gen:official-packages");
  });
});
