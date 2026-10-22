# Multiforum LLM Moderation Plugin

Experimental, report-only moderation plugin. For `comment.created`, it sends
the comment and canonical server rules to an external moderation service. A
valid, above-threshold verdict creates one report for human moderators.

The provider API key belongs to the external service and is never configured in
this plugin. Server-rule checking defaults to `off`.

## Development

```bash
npm install
npm run ci
```

This first slice intentionally excludes discussion events, edits, channel-rule
evaluation, asynchronous processing, deployment, and registry publication.
