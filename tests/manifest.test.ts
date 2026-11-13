import fs from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(fs.readFileSync("plugin.json", "utf8"));
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

describe("plugin manifest", () => {
  it("describes a versioned Multiforum plugin package", () => {
    expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.entry).toBe("dist/index.js");
    expect(manifest.events).toEqual([
      "comment.created",
      "comment.edited",
      "discussionChannel.created",
      "discussionChannel.edited",
    ]);
  });

  it("declares source and compatibility metadata for registry consumers", () => {
    expect(manifest.source.repoUrl).toMatch(/^https:\/\/github\.com\/gennit-project\/multiforum-plugin-/);
    expect(manifest.source.releaseNotesUrl).toContain(`/releases/tag/v${manifest.version}`);
    expect(manifest.compatibility.minServerVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.compatibility.apiVersion).toBe("1");
  });

  it("versions governance as 0.8.0 consistently across the package, lockfile and manifest", () => {
    expect(manifest.version).toBe("0.8.0");
    expect(packageJson.version).toBe(manifest.version);
    expect(packageLock.version).toBe(manifest.version);
    expect(packageLock.packages[""].version).toBe(manifest.version);
  });

  it("exposes global server enforcement and a separate channel eligibility policy", () => {
    const serverFields = manifest.ui.forms.server.flatMap(
      (section: { fields: Array<Record<string, unknown>> }) => section.fields
    );
    expect(serverFields.find((field: { key?: string }) => field.key === "serverRuleEnforcement"))
      .toMatchObject({ type: "select", options: [
        { value: "off" }, { value: "on" }, { value: "allowlist" },
      ] });
    expect(serverFields.find((field: { key?: string }) => field.key === "channelRuleEligibility"))
      .toMatchObject({ type: "select", options: [
        { value: "all" }, { value: "none" }, { value: "allowlist" },
      ] });
    const allowlistField = serverFields.find(
      (field: { key?: string }) => field.key === "channelRuleAllowlist"
    );

    expect(allowlistField).toMatchObject({
      type: "forum-multiselect",
      visibleWhen: {
        key: "channelRuleEligibility",
        equals: "allowlist",
      },
    });
    // Empty allowlists intentionally deny every channel and remain valid config.
    expect(allowlistField?.required).not.toBe(true);
    expect(serverFields.some((field: { key?: string }) =>
      ["serverRuleCheckMode"].includes(field.key || "")
    )).toBe(false);
    expect(manifest.ui.forms.channel).toEqual([]);
  });

  it("does not materialize governance defaults over an unmigrated legacy configuration", () => {
    for (const key of [
      "serverRuleEnforcement", "channelRuleEligibility", "channelRuleAllowlist",
      "serverRuleCheckMode", "serverRuleForumAllowlist",
    ]) {
      expect(manifest.settingsDefaults.server).not.toHaveProperty(key);
    }
  });
});
