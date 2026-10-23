import { afterEach, describe, expect, it, vi } from "vitest";
import Plugin from "../index.js";

const serverRules = ["No spam", "No threats"];
const forumRules = ["Stay on topic", "No spoilers"];
const event = (
  overrides: Record<string, unknown> = {},
  type = "comment.created"
) => ({
  type,
  payload: {
    commentId: "comment-1",
    commentText: "Buy now",
    author: { isBot: false },
    context: {
      server: { rules: serverRules },
      channel: {
        uniqueName: "cats",
        rules: forumRules,
        pluginEnabled: false,
      },
      comment: { id: "comment-1", text: "Buy now" },
    },
    ...overrides,
  },
});

const discussionEvent = (
  overrides: Record<string, unknown> = {},
  type = "discussionChannel.created"
) => ({
  type,
  payload: {
    discussionId: "discussion-1",
    discussionTitle: "A suspicious offer",
    discussionBody: "Buy now",
    author: { isBot: false },
    context: {
      server: { rules: serverRules },
      channel: {
        uniqueName: "cats",
        rules: forumRules,
        pluginEnabled: true,
      },
      discussion: {
        id: "discussion-1",
        title: "A suspicious offer",
        body: "Buy now",
      },
    },
    ...overrides,
  },
});

const context = (overrides: Record<string, unknown> = {}) => ({
  settings: {
    serviceUrl: "https://moderation.example",
    serverRuleCheckMode: "all_forums",
    confidenceThreshold: 0.7,
  },
  secrets: { server: { MODERATION_SERVICE_API_KEY: "secret" } },
  execution: { correlationId: "run-123" },
  reportContentAsBot: vi.fn().mockResolvedValue({ issueId: "issue-1" }),
  ...overrides,
});

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("LLM moderation plugin", () => {
  it("reports a canonical above-threshold server-rule violation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      violations: [{ scope: "server", ruleId: "server:0" }],
      recommendation: "remove",
      confidence: 0.91,
      rationale: "Promotional spam",
    })));
    const ctx = context();

    const result = await new Plugin(ctx).handleEvent(event());

    expect({ result, report: ctx.reportContentAsBot.mock.calls[0][0] }).toEqual({
      result: { success: true, result: { reported: true, confidence: 0.91 } },
      report: expect.objectContaining({
        contentType: "comment",
        contentId: "comment-1",
        selectedForumRules: [],
        selectedServerRules: ["No spam"],
      }),
    });
  });

  it("moderates edited comment text and reports against the same comment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      violations: [{ scope: "server", ruleId: "server:0" }],
      recommendation: "edit",
      confidence: 0.86,
      rationale: "The edited text violates the rule",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();
    const editedEvent = event({
      commentText: "Edited spam text",
      context: {
        server: { rules: serverRules },
        channel: {
          uniqueName: "cats",
          rules: forumRules,
          pluginEnabled: false,
        },
        comment: { id: "comment-1", text: "Edited spam text" },
      },
    }, "comment.edited");

    const result = await new Plugin(ctx).handleEvent(editedEvent);

    expect(result).toEqual({ success: true, result: { reported: true, confidence: 0.86 } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).content).toEqual({
      type: "comment",
      id: "comment-1",
      body: "Edited spam text",
    });
    expect(ctx.reportContentAsBot).toHaveBeenCalledOnce();
    expect(ctx.reportContentAsBot).toHaveBeenCalledWith(expect.objectContaining({
      contentType: "comment",
      contentId: "comment-1",
      selectedServerRules: ["No spam"],
    }));
  });

  it("moderates a discussion and reports the discussion with canonical rules", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      violations: [
        { scope: "server", ruleId: "server:0" },
        { scope: "channel", ruleId: "channel:0" },
      ],
      recommendation: "remove",
      confidence: 0.94,
      rationale: "Promotional discussion",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();

    const result = await new Plugin(ctx).handleEvent(discussionEvent());

    expect(result).toEqual({ success: true, result: { reported: true, confidence: 0.94 } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).content).toEqual({
      type: "discussion",
      id: "discussion-1",
      title: "A suspicious offer",
      body: "Buy now",
    });
    expect(ctx.reportContentAsBot).toHaveBeenCalledWith(expect.objectContaining({
      contentType: "discussion",
      contentId: "discussion-1",
      selectedServerRules: ["No spam"],
      selectedForumRules: ["Stay on topic"],
    }));
  });

  it("moderates an edited discussion and reports against the same discussion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      violations: [{ scope: "channel", ruleId: "channel:0" }],
      recommendation: "edit",
      confidence: 0.89,
      rationale: "The edited discussion violates the forum rule",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();
    const editedEvent = discussionEvent({
      discussionTitle: "Edited suspicious offer",
      discussionBody: "Edited spam body",
      context: {
        server: { rules: serverRules },
        channel: {
          uniqueName: "cats",
          rules: forumRules,
          pluginEnabled: true,
        },
        discussion: {
          id: "discussion-1",
          title: "Edited suspicious offer",
          body: "Edited spam body",
        },
      },
    }, "discussionChannel.edited");

    const result = await new Plugin(ctx).handleEvent(editedEvent);

    expect(result).toEqual({ success: true, result: { reported: true, confidence: 0.89 } });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).content).toEqual({
      type: "discussion",
      id: "discussion-1",
      title: "Edited suspicious offer",
      body: "Edited spam body",
    });
    expect(ctx.reportContentAsBot).toHaveBeenCalledOnce();
    expect(ctx.reportContentAsBot).toHaveBeenCalledWith(expect.objectContaining({
      contentType: "discussion",
      contentId: "discussion-1",
      selectedForumRules: ["Stay on topic"],
    }));
  });

  it("skips bot-authored discussions", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new Plugin(context()).handleEvent(
      discussionEvent({ author: { isBot: true } })
    );

    expect(result).toEqual({ success: true, result: { skipped: "bot-authored" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips unsupported events without calling the service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new Plugin(context()).handleEvent(event({}, "comment.deleted"));

    expect(result).toEqual({ success: true, result: { skipped: "unsupported-event" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not report hallucinated or mis-scoped citations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      violations: [
        { scope: "server", ruleId: "unknown" },
        { scope: "channel", ruleId: "server:0" },
        { scope: "server", ruleId: "channel:0" },
      ],
      recommendation: "remove",
      confidence: 0.99,
      rationale: "Bad",
    })));
    const ctx = context();

    const result = await new Plugin(ctx).handleEvent(event({
      context: {
        server: { rules: serverRules },
        channel: { uniqueName: "cats", rules: forumRules, pluginEnabled: true },
      },
    }));

    expect({ result, reports: ctx.reportContentAsBot.mock.calls.length }).toEqual({
      result: { success: true, result: { reported: false, confidence: 0.99, validCitationCount: 0 } },
      reports: 0,
    });
  });

  it.each([
    ["bot-authored", event({ author: { isBot: true } })],
    ["server-rule-checking-off", event()],
    ["no-applicable-rules", event({
      context: {
        server: { rules: [] },
        channel: { uniqueName: "cats", rules: [], pluginEnabled: false },
      },
    })],
  ])("skips %s comments without calling the service", async (reason, input) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = reason === "server-rule-checking-off"
      ? context({ settings: { serviceUrl: "https://moderation.example", serverRuleCheckMode: "off" } })
      : context();

    const result = await new Plugin(ctx).handleEvent(input);

    expect({ result, calls: fetchMock.mock.calls.length }).toEqual({
      result: { success: true, result: { skipped: reason } },
      calls: 0,
    });
  });

  it.each([
    ["all_forums", "", true, ["server", "channel"]],
    ["all_forums", "", false, ["server"]],
    ["off", "", true, ["channel"]],
    ["allowlist", "dogs", true, ["channel"]],
    ["allowlist", "cats,dogs", false, ["server"]],
  ])(
    "sends one applicable rule set for mode=%s allowlist=%s channelEnabled=%s",
    async (mode, allowlist, pluginEnabled, expectedScopes) => {
      const fetchMock = vi.fn().mockResolvedValue(response({
        violations: [], recommendation: "none", confidence: 0.1, rationale: "Clean",
      }));
      vi.stubGlobal("fetch", fetchMock);
      const ctx = context({
        settings: {
          serviceUrl: "https://moderation.example",
          serverRuleCheckMode: mode,
          serverRuleForumAllowlist: allowlist,
        },
      });

      await new Plugin(ctx).handleEvent(event({
        context: {
          server: { rules: serverRules },
          channel: { uniqueName: "cats", rules: forumRules, pluginEnabled },
        },
      }));

      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect([
        ...new Set(body.rules.map((rule: { scope: string }) => rule.scope)),
      ]).toEqual(expectedScopes);
    }
  );

  it("skips when neither server nor forum rule checking applies", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new Plugin(context({
      settings: {
        serviceUrl: "https://moderation.example",
        serverRuleCheckMode: "allowlist",
        serverRuleForumAllowlist: "dogs",
      },
    })).handleEvent(event());

    expect(result).toEqual({
      success: true,
      result: { skipped: "server-rule-checking-off" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates one consolidated report with canonical server and forum rules", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      violations: [
        { scope: "server", ruleId: "server:0" },
        { scope: "channel", ruleId: "channel:1" },
        { scope: "channel", ruleId: "channel:1" },
      ],
      recommendation: "edit",
      confidence: 0.88,
      rationale: "The post needs changes",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context();

    const result = await new Plugin(ctx).handleEvent(event({
      context: {
        server: { rules: serverRules },
        channel: { uniqueName: "cats", rules: forumRules, pluginEnabled: true },
      },
    }));

    expect(result).toEqual({ success: true, result: { reported: true, confidence: 0.88 } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(ctx.reportContentAsBot).toHaveBeenCalledOnce();
    expect(ctx.reportContentAsBot).toHaveBeenCalledWith(expect.objectContaining({
      selectedServerRules: ["No spam"],
      selectedForumRules: ["No spoilers"],
    }));
  });

  it("reads manifest defaults from nested server settings with flat overrides", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      violations: [], recommendation: "none", confidence: 0.1, rationale: "Clean",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context({
      settings: {
        server: {
          serviceUrl: "https://default.example",
          serverRuleCheckMode: "off",
          confidenceThreshold: 0.9,
        },
        serviceUrl: "https://override.example/",
        serverRuleCheckMode: "all_forums",
      },
    });

    await new Plugin(ctx).handleEvent(event());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://override.example/moderate",
      expect.any(Object)
    );
  });

  it("marks provider outages retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "down" }, 503)));

    const result = await new Plugin(context()).handleEvent(event());

    expect(result).toEqual({
      success: false,
      error: "Moderation service returned HTTP 503",
      retryable: true,
    });
  });

  it("marks service request validation failures non-retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ detail: "bad request" }, 400)));

    const result = await new Plugin(context()).handleEvent(event());

    expect(result).toEqual({
      success: false,
      error: "Moderation service returned HTTP 400",
      retryable: false,
    });
  });

  it.each([
    ["invalid JSON", new Response("not-json", { status: 200 }), true],
    ["invalid verdict", response({ confidence: 2 }), false],
  ])("rejects an %s service response", async (_label, serviceResponse, retryable) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(serviceResponse));

    const result = await new Plugin(context()).handleEvent(event());

    expect(result).toEqual(expect.objectContaining({ success: false, retryable }));
  });

  it("treats network failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await new Plugin(context()).handleEvent(event());

    expect(result).toEqual({ success: false, error: "network down", retryable: true });
  });

  it("supports a manually configured forum allowlist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      violations: [], recommendation: "none", confidence: 0.1, rationale: "Clean",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = context({
      settings: {
        serviceUrl: "https://moderation.example/",
        serverRuleCheckMode: "allowlist",
        serverRuleForumAllowlist: "cats,dogs",
      },
    });

    await new Plugin(ctx).handleEvent(event());

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when service configuration or comment content is missing", async () => {
    const unconfigured = await new Plugin(context({ settings: { serverRuleCheckMode: "all_forums" } }))
      .handleEvent(event());
    const missingContent = await new Plugin(context()).handleEvent(event({
      commentId: "",
      commentText: "",
      context: { server: { rules: serverRules }, channel: { uniqueName: "cats" }, comment: null },
    }));

    expect([unconfigured, missingContent]).toEqual([
      { success: false, error: "Moderation service is not configured", retryable: false },
      { success: false, error: "comment.created payload is missing content", retryable: false },
    ]);
  });

  it("fails closed when reporting is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      violations: [{ scope: "server", ruleId: "server:0" }],
      recommendation: "edit",
      confidence: 0.9,
      rationale: "Needs an edit",
    })));
    const ctx = context({ reportContentAsBot: undefined });

    const result = await new Plugin(ctx).handleEvent(event());

    expect(result).toEqual({
      success: false,
      error: "Plugin runtime does not support reportContentAsBot",
      retryable: false,
    });
  });

  it("sends canonical rules and the run correlation id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      violations: [], recommendation: "none", confidence: 0.1, rationale: "Clean",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await new Plugin(context()).handleEvent(event());

    const [url, init] = fetchMock.mock.calls[0];
    expect({ url, headers: init.headers, body: JSON.parse(init.body) }).toEqual({
      url: "https://moderation.example/moderate",
      headers: expect.objectContaining({ "x-api-key": "secret", "x-correlation-id": "run-123" }),
      body: expect.objectContaining({
        content: { type: "comment", id: "comment-1", body: "Buy now" },
        rules: [
          { scope: "server", id: "server:0", text: "No spam" },
          { scope: "server", id: "server:1", text: "No threats" },
        ],
      }),
    });
  });

  it("requires the service secret", () => {
    expect(Plugin.validateSecrets({})).toEqual({
      valid: false,
      error: "MODERATION_SERVICE_API_KEY is required",
    });
  });

  it("accepts the service secret", () => {
    expect(Plugin.validateSecrets({ MODERATION_SERVICE_API_KEY: "secret" })).toEqual({ valid: true });
  });
});
