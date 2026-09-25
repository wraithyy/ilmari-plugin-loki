// Fills a Loki with a day of made-up but realistic ilmari task events, pushed
// through the plugin's own buildPush, so the dashboards can be previewed
// without running ilmari. Usage: LOKI_URL=http://localhost:3100 npm run demo
import { hostname } from "node:os";
import { buildPush } from "../dist/index.js";

const url = process.env.LOKI_URL ?? "http://localhost:3100";
const TASKS = Number(process.env.DEMO_TASKS ?? 60);

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const chance = (p) => Math.random() < p;
const between = (a, b) => a + Math.random() * (b - a);

const PROJECTS = ["pokedex", "billing-api", "docs-site", "mobile-app"];
const WORKFLOWS = ["default", "bugfix", "review-only"];
const TITLES = [
  "Fix pagination on the search page",
  "Add retry to the payment webhook",
  "Upgrade React Router to v8",
  "Flaky login e2e test",
  "Document the export API",
  "Dark mode for settings",
  "N+1 query in order history",
  "Rename legacy config keys",
];
const MODELS = [
  { adapter: "claude", model: "claude-sonnet-5", perMTokIn: 2, perMTokOut: 10 },
  { adapter: "claude", model: "claude-opus-5-5", perMTokIn: 5, perMTokOut: 25 },
  { adapter: "codex", model: "gpt-5-codex", perMTokIn: 1.25, perMTokOut: 10 },
];
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Glob", "Write", "kb_read", "web_fetch"];
const VERIFY = ["pnpm test", "pnpm lint", "pnpm typecheck"];
const SAY = [
  "Reading the failing test to understand the expected behaviour.",
  "The bug is an off-by-one in the page offset; fixing it in the query builder.",
  "Adding a regression test for the empty result case.",
  "All checks pass locally, preparing the change for review.",
];

function taskEvents(start) {
  const id = crypto.randomUUID();
  const project = pick(PROJECTS);
  const workflow = pick(WORKFLOWS);
  const m = chance(0.6) ? MODELS[0] : pick(MODELS);
  let t = start;
  const out = [];
  const ev = (type, data, stepMs = between(200, 4000)) => {
    t += stepMs;
    out.push({ taskId: id, ts: new Date(t).toISOString(), type, data });
  };

  ev("task_created", { title: pick(TITLES), repo: `/srv/repos/${project}`, branch: `ilmari/${id.slice(0, 8)}`, workflow });
  const nodes = workflow === "review-only" ? ["review"] : ["plan", "implement", "verify", "review", "deliver"];
  for (const node of nodes) {
    ev("node_started", { node, type: node === "verify" ? "verify" : "agent" });
    if (node === "verify") {
      for (const command of VERIFY) {
        const failed = chance(0.12);
        ev("verify_result", { command, exitCode: failed ? 1 : 0, outputTail: failed ? "1 failing" : "ok" }, between(5_000, 60_000));
      }
      continue;
    }
    if (node === "deliver") {
      ev("delivered", { branch: `ilmari/${id.slice(0, 8)}`, commits: 2, dirty: false });
      ev("mr_created", { url: `https://gitlab.example.com/acme/${project}/-/merge_requests/${Math.floor(between(10, 900))}` });
      continue;
    }
    const began = t;
    for (let i = 0, n = Math.floor(between(2, 12)); i < n; i++) {
      ev("tool_use", { name: pick(TOOLS), input: JSON.stringify({ path: `src/${pick(["api", "ui", "db"])}/index.ts` }) }, between(1_000, 20_000));
      if (chance(0.3)) ev("agent_text", { text: pick(SAY) });
    }
    const input = Math.floor(between(8_000, 120_000));
    const output = Math.floor(between(500, 12_000));
    const failed = chance(node === "implement" ? 0.12 : 0.04);
    const costUsd = Number(((input * m.perMTokIn + output * m.perMTokOut) / 1e6).toFixed(4));
    ev("node_finished", {
      node,
      ok: !failed,
      turns: Math.floor(between(2, 30)),
      costUsd,
      adapter: m.adapter,
      model: m.model,
      usage: {
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: Math.floor(input * between(0.3, 0.9)),
        cacheCreationTokens: Math.floor(input * between(0, 0.2)),
      },
      durationMs: Math.floor(t - began + between(1_000, 5_000)),
      ...(failed ? { failureClass: pick(["quota", "timeout", "agent"]) } : {}),
    });
    if (node === "review") {
      const verdict = chance(0.8) ? "PASS" : "REJECT";
      ev("review_result", { node, verdict, findings: verdict === "PASS" ? "" : "Missing test for the error path." });
    }
    if (failed) {
      if (chance(0.5)) {
        ev("node_retry", { node, attempt: 2 });
      } else {
        ev("task_failed", { reason: `node ${node}: agent gave up after repeated tool errors` });
        return out;
      }
    }
  }
  if (chance(0.1)) ev("budget_alert", { window: "day", spentUsd: 42, ceilingUsd: 50, level: "warn" });
  return out;
}

