type RuleScope = "server" | "channel";

type HookContext = {
  settings?: Record<string, unknown>;
  secrets?: { server?: Record<string, string> };
  execution?: { correlationId?: string };
  reportContentAsBot?: (input: {
    contentType: "comment" | "discussion";
    contentId: string;
    reportText: string;
    selectedForumRules: string[];
    selectedServerRules: string[];
    botName: string;
    profileId?: string;
    profileLabel?: string;
  }) => Promise<unknown>;
};

type EventEnvelope = {
  type: string;
  payload?: {
    commentId?: string;
    commentText?: string;
    author?: { isBot?: boolean };
    context?: {
      server?: { rules?: unknown };
      channel?: {
        uniqueName?: string;
        rules?: unknown;
        pluginEnabled?: boolean;
      };
      comment?: { id?: string; text?: string } | null;
    };
  };
};

type ServiceRule = { scope: RuleScope; id: string; text: string };
type ServiceVerdict = {
  violations: Array<{ scope: RuleScope; ruleId: string }>;
  recommendation: "edit" | "remove" | "none";
  confidence: number;
  rationale: string;
};

type PluginResult = {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  retryable?: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const COMMENT_EVENTS = new Set(["comment.created", "comment.edited"]);

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map(item => item.trim())
        .filter(Boolean)
    : [];

const numberSetting = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const serverSettings = (value: unknown): Record<string, unknown> => {
  const settings = record(value);
  const flatOverrides = Object.fromEntries(
    Object.entries(settings).filter(([key]) => key !== "server" && key !== "channel")
  );
  return { ...record(settings.server), ...flatOverrides };
};

const parseAllowlist = (value: unknown): string[] => {
  if (Array.isArray(value)) return strings(value);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    return strings(JSON.parse(value));
  } catch {
    return value.split(",").map(item => item.trim()).filter(Boolean);
  }
};

const isVerdict = (value: unknown): value is ServiceVerdict => {
  if (!value || typeof value !== "object") return false;
  const verdict = value as Partial<ServiceVerdict>;
  return (
    Array.isArray(verdict.violations) &&
    ["edit", "remove", "none"].includes(String(verdict.recommendation)) &&
    typeof verdict.confidence === "number" &&
    verdict.confidence >= 0 &&
    verdict.confidence <= 1 &&
    typeof verdict.rationale === "string"
  );
};

export default class LlmModerationPlugin {
  constructor(private readonly context: HookContext) {}

