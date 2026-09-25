# ilmari-plugin-loki

An [ilmari](https://ilmari.dev) log sink that pushes every task event (the same
progress log the web monitor shows) to [Grafana Loki](https://grafana.com/oss/loki/),
so task history can be explored and dashboarded in a self-hosted Grafana.

Plain ESM, zero dependencies. Requires an ilmari version whose `LogSink.handle`
receives `ctx.pluginConfig` (the sink context).

## Install

```sh
ilmari plugin add /path/to/ilmari-plugin-loki/dist/index.js
# or from git (newest v* tag)
ilmari plugin add https://<host>/<group>/ilmari-plugin-loki.git
```

Approve the `net` (push to Loki) and `secrets` (encrypted password/token)
capabilities when prompted.

## Configure

Set the fields in the console's plugin settings, or through the env fallbacks
on a headless daemon. The plugin does nothing until `url` is set.

| Field | Env | Meaning |
|---|---|---|
| `url` | `LOKI_URL` | Loki base address, e.g. `http://loki:3100` |
| `username` | `LOKI_USERNAME` | Basic auth user (a proxy in front of Loki) |
| `password` | `LOKI_PASSWORD` | Basic auth password (secret) |
| `token` | `LOKI_TOKEN` | Bearer token, used when no `username` is set (secret) |
| `tenant` | `LOKI_TENANT` | `X-Scope-OrgID` for multi-tenant Loki |

## What lands in Loki

Each event is one log line in the stream `{service_name="ilmari", type="<event type>"}`.
The line is JSON: `{"task": "<task id>", "type": "...", "data": {...}}`. The task
id is deliberately not a label, since one stream per task would bloat Loki's index.

Example LogQL:

```logql
{service_name="ilmari"}                                  # everything
{service_name="ilmari", type="node_finished"}            # one event type
{service_name="ilmari"} | json | task="<task id>"        # one task
```

## Local Loki + Grafana

```yaml
# docker-compose.yml
services:
  loki:
    image: grafana/loki:latest
    ports: ["3100:3100"]
  grafana:
    image: grafana/grafana:latest
    ports: ["3000:3000"]
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
```

Add a Loki data source pointing at `http://loki:3100` in Grafana, set the
plugin's `url` to `http://localhost:3100`, run a task, and open Explore.

## Limits

- One HTTP push per event. That's fine for normal task volume. Batching can
  come later if Loki load shows it's needed.
- ilmari mutes a sink after its first failed delivery until the process
  restarts. So if Loki is down or the credentials are wrong, restart ilmari
  after fixing it. The first error is logged.

## Development

```sh
npm test                                     # fake Loki server, no network
ILMARI_SRC=/path/to/ilmari npm test          # also runs ilmari's static inspector
```
