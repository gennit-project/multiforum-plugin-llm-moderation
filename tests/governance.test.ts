import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import Plugin from "../index.js";

const eventTypes = [
  "comment.created", "comment.edited",
  "discussionChannel.created", "discussionChannel.edited",
];
const manifest = JSON.parse(fs.readFileSync("plugin.json", "utf8"));
const makeEvent = (type: string, pluginEnabled: boolean, uniqueName?: string) => ({
  type,
  payload: {
    commentId: "comment-1",
    commentText: "Comment body",
    discussionId: "discussion-1",
    discussionTitle: "Discussion title",
    discussionBody: "Discussion body",
    context: {
      server: { rules: ["Server rule"] },
      channel: { uniqueName, pluginEnabled, rules: ["Channel rule"] },
    },
  },
});

const checkScopes = async (
  settings: Record<string, unknown>,
  pluginEnabled: boolean,
  expectedScopes: string[],
  uniqueName: string | undefined = "cats",
  type = "comment.created"
) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    violations: [], recommendation: "none", confidence: 0, rationale: "Clean",
  })));
  vi.stubGlobal("fetch", fetchMock);
  const result = await new Plugin({
    settings: { serviceUrl: "https://moderation.example", ...settings },
    secrets: { server: { MODERATION_SERVICE_API_KEY: "test-secret" } },
  }).handleEvent(makeEvent(type, pluginEnabled, uniqueName));

  expect(result.success).toBe(true);
  if (expectedScopes.length === 0) {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.result).toEqual({ skipped: "server-rule-checking-off" });
  } else {
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).rules).toEqual(
      expectedScopes.map(scope => ({
        scope,
        id: `${scope}:0`,
        text: scope === "server" ? "Server rule" : "Channel rule",
      }))
    );
  }
};

afterEach(() => vi.unstubAllGlobals());

