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

## Development

```bash
npm install
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
