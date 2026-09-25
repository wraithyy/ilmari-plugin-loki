import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import plugin from "../dist/index.js";

const sink = plugin.sinks[0];
const EVENT = {
  taskId: "t-42",
  ts: "2026-09-25T10:00:00.123Z",
  type: "agent_text",
  data: { text: "hi" },
};
const ctxWith = (cfg) => ({ pluginConfig: () => cfg });

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
  assert.deepEqual(streams[0].stream, { service_name: "ilmari", type: "agent_text" });
  assert.deepEqual(streams[0].values, [
    [
      "1790330400123000000",
      JSON.stringify({ task: "t-42", type: "agent_text", data: { text: "hi" } }),
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

test("entry is statically inspectable", { skip: !process.env.ILMARI_SRC }, async () => {
  // point ILMARI_SRC at an ilmari checkout: node runs its .ts directly
  const { inspectPluginSource } = await import(`${process.env.ILMARI_SRC}/src/plugin-static.ts`);
  const result = inspectPluginSource(
    readFileSync(new URL("../dist/index.js", import.meta.url), "utf8"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.meta.capabilities, ["net", "secrets"]);
});