describe("rule governance", () => {
  const matrix = eventTypes.flatMap(type =>
    ["on", "off", "allowlist"].flatMap(serverRuleEnforcement =>
      ["all", "none", "allowlist"].flatMap(channelRuleEligibility =>
        [true, false].flatMap(pluginEnabled =>
          ["cats", "dogs", "CATS", ""].map(uniqueName => ({
            type, serverRuleEnforcement, channelRuleEligibility, pluginEnabled, uniqueName,
          }))
        )
      )
    )
  );

  it.each(matrix)(
    "$type global=$serverRuleEnforcement eligibility=$channelRuleEligibility owner=$pluginEnabled forum=$uniqueName",
    async ({ type, serverRuleEnforcement, channelRuleEligibility, pluginEnabled, uniqueName }) => {
      const channelEligible = channelRuleEligibility === "all" || (
        channelRuleEligibility === "allowlist" && uniqueName === "cats"
      );
      await checkScopes({
        serverRuleEnforcement,
        serverRuleForumAllowlist: ["dogs"],
        channelRuleEligibility,
        channelRuleAllowlist: ["cats"],
      }, pluginEnabled, [
        ...((serverRuleEnforcement === "on" || (serverRuleEnforcement === "allowlist" && uniqueName === "dogs")) ? ["server"] : []),
        ...(pluginEnabled && channelEligible ? ["channel"] : []),
      ], uniqueName, type);
    }
  );

  it("defaults new installations to server off and channel owner opt-in", async () => {
    await checkScopes(manifest.settingsDefaults, false, []);
    await checkScopes(manifest.settingsDefaults, true, ["channel"]);
  });

  it.each([true, false])("keeps server rules global with no channel context, owner=%s", async pluginEnabled => {
    await checkScopes({ serverRuleEnforcement: "on", channelRuleEligibility: "none" },
      pluginEnabled, ["server"], "");
  });

  it("checks global server rules when the event has no channel context at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      violations: [], recommendation: "none", confidence: 0, rationale: "Clean",
    })));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new Plugin({
      settings: { serviceUrl: "https://moderation.example", serverRuleEnforcement: "on" },
      secrets: { server: { MODERATION_SERVICE_API_KEY: "test-secret" } },
    }).handleEvent({
      type: "comment.created",
      payload: { commentId: "comment-1", commentText: "Comment body", context: { server: { rules: ["Server rule"] } } },
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).rules).toEqual([
      { scope: "server", id: "server:0", text: "Server rule" },
    ]);
  });

  it.each([undefined, null, "all_forums", "ON", true, false, 1, {}, []])(
    "fails closed for a present invalid server enforcement value %j instead of using legacy all_forums",
    async value => {
      await checkScopes({ serverRuleEnforcement: value, serverRuleCheckMode: "all_forums" }, false, []);
    }
  );

  it.each([undefined, null, "ALL", "all_forums", "off", true, false, 1, {}, []])(
    "fails closed for a present invalid channel eligibility value %j",
    async value => {
      await checkScopes({ serverRuleEnforcement: "on", channelRuleEligibility: value }, true, ["server"]);
    }
  );

  it.each([
    undefined, null, "cats", "cats,dogs", '["cats"]', {}, true, 1,
    [], ["dogs"], ["CATS"], [""], ["cats", null], ["cats", 1], ["cats", {}],
  ])("denies channel eligibility for an absent, nonmatching or malformed allowlist %j", async value => {
    await checkScopes({
      serverRuleEnforcement: "on", channelRuleEligibility: "allowlist", channelRuleAllowlist: value,
    }, true, ["server"]);
  });

  it("normalizes whitespace and duplicate channel allowlist entries", async () => {
    await checkScopes({
      serverRuleEnforcement: "off", channelRuleEligibility: "allowlist",
      channelRuleAllowlist: ["", " cats ", "cats", "  "],
    }, true, ["channel"]);
  });

  it("never interprets a legacy server allowlist as a channel eligibility list", async () => {
    await checkScopes({
      serverRuleEnforcement: "on", channelRuleEligibility: "allowlist",
      serverRuleCheckMode: "allowlist", serverRuleForumAllowlist: ["cats"],
    }, true, ["server"]);
  });

  it("ignores the channel allowlist outside allowlist mode", async () => {
    await checkScopes({ channelRuleEligibility: "all", channelRuleAllowlist: "invalid" }, true, ["channel"]);
    await checkScopes({ channelRuleEligibility: "none", channelRuleAllowlist: ["cats"] }, true, []);
  });

  it("uses the explicit new server toggle instead of legacy allowlist membership", async () => {
    await checkScopes({
      serverRuleEnforcement: "on", serverRuleCheckMode: "allowlist", serverRuleForumAllowlist: ["dogs"],
    }, false, ["server"]);
    await checkScopes({
      serverRuleEnforcement: "off", serverRuleCheckMode: "allowlist", serverRuleForumAllowlist: ["cats"],
    }, false, []);
  });

  it("reads nested server settings and ignores nested channel governance overrides", async () => {
    await checkScopes({
      server: { serverRuleEnforcement: "on", channelRuleEligibility: "none" },
      channel: { serverRuleEnforcement: "off", channelRuleEligibility: "all" },
    }, true, ["server"]);
    await checkScopes({
      server: { serverRuleEnforcement: "off", channelRuleEligibility: "allowlist", channelRuleAllowlist: ["dogs"] },
      channel: { serverRuleEnforcement: "on", channelRuleEligibility: "all", channelRuleAllowlist: ["cats"] },
    }, true, []);
  });

  it("lets flat server settings override nested manifest settings", async () => {
    await checkScopes({
      server: { serverRuleEnforcement: "on", channelRuleEligibility: "none" },
      serverRuleEnforcement: "off", channelRuleEligibility: "allowlist", channelRuleAllowlist: ["cats"],
    }, true, ["channel"]);
  });

  it("does not accept enabled-like values in place of owner opt-in", async () => {
    for (const pluginEnabled of [undefined, null, 1, "true"]) {
      await checkScopes({ channelRuleEligibility: "all" }, pluginEnabled as boolean, []);
    }
  });

  it("does not report citations for disabled scopes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      violations: [{ scope: "channel", ruleId: "channel:0" }],
      recommendation: "remove", confidence: 0.99, rationale: "Not an applicable rule",
    })));
    vi.stubGlobal("fetch", fetchMock);
    const reportContentAsBot = vi.fn();
    const result = await new Plugin({
      settings: { serviceUrl: "https://moderation.example", serverRuleEnforcement: "on", channelRuleEligibility: "none" },
      secrets: { server: { MODERATION_SERVICE_API_KEY: "test-secret" } },
      reportContentAsBot,
    }).handleEvent(makeEvent("comment.created", true, "cats"));

    expect(result.result).toEqual({ reported: false, confidence: 0.99, validCitationCount: 0 });
    expect(reportContentAsBot).not.toHaveBeenCalled();
  });
});