  async handleEvent(event: EventEnvelope): Promise<PluginResult> {
    if (!COMMENT_EVENTS.has(event.type)) {
      return { success: true, result: { skipped: "unsupported-event" } };
    }
    if (event.payload?.author?.isBot) {
      return { success: true, result: { skipped: "bot-authored" } };
    }

    const settings = serverSettings(this.context.settings);
    const channelUniqueName = event.payload?.context?.channel?.uniqueName || "";
    const mode = settings.serverRuleCheckMode || "off";
    const allowlist = parseAllowlist(settings.serverRuleForumAllowlist);
    const serverRulesEnabled =
      mode === "all_forums" ||
      (mode === "allowlist" && allowlist.includes(channelUniqueName));
    const channelRulesEnabled =
      event.payload?.context?.channel?.pluginEnabled === true;
    if (!serverRulesEnabled && !channelRulesEnabled) {
      return { success: true, result: { skipped: "server-rule-checking-off" } };
    }

    const commentId = event.payload?.commentId || event.payload?.context?.comment?.id;
    const body = event.payload?.commentText || event.payload?.context?.comment?.text;
    if (!commentId || !body?.trim()) {
      return { success: false, error: `${event.type} payload is missing comment content`, retryable: false };
    }

    const serverRules: ServiceRule[] = serverRulesEnabled
      ? strings(event.payload?.context?.server?.rules).map((text, index) => ({
          scope: "server",
          id: `server:${index}`,
          text,
        }))
      : [];
    const channelRules: ServiceRule[] = channelRulesEnabled
      ? strings(event.payload?.context?.channel?.rules).map((text, index) => ({
          scope: "channel",
          id: `channel:${index}`,
          text,
        }))
      : [];
    const rules = [...serverRules, ...channelRules];
    if (rules.length === 0) {
      return { success: true, result: { skipped: "no-applicable-rules" } };
    }

    const serviceUrl = typeof settings.serviceUrl === "string" ? settings.serviceUrl.replace(/\/$/, "") : "";
    const apiKey = this.context.secrets?.server?.MODERATION_SERVICE_API_KEY || "";
    if (!serviceUrl || !apiKey) {
      return { success: false, error: "Moderation service is not configured", retryable: false };
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      numberSetting(settings.serviceTimeoutMs, DEFAULT_TIMEOUT_MS)
    );
    let response: Response;
    try {
      response = await fetch(`${serviceUrl}/moderate`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          ...(this.context.execution?.correlationId
            ? { "x-correlation-id": this.context.execution.correlationId }
            : {}),
        },
        body: JSON.stringify({
          content: { type: "comment", id: commentId, body },
          rules,
          policy: {
            model: typeof settings.model === "string" ? settings.model : undefined,
            temperature: numberSetting(settings.temperature, 0),
            maxTokens: numberSetting(settings.maxTokens, 800),
          },
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Moderation service request failed";
      return { success: false, error: message, retryable: true };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Moderation service returned HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      };
    }

    let verdict: unknown;
    try {
      verdict = await response.json();
    } catch {
      return { success: false, error: "Moderation service returned invalid JSON", retryable: true };
    }
    if (!isVerdict(verdict)) {
      return { success: false, error: "Moderation service returned an invalid verdict", retryable: false };
    }

    const canonicalRules = new Map(rules.map(rule => [`${rule.scope}:${rule.id}`, rule.text]));
    const selectedServerRules: string[] = [];
    const selectedForumRules: string[] = [];
    const seen = new Set<string>();
    for (const violation of verdict.violations) {
      if (
        !violation ||
        !["server", "channel"].includes(violation.scope) ||
        typeof violation.ruleId !== "string"
      ) continue;
      const key = `${violation.scope}:${violation.ruleId}`;
      const canonical = canonicalRules.get(key);
      if (canonical && !seen.has(key)) {
        seen.add(key);
        if (violation.scope === "server") {
          selectedServerRules.push(canonical);
        } else {
          selectedForumRules.push(canonical);
        }
      }
    }

    const confidenceThreshold = numberSetting(settings.confidenceThreshold, 0.7);
    const validCitationCount = selectedServerRules.length + selectedForumRules.length;
    if (verdict.confidence < confidenceThreshold || validCitationCount === 0) {
      return {
        success: true,
        result: { reported: false, confidence: verdict.confidence, validCitationCount },
      };
    }
    if (!this.context.reportContentAsBot) {
      return { success: false, error: "Plugin runtime does not support reportContentAsBot", retryable: false };
    }

    const recommendation = verdict.recommendation === "remove" ? "remove/archive" : verdict.recommendation;
    const reportText = [
      `LLM moderation recommendation: ${recommendation}.`,
      `Confidence: ${verdict.confidence.toFixed(2)}.`,
      verdict.rationale.trim(),
    ].filter(Boolean).join(" ");
    await this.context.reportContentAsBot({
      contentType: "comment",
      contentId: commentId,
      reportText,
      selectedForumRules,
      selectedServerRules,
      botName: typeof settings.botName === "string" ? settings.botName : "llm-moderator",
      profileId: typeof settings.profileId === "string" ? settings.profileId : undefined,
      profileLabel: typeof settings.profileLabel === "string" ? settings.profileLabel : undefined,
    });

    return { success: true, result: { reported: true, confidence: verdict.confidence } };
  }

  static validateSecrets(secrets: Record<string, string>): { valid: boolean; error?: string } {
    if (!secrets.MODERATION_SERVICE_API_KEY?.trim()) {
      return { valid: false, error: "MODERATION_SERVICE_API_KEY is required" };
    }
    return { valid: true };
  }
}
