// Ship every ilmari task event to Grafana Loki via its push API.
// Inactive until a URL is configured (GUI or LOKI_URL).

const NAME = "ilmari-plugin-loki";

/** Builds the push request for one event; exported for tests. */
export function buildPush(event, cfg) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.username) {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password ?? ""}`).toString("base64")}`;
  } else if (cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }
  if (cfg.tenant) headers["X-Scope-OrgID"] = cfg.tenant;
  // taskId stays out of the labels: one stream per task would blow up Loki's
  // index. Query it with `| json | task="..."` instead.
  const body = {
    streams: [
      {
        stream: { service_name: "ilmari", type: event.type },
        values: [
          [
            String(BigInt(Date.parse(event.ts)) * 1_000_000n),
            JSON.stringify({ task: event.taskId, type: event.type, data: event.data }),
          ],
        ],
      },
    ],
  };
  return {
    url: `${cfg.url.replace(/\/$/, "")}/loki/api/v1/push`,
    init: { method: "POST", headers, body: JSON.stringify(body) },
  };
}

export default {
  name: "ilmari-plugin-loki",
  version: "0.1.0",
  description:
    "Copies every task event (the same progress log the web monitor shows) to Grafana Loki, so task history can be explored and dashboarded in Grafana. Does nothing until a Loki URL is configured.",
  setup:
    "Set the Loki URL field (or LOKI_URL) to your Loki server, e.g. http://loki:3100. Add username/password or a bearer token if a proxy in front of Loki requires auth, and a tenant for multi-tenant Loki.",
  capabilities: ["net", "secrets"],
  config: {
    url: {
      label: "Loki URL",
      description: "Base address of the Loki server, e.g. http://loki:3100.",
      env: "LOKI_URL",
    },
    username: {
      label: "Username",
      description: "Basic auth user, if a proxy in front of Loki requires it.",
      env: "LOKI_USERNAME",
    },
    password: {
      label: "Password",
      description: "Basic auth password for the username above.",
      secret: true,
      env: "LOKI_PASSWORD",
    },
    token: {
      label: "Bearer token",
      description: "Sent as Authorization: Bearer when no username is set.",
      secret: true,
      env: "LOKI_TOKEN",
    },
    tenant: {
      label: "Tenant",
      description: "X-Scope-OrgID for multi-tenant Loki. Leave empty for single-tenant.",
      env: "LOKI_TENANT",
    },
  },
  sinks: [
    {
      name: "loki",
      async handle(event, ctx) {
        const cfg = ctx.pluginConfig(NAME);
        if (!cfg.url) return; // unconfigured: stay silent
        // ponytail: one push per event, batch with a flush timer if Loki load shows it
        const { url, init } = buildPush(event, cfg);
        const res = await fetch(url, init);
        if (!res.ok) throw new Error(`loki: ${res.status} ${await res.text()}`);
      },
    },
  ],
};