describe("legacy configuration compatibility", () => {
  const legacyMatrix = eventTypes.flatMap(type =>
    ["off", "all_forums", "allowlist"].flatMap(serverRuleCheckMode =>
      [["cats"], '["cats"]', "cats,dogs"].flatMap(serverRuleForumAllowlist =>
        [true, false].flatMap(pluginEnabled =>
          ["cats", "birds"].map(uniqueName => ({
            type, serverRuleCheckMode, serverRuleForumAllowlist, pluginEnabled, uniqueName,
          }))
        )
      )
    )
  );

  it.each(legacyMatrix)(
    "$type legacy=$serverRuleCheckMode list=$serverRuleForumAllowlist owner=$pluginEnabled forum=$uniqueName",
    async ({ type, serverRuleCheckMode, serverRuleForumAllowlist, pluginEnabled, uniqueName }) => {
      const serverEnabled = serverRuleCheckMode === "all_forums" || (
        serverRuleCheckMode === "allowlist" && uniqueName === "cats"
      );
      await checkScopes({
        ...manifest.settingsDefaults,
        serverRuleCheckMode,
        serverRuleForumAllowlist,
      }, pluginEnabled, [
        ...(serverEnabled ? ["server"] : []),
        ...(pluginEnabled ? ["channel"] : []),
      ], uniqueName, type);
    }
  );

  it("preserves legacy values stored within server settings", async () => {
    await checkScopes({
      server: { ...manifest.settingsDefaults.server, serverRuleCheckMode: "allowlist", serverRuleForumAllowlist: ["cats"] },
    }, false, ["server"]);
  });

  it.each([undefined, null, "", "invalid", false])("keeps invalid or absent legacy modes disabled: %j", async value => {
    await checkScopes({ serverRuleCheckMode: value, serverRuleForumAllowlist: ["cats"] }, false, []);
    await checkScopes({ serverRuleCheckMode: value, serverRuleForumAllowlist: ["cats"] }, true, ["channel"]);
  });

  it.each([undefined, null, "", "null", "{}", 123])("keeps nonmatching legacy allowlists disabled: %j", async value => {
    await checkScopes({ serverRuleCheckMode: "allowlist", serverRuleForumAllowlist: value }, false, []);
  });
});

it.each([undefined,null,'cats',[],['dogs'],['cats',1]])('fails closed for invalid or nonmatching explicit server allowlist %j',async list=>{
  await checkScopes({serverRuleEnforcement:'allowlist',serverRuleForumAllowlist:list,channelRuleEligibility:'none'},true,[]);
});
it('keeps server scope independent from channel overrides',async()=>{
  await checkScopes({server:{serverRuleEnforcement:'allowlist',serverRuleForumAllowlist:['dogs'],channelRuleEligibility:'none'},channel:{serverRuleForumAllowlist:['cats'],channelRuleEligibility:'all'}},true,[]);
});
