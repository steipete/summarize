import { describe, expect, it } from "vitest";
import { updateFormulaForMacArtifacts } from "../scripts/release-formula.js";

const urls = {
  urlArm: "https://example.com/summarize-macos-arm64.tar.gz",
  shaArm: "arm-sha",
  urlX64: "https://example.com/summarize-macos-x64.tar.gz",
  shaX64: "x64-sha",
};

describe("updateFormulaForMacArtifacts", () => {
  it("updates existing dual-arch formula blocks", () => {
    const input = `class Summarize < Formula
  on_arm do
    url "https://old.example/arm.tgz"
    sha256 "old-arm"
  end

  on_intel do
    url "https://old.example/x64.tgz"
    sha256 "old-x64"
  end
end
`;

    const output = updateFormulaForMacArtifacts(input, urls);

    expect(output).toContain(`url "${urls.urlArm}"`);
    expect(output).toContain(`sha256 "${urls.shaArm}"`);
    expect(output).toContain(`url "${urls.urlX64}"`);
    expect(output).toContain(`sha256 "${urls.shaX64}"`);
    expect(output).not.toContain("old-arm");
    expect(output).not.toContain("old-x64");
  });

  it("converts arm64-only formulas to on_arm/on_intel blocks", () => {
    const input = `class Summarize < Formula
  desc "summarize"
  homepage "https://example.com"
  url "https://old.example/arm.tgz"
  sha256 "old-arm"
  depends_on arch: :arm64
end
`;

    const output = updateFormulaForMacArtifacts(input, urls);

    expect(output).toContain("on_arm do");
    expect(output).toContain("on_intel do");
    expect(output).toContain(`url "${urls.urlArm}"`);
    expect(output).toContain(`sha256 "${urls.shaArm}"`);
    expect(output).toContain(`url "${urls.urlX64}"`);
    expect(output).toContain(`sha256 "${urls.shaX64}"`);
    expect(output).not.toContain("depends_on arch: :arm64");
  });

  it("keeps fallback formulas arm64-only when no arch blocks exist", () => {
    const input = `class Summarize < Formula
  url "https://old.example/default.tgz"
  sha256 "old-default"
end
`;

    const output = updateFormulaForMacArtifacts(input, urls);

    expect(output).toContain(`url "${urls.urlArm}"`);
    expect(output).toContain(`sha256 "${urls.shaArm}"`);
    expect(output).not.toContain(urls.urlX64);
    expect(output).not.toContain(urls.shaX64);
  });
});
