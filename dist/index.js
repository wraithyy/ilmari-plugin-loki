// Ship every ilmari task event to Grafana Loki via its push API.
// Inactive until a URL is configured (GUI or LOKI_URL).

import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";

const NAME = "ilmari-plugin-loki";
const HOST = hostname();

const ERROR_TYPES = ["task_failed", "mr_failed", "onfail_failed"];
const WARN_TYPES = ["budget_alert", "quota_wait", "node_retry", "resume_retry", "node_fallback", "question_stale"];

/** Log level for Grafana's colouring and the level filter. */
export function levelOf(event) {
  const d = event.data ?? {};
  if (ERROR_TYPES.includes(event.type)) return "error";
  if (event.type === "node_finished" && d.ok === false) return "error";
  if (event.type === "verify_result" && d.exitCode !== 0 && !d.preexisting) return "error";
  if (event.type === "review_result" && d.verdict && d.verdict !== "PASS") return "warn";
  if (WARN_TYPES.includes(event.type)) return "warn";
  return "info";
}

// Only task_created carries repo/workflow/title; remember them so every later
// event of the task can be filtered by project in Grafana.
// ponytail: in-memory and per process, events of a task created before this
// process started go out without project; a core task context would fix that.
const tasks = new Map();
const MAX_TASKS = 5000;

function remember(event) {
  if (event.type !== "task_created") return;
  const d = event.data ?? {};
  const repo = typeof d.repo === "string" ? d.repo : "";
  tasks.set(event.taskId, {
    project: repo.split(/[\\/]/).filter(Boolean).pop(),
    workflow: d.workflow,
    title: typeof d.title === "string" ? d.title.slice(0, 200) : undefined,
  });
  if (tasks.size > MAX_TASKS) tasks.delete(tasks.keys().next().value);
}

/** Builds the push request for one event; exported for tests. */
export function buildPush(event, cfg) {
  remember(event);
  const headers = { "Content-Type": "application/json" };
  if (cfg.username) {
    headers.Authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password ?? ""}`).toString("base64")}`;
  } else if (cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }
  if (cfg.tenant) headers["X-Scope-OrgID"] = cfg.tenant;
  const task = tasks.get(event.taskId) ?? {};
  // Labels stay low-cardinality (a handful of projects, types, levels).
  // taskId stays out: one stream per task would blow up Loki's index.
  // Query it with `| json | task="..."` instead.
  const stream = { service_name: "ilmari", type: event.type, level: levelOf(event), host: HOST };
  if (task.project) stream.project = task.project;
  const at = Date.parse(event.ts);
  const line = {
    task: event.taskId,
    type: event.type,
    project: task.project,
    workflow: task.workflow,
    title: task.title,
    data: event.data,
    // epoch ms again, as a number LogQL can unwrap: min/max give a task's
    // first and last event, which the dashboards turn into its time window
    at,
  };
  const body = {
    streams: [
      {
        stream,
        values: [[String(BigInt(at) * 1_000_000n), JSON.stringify(line)]],
      },
    ],
  };
  return {
    url: `${cfg.url.replace(/\/$/, "")}/loki/api/v1/push`,
    init: { method: "POST", headers, body: JSON.stringify(body) },
  };
}

// ---------------------------------------------------------------- system
// Every ilmari process that loads the plugin (the serve daemon and each task
// run) samples its host and itself once a minute into a `system` event, so
// Grafana can put CPU and memory next to the tasks that caused them.

let lastTask; // the task this process last saw, set on every event
let sampler;
let prevCpu = process.cpuUsage();
let prevAt = Date.now();
const loopDelay = monitorEventLoopDelay({ resolution: 20 });

/** One host + process snapshot; exported for tests. */
export function sampleSystem(now = Date.now()) {
  const cpu = process.cpuUsage(prevCpu);
  const elapsedMs = Math.max(1, now - prevAt);
  prevCpu = process.cpuUsage();
  prevAt = now;
  const mem = process.memoryUsage();
  const [load1, load5, load15] = loadavg();
  const lagP99 = loopDelay.percentile(99) / 1e6;
  loopDelay.reset();
  return {
    host: HOST,
    platform: platform(),
    osRelease: release(),
    nodeVersion: process.version,
    pid: process.pid,
    // `ilmari serve`, `ilmari run`, ... tells the daemon from task processes
    role: process.argv[2] ?? "unknown",
    task: lastTask,
    cpus: cpus().length,
    load1,
    load5,
    load15,
    memTotal: totalmem(),
    memFree: freemem(),
    memUsedPct: (1 - freemem() / totalmem()) * 100,
    hostUptimeSec: Math.round(uptime()),
    processUptimeSec: Math.round(process.uptime()),
    processCpuPct: ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    eventLoopLagMs: Number.isFinite(lagP99) ? lagP99 : 0,
  };
}

function startSampler(cfg) {
  const seconds = Number(cfg.systemIntervalSeconds ?? 60);
  if (sampler || !(seconds > 0)) return;
  loopDelay.enable();
  sampler = setInterval(() => {
    const event = { taskId: "system", ts: new Date().toISOString(), type: "system", data: sampleSystem() };
    const { url, init } = buildPush(event, sampler.cfg);
    // ponytail: a failed sample is dropped silently; it must never reach
    // ilmari as an unhandled rejection, and the next one retries anyway
    fetch(url, init).catch(() => {});
  }, seconds * 1000);
  sampler.unref(); // never keep a finished `ilmari run` alive
  sampler.cfg = cfg;
}

export default {
  name: "ilmari-plugin-loki",
  version: "0.2.0",
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
    systemIntervalSeconds: {
      label: "System sample interval (s)",
      description: "How often each ilmari process reports host CPU/memory and its own memory. Default 60; 0 turns it off.",
      env: "LOKI_SYSTEM_INTERVAL",
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
        if (event.taskId && event.taskId !== "system") lastTask = event.taskId;
        startSampler(cfg);
        if (sampler) sampler.cfg = cfg; // pick up config edits
        // ponytail: one push per event, batch with a flush timer if Loki load shows it
        const { url, init } = buildPush(event, cfg);
        const res = await fetch(url, init);
        if (!res.ok) throw new Error(`loki: ${res.status} ${await res.text()}`);
      },
    },
  ],
};
