# Multiforum LLM Moderation Plugin

Experimental, report-only moderation plugin. For `comment.created`, it sends
the comment and the applicable canonical server and forum rules to an external
moderation service in one request. A valid, above-threshold verdict creates one
consolidated report for human moderators.

The provider API key belongs to the external service and is never configured in
this plugin. Server-rule checking defaults to `off`.

## Development

```bash
npm install
npm run ci
```

Discussion events, edits, asynchronous processing, deployment, and registry
publication remain outside the current implementation.