const now = Date.now();
const events = [];
const spans = [];
for (let i = 0; i < TASKS; i++) {
  const evs = taskEvents(now - between(10 * 60_000, 23 * 3600_000));
  events.push(...evs);
  spans.push({ task: evs[0].taskId, pid: 20_000 + i, from: Date.parse(evs[0].ts), to: Date.parse(evs.at(-1).ts) });
}

// One `system` sample a minute from the serve daemon, plus one per running
// task process, shaped like sampleSystem() and loaded by how busy the host is.
const MB = 1024 * 1024;
const system = (ts, data) => ({ taskId: "system", ts: new Date(ts).toISOString(), type: "system", data });
const hostBase = { host: hostname(), platform: "linux", osRelease: "6.8.0", nodeVersion: "v24.7.0", cpus: 8, memTotal: 32 * 1024 * MB };
for (let t = now - 24 * 3600_000; t < now; t += 60_000) {
  const running = spans.filter((sp) => sp.from <= t && t <= sp.to);
  const load1 = 0.4 + running.length * 1.7 + between(0, 0.6);
  const memUsedPct = Math.min(97, 38 + running.length * 7 + between(0, 3));
  const host = { ...hostBase, load1, load5: load1 * 0.85, load15: load1 * 0.7, memUsedPct, memFree: hostBase.memTotal * (1 - memUsedPct / 100), hostUptimeSec: 900_000 + (t - now) / 1000 };
  const serveRss = (160 + ((t - (now - 24 * 3600_000)) / 3600_000) * 1.5 + between(0, 12)) * MB;
  events.push(system(t, { ...host, pid: 4242, role: "serve", processUptimeSec: 90_000, processCpuPct: 2 + running.length * 3 + between(0, 2), rss: serveRss, heapUsed: serveRss * 0.55, heapTotal: serveRss * 0.7, eventLoopLagMs: between(0.3, 2) + running.length * 0.8 }));
  for (const sp of running) {
    const progress = (t - sp.from) / Math.max(1, sp.to - sp.from);
    const rss = (190 + progress * 280 + between(0, 25)) * MB;
    events.push(system(t, { ...host, pid: sp.pid, role: "run", task: sp.task, processUptimeSec: (t - sp.from) / 1000, processCpuPct: between(15, 95), rss, heapUsed: rss * 0.6, heapTotal: rss * 0.75, eventLoopLagMs: between(1, 12) }));
  }
}
// Chronological, like a live ilmari: Loki rejects entries more than ~1h behind
// a stream's newest one. A task's task_created is its earliest event, so
// buildPush has remembered the project before the task's later events.
events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

let sent = 0;
let rejected = 0;
const queue = [...events];
await Promise.all(
  Array.from({ length: 16 }, async () => {
    while (queue.length) {
      const e = queue.shift();
      const { url: push, init } = buildPush(e, { url });
      const res = await fetch(push, init);
      const text = await res.text();
      // A second run into the same Loki hits its per-stream out-of-order
      // window; skip those instead of aborting the whole demo.
      if (res.status === 400 && text.includes("too far behind")) rejected++;
      else if (!res.ok) throw new Error(`push failed: ${res.status} ${text}`);
      else sent++;
    }
  }),
);
console.log(`pushed ${sent} events for ${TASKS} tasks to ${url}`);
// Loki only reads unflushed ingester data for the last 3h; a backfilled day
// shows up fully once the ingester flushes, which a restart forces.
console.log("run `docker compose restart loki` in grafana/ to see the whole day");
if (rejected) console.log(`${rejected} rejected as too old for streams that already hold newer data`);
