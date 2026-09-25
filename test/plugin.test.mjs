import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createServer } from "node:http";
import { test } from "node:test";
import plugin, { buildPush, levelOf, sampleSystem } from "../dist/index.js";

const sink = plugin.sinks[0];
const EVENT = {
  taskId: "t-42",
  ts: "2026-09-25T10:00:00.123Z",
  type: "agent_text",
  data: { text: "hi" },
};
// systemIntervalSeconds "0" keeps the once-a-minute sampler out of tests
// that are not about it; the sampler test turns it on explicitly.
const ctxWith = (cfg) => ({ pluginConfig: () => ({ systemIntervalSeconds: "0", ...cfg }) });

/** Fake Loki: records every request, answers with `status`. */
async function fakeLoki(status = 204) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(status);
      res.end(status >= 300 ? "bad things" : "");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

test("no url: no request, no error", async () => {
  const loki = await fakeLoki();
  await sink.handle(EVENT, ctxWith({}));
  assert.equal(loki.seen.length, 0);
  await loki.close();
});

test("pushes one stream with low-cardinality labels and a JSON line", async () => {
  const loki = await fakeLoki();
  await sink.handle(EVENT, ctxWith({ url: loki.url }));
  assert.equal(loki.seen.length, 1);
  const [req] = loki.seen;
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/loki/api/v1/push");
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers["x-scope-orgid"], undefined);
  const { streams } = JSON.parse(req.body);
  assert.deepEqual(streams[0].stream, {
    service_name: "ilmari",
    type: "agent_text",
    level: "info",
    host: hostname(),
  });
  assert.deepEqual(streams[0].values, [
    [
      "1790330400123000000",
      JSON.stringify({ task: "t-42", type: "agent_text", data: { text: "hi" }, at: 1790330400123 }),
    ],
  ]);
  await loki.close();
});

test("basic auth wins over bearer; tenant sets X-Scope-OrgID", async () => {
  const loki = await fakeLoki();
  const cfg = { url: loki.url, username: "u", password: "p", token: "tok", tenant: "team-a" };
  await sink.handle(EVENT, ctxWith(cfg));
  const { headers } = loki.seen[0];
  assert.equal(headers.authorization, `Basic ${Buffer.from("u:p").toString("base64")}`);
  assert.equal(headers["x-scope-orgid"], "team-a");
  await loki.close();
});

test("bearer token when no username", async () => {
  const loki = await fakeLoki();
  await sink.handle(EVENT, ctxWith({ url: loki.url, token: "tok" }));
  assert.equal(loki.seen[0].headers.authorization, "Bearer tok");
  await loki.close();
});

test("non-2xx rejects so ilmari reports the failing sink", async () => {
  const loki = await fakeLoki(401);
  await assert.rejects(sink.handle(EVENT, ctxWith({ url: loki.url })), /loki: 401 bad things/);
  await loki.close();
});

test("levels: failures are errors, retries/budget are warnings", () => {
  const lv = (type, data = {}) => levelOf({ type, data });
  assert.equal(lv("task_failed"), "error");
  assert.equal(lv("node_finished", { ok: false }), "error");
  assert.equal(lv("node_finished", { ok: true }), "info");
  assert.equal(lv("verify_result", { exitCode: 1 }), "error");
  assert.equal(lv("verify_result", { exitCode: 1, preexisting: true }), "info");
  assert.equal(lv("verify_result", { exitCode: 0 }), "info");
  assert.equal(lv("review_result", { verdict: "REJECT" }), "warn");
  assert.equal(lv("budget_alert"), "warn");
  assert.equal(lv("agent_text"), "info");
});

test("task_created's project/workflow/title follow every later event of the task", () => {
  const cfg = { url: "http://loki" };
  const at = (type, data) => ({ taskId: "t-enrich", ts: EVENT.ts, type, data });
  const parse = (r) => JSON.parse(r.init.body).streams[0];
  const created = parse(
    buildPush(at("task_created", { repo: "/src/pokedex/", workflow: "default", title: "Fix #1" }), cfg),
  );
  assert.equal(created.stream.project, "pokedex");
  const later = parse(buildPush(at("node_finished", { ok: true, costUsd: 0.5 }), cfg));
  assert.deepEqual(later.stream, {
    service_name: "ilmari",
    type: "node_finished",
    level: "info",
    host: hostname(),
    project: "pokedex",
  });
  assert.deepEqual(JSON.parse(later.values[0][1]), {
    task: "t-enrich",
    type: "node_finished",
    project: "pokedex",
    workflow: "default",
    title: "Fix #1",
    data: { ok: true, costUsd: 0.5 },
    at: 1790330400123,
  });
});

test("sampleSystem reports host and process numbers", () => {
  const s = sampleSystem();
  assert.equal(s.host, hostname());
  assert.equal(s.pid, process.pid);
  for (const k of ["cpus", "load1", "memTotal", "memUsedPct", "rss", "heapUsed", "processCpuPct", "eventLoopLagMs"]) {
    assert.equal(typeof s[k], "number", k);
    assert.ok(Number.isFinite(s[k]), k);
  }
  assert.ok(s.memUsedPct >= 0 && s.memUsedPct <= 100);
});

test("the sampler pushes system events, tagged with the last task seen", async () => {
  const loki = await fakeLoki();
  await sink.handle(EVENT, ctxWith({ url: loki.url, systemIntervalSeconds: "0.05" }));
  await new Promise((r) => setTimeout(r, 200));
  const systems = loki.seen
    .map((r) => JSON.parse(r.body).streams[0])
    .filter((st) => st.stream.type === "system");
  assert.ok(systems.length >= 1, `expected system samples, got ${loki.seen.length} requests`);
  const line = JSON.parse(systems[0].values[0][1]);
  assert.equal(line.task, "system");
  assert.equal(line.data.task, "t-42");
  assert.equal(systems[0].stream.host, hostname());
  await loki.close();
});

test("entry is statically inspectable", { skip: !process.env.ILMARI_SRC }, async () => {
  // point ILMARI_SRC at an ilmari checkout: node runs its .ts directly
  const { inspectPluginSource } = await import(`${process.env.ILMARI_SRC}/src/plugin-static.ts`);
  const result = inspectPluginSource(
    readFileSync(new URL("../dist/index.js", import.meta.url), "utf8"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.meta.capabilities, ["net", "secrets"]);
});
