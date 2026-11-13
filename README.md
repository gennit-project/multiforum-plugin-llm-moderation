# Multiforum LLM Moderation Plugin

Experimental, report-only moderation plugin. For `comment.created`,
`comment.edited`, `discussionChannel.created`, and `discussionChannel.edited`,
it sends the submitted content and the applicable canonical server and forum
rules to an external moderation service in one request. A valid,
above-threshold verdict creates one consolidated report for human moderators.
The report includes the service's structured edit/remove recommendation,
confidence, and rationale when the server runtime supports those fields.

The provider API key belongs to the external service and is never configured in
this plugin. Server-rule checking defaults to `off`.

## Rule governance

Starting in plugin version 0.8.0, the server administrator controls these
server-scoped settings:

| Setting | Values | Behavior when absent |
| --- | --- | --- |
| `serverRuleEnforcement` | `on`, `off`, `allowlist` | Server rules off, unless legacy settings are present |
| `serverRuleForumAllowlist` | Server-rule forum unique names | Empty list |
| `channelRuleEligibility` | `all`, `none`, `allowlist` | All forums eligible |
| `channelRuleAllowlist` | Array of forum unique names | Empty list |

When `serverRuleEnforcement` is `on`, server rules apply in every forum,
regardless of forum eligibility or owner opt-in. When it is `off`, no server
rules are sent to the service. `allowlist` checks only forums named in
`serverRuleForumAllowlist`, independently of owner consent or eligibility.

Channel rules require both owner opt-in (`context.channel.pluginEnabled ===
true`) and server eligibility. `all` allows every forum to opt in, `none`
disables channel-rule enforcement, and `allowlist` permits only listed forums.
An empty allowlist permits none. Allowlist entries are trimmed and matched
case-sensitively to canonical forum unique names. The new allowlist must be an
array of strings; a malformed value or non-string member permits no forums.
Invalid explicit enforcement or eligibility values fail closed. Nested
`settings.channel` values cannot override any of these server settings.

Eligibility does not itself opt in an owner. The server runtime is responsible
for authorizing configuration changes, delivering the server pipeline to every
forum, and handling requests and administrator approvals for allowlist access.

### Compatibility and migration

If `serverRuleEnforcement` is absent, existing `serverRuleCheckMode`
(`off`, `all_forums`, or `allowlist`) and `serverRuleForumAllowlist` retain their
previous behavior. Legacy allowlists continue to support arrays, JSON arrays,
and comma-separated strings. They are never reused as channel eligibility.
An explicit `serverRuleEnforcement` takes precedence over legacy settings,
including when its value is invalid.

The manifest exposes only the new governance controls. It intentionally does
not materialize governance defaults while legacy installations are supported:
runtime defaults above avoid masking an existing saved policy on upgrade.
Generic reconciliation must preserve legacy settings or require an explicit
migration, rather than dropping the old fields and silently disabling rules.

The admin UI preserves each legacy mode (`off` → `off`, `all_forums` →
`on`, `allowlist` → `allowlist`) and its server-rule list. Only the legacy mode
key is retired on save; `serverRuleForumAllowlist` stays server scope. The
independent forum-rule eligibility policy defaults to all when absent, so
existing owner opt-in (including the `bad_advice` pilot) is retained. Approval
only adds eligibility and cannot change either owner consent or server scope.
Use the coordinated backend, frontend, and plugin release. Do not apply new settings to an older plugin
release that does not understand them. The governance-aware backend must reject
new governance settings for plugin versions below 0.8.0, including pipeline pins.

## Development

```bash
npm ci
npm run ci
```

## Release

The only supported release path is the **Release plugin** GitHub Actions
workflow. Run it from `main`, enter the exact version declared by both
`plugin.json` and `package.json`, and approve the protected `release`
environment. The workflow runs the complete CI and bundle pipeline before it
creates anything, refuses existing tags or releases, creates an annotated
`v<version>` tag, and publishes the tarball, checksum, and manifest. The
release and job summary record the immutable source commit.

Do not create or move release tags manually. Configure required reviewers on
the `release` environment so publication always has an explicit approval gate.
Service deployment and registry publication are separate workflows.
