import { describe, expect, it } from "vitest";
import { validateReleaseVersion } from "../scripts/release-version.mjs";

const valid = {
  manifest: { version: "0.7.0", source: { releaseNotesUrl: "https://example.test/releases/tag/v0.7.0" } },
  packageJson: { version: "0.7.0" },
  expected: "0.7.0",
};

describe("release version", () => {
  it("derives an immutable tag from matching release metadata", () => {
    expect(validateReleaseVersion(valid)).toEqual({ version: "0.7.0", tag: "v0.7.0" });
  });

  it("rejects invalid, mismatched, and unconfirmed versions", () => {
    expect(() => validateReleaseVersion({ ...valid, manifest: { version: "latest" } })).toThrow(/semantic version/);
    expect(() => validateReleaseVersion({ ...valid, packageJson: { version: "0.6.0" } })).toThrow(/does not match/);
    expect(() => validateReleaseVersion({ ...valid, expected: "0.8.0" })).toThrow(/confirmed version/);
    expect(() => validateReleaseVersion({
      ...valid,
      manifest: { ...valid.manifest, source: { releaseNotesUrl: "https://example.test/tag/v0.6.0" } },
    })).toThrow(/releaseNotesUrl/);
  });
});
