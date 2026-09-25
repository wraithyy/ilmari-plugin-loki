// Generates grafana/dashboards/*.json. Panels share one stream selector and a
// handful of LogQL shapes, so building them here keeps the committed JSON
// consistent; edit this file and run `npm run dashboards`, not the JSON.
import { writeFileSync } from "node:fs";

const DS = { type: "loki", uid: "${datasource}" };
const BASE = 'service_name="ilmari", project=~"$project"';
const sel = (extra = "") => `{${BASE}${extra ? `, ${extra}` : ""}}`;
const NODE = sel('type="node_finished"');
// Selective json extraction: parsing only the fields a panel needs keeps
// queries cheap on big lines (agent_text, task_created's graph snapshot).
const json = (fields) => `| json ${fields}`;
const unwrap = (s, field, extra = "") =>
  `${s} ${json(`v="data.${field}"${extra ? `, ${extra}` : ""}`)} | unwrap v | __error__=""`;
const count = (s, range = "$__range") => `sum(count_over_time(${s} [${range}]))`;
const TASK_LINK = "/d/ilmari-task/ilmari-task-explorer?var-task=${__data.fields.task}&${__url_time_range}";
// Opens the task zoomed to its own run, from its first to its last event.
const TASK_RUN_LINK = "/d/ilmari-task/ilmari-task-explorer?var-task=${__data.fields.task}&from=${__data.fields.first}&to=${__data.fields.last}";

let nextId = 1;
const grid = (x, y, w, h) => ({ x, y, w, h });

function panel(type, title, pos, targets, extra = {}) {
  return {
    id: nextId++,
    type,
    title,
    datasource: DS,
    gridPos: pos,
    targets: targets.map((t, i) => ({
      datasource: DS,
      refId: String.fromCharCode(65 + i),
      queryType: t.instant ? "instant" : "range",
      editorMode: "code",
      ...t,
    })),
    ...extra,
  };
}

const fixed = (color) => ({ mode: "absolute", steps: [{ color, value: null }] });

function stat(title, pos, expr, unit, { color = "blue", thresholds, description, decimals } = {}) {
  return panel("stat", title, pos, [{ expr, instant: true, legendFormat: title }], {
    description,
    options: {
      reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
      colorMode: "background_solid",
      graphMode: "none",
      textMode: "value",
      justifyMode: "center",
      wideLayout: true,
    },
    fieldConfig: {
      defaults: {
        unit,
        decimals,
        noValue: "0",
        color: { mode: "thresholds" },
        thresholds: thresholds ?? fixed(color),
      },
      overrides: [],
    },
  });
}

// Bars per 30 minutes (or coarser on long ranges) read far better than
// Grafana's default ~1 minute step, where sparse events become hairlines.
function series(title, pos, targets, unit, { stack = true, description, overrides = [], interval = "30m", lines = false, max } = {}) {
  return panel("timeseries", title, pos, targets, {
    description,
    interval,
    options: {
      legend: { displayMode: "list", placement: "bottom", showLegend: true },
      tooltip: { mode: "multi", sort: "desc" },
    },
    fieldConfig: {
      defaults: {
        unit,
        min: 0,
        max,
        color: { mode: "palette-classic" },
        custom: {
          drawStyle: lines ? "line" : "bars",
          fillOpacity: lines ? 18 : 85,
          lineWidth: lines ? 2 : 1,
          lineInterpolation: "smooth",
          gradientMode: "none",
          barAlignment: 0,
          stacking: { mode: stack ? "normal" : "none", group: "A" },
          showPoints: "never",
          axisSoftMin: 0,
        },
      },
      overrides,
    },
  });
}

// Instant metric queries reach the panel as one table row per series, so
// bar gauges and pies must render every row (values: true), not a reduction.
const ROWS = { calcs: [], fields: "", values: true };

function bars(title, pos, targets, unit, { description, color, decimals } = {}) {
  return panel("bargauge", title, pos, targets, {
    description,
    options: {
      orientation: "horizontal",
      displayMode: "gradient",
      valueMode: "color",
      showUnfilled: true,
      namePlacement: "left",
      sizing: "auto",
      text: { titleSize: 13, valueSize: 14 },
      reduceOptions: ROWS,
    },
    transformations: [{ id: "sortBy", options: { sort: [{ field: "Value #A", desc: true }] } }],
    fieldConfig: {
      defaults: {
        unit,
        decimals,
        min: 0,
        color: color ? { mode: "fixed", fixedColor: color } : { mode: "continuous-BlPu" },
      },
      overrides: [],
    },
  });
}

function donut(title, pos, targets, unit, { overrides = [] } = {}) {
  return panel("piechart", title, pos, targets, {
    options: {
      pieType: "donut",
      displayLabels: ["percent"],
      legend: { displayMode: "table", placement: "right", values: ["value", "percent"], showLegend: true },
      reduceOptions: ROWS,
      tooltip: { mode: "single" },
    },
    fieldConfig: { defaults: { unit, color: { mode: "palette-classic" } }, overrides },
  });
}

function logs(title, pos, expr, { description } = {}) {
  return panel("logs", title, pos, [{ expr, maxLines: 1000 }], {
    description,
    options: {
      showTime: true,
      showLabels: false,
      showCommonLabels: false,
      wrapLogMessage: true,
      prettifyLogMessage: false,
      enableLogDetails: true,
      enableInfiniteScrolling: true,
      dedupStrategy: "none",
      sortOrder: "Descending",
    },
  });
}

const row = (title, y) => ({
  id: nextId++,
  type: "row",
  title,
  collapsed: false,
  gridPos: grid(0, y, 24, 1),
  panels: [],
});

const byName = (name, properties) => ({ matcher: { id: "byName", options: name }, properties });
const colorOf = (name, color) => byName(name, [{ id: "color", value: { mode: "fixed", fixedColor: color } }]);

// One human line per event type, prefixed with project and short task id.
// Fields come from a selective json stage; unknown types show the raw line.
const pretty = (filter = "") =>
  [
    json(
      'task, title, node="data.node", ok="data.ok", cost="data.costUsd", dur="data.durationMs", ' +
        'model="data.model", tool="data.name", input="data.input", text="data.text", reason="data.reason", ' +
        'command="data.command", exitCode="data.exitCode", url="data.url", verdict="data.verdict", ' +
        'findings="data.findings", failureClass="data.failureClass", branch="data.branch", ' +
        'spent="data.spentUsd", ceiling="data.ceilingUsd", attempt="data.attempt"',
    ),
    filter,
    '| line_format `{{ if .project }}[{{ .project }}] {{ end }}{{ trunc 8 .task }}  ',
    '{{- if eq .type "task_created" }} task started: {{ .title }}',
    '{{- else if eq .type "node_started" }} step {{ .node }} started',
    '{{- else if eq .type "node_finished" }} step {{ .node }} {{ if eq .ok "true" }}done{{ else }}FAILED{{ if .failureClass }} ({{ .failureClass }}){{ end }}{{ end }}  |  {{ printf "%.2f" (float64 .cost) }} USD  |  {{ div (int .dur) 1000 }}s  |  {{ .model }}',
    '{{- else if eq .type "tool_use" }} tool {{ .tool }}  {{ trunc 160 .input }}',
    '{{- else if eq .type "agent_text" }} agent: {{ trunc 300 .text }}',
    '{{- else if eq .type "task_failed" }} TASK FAILED: {{ .reason }}',
    '{{- else if eq .type "verify_result" }} verify "{{ .command }}" {{ if eq .exitCode "0" }}passed{{ else }}FAILED (exit {{ .exitCode }}){{ end }}',
    '{{- else if eq .type "review_result" }} review {{ .verdict }}{{ if .findings }}: {{ trunc 200 .findings }}{{ end }}',
    '{{- else if eq .type "mr_created" }} merge request opened {{ .url }}',
    '{{- else if eq .type "delivered" }} delivered on {{ .branch }}',
    '{{- else if eq .type "node_retry" }} retrying step {{ .node }} (attempt {{ .attempt }})',
    '{{- else if eq .type "budget_alert" }} budget alert: {{ .spent }} of {{ .ceiling }} USD',
    '{{- else }} {{ .type }}  {{ __line__ }}{{ end }}`',
  ].join(" ");

const labelVar = (name, label, extra = {}) => ({
  name,
  label,
  type: "query",
  datasource: DS,
  query: { refId: name, stream: '{service_name="ilmari"}', type: 1, label: name },
  definition: `label_values({service_name="ilmari"}, ${name})`,
  includeAll: true,
  allValue: ".*",
  multi: true,
  current: { text: "All", value: "$__all" },
  refresh: 2,
  sort: 1,
  ...extra,
});
const datasourceVar = { name: "datasource", label: "Loki", type: "datasource", query: "loki", current: {}, refresh: 1 };
const textVar = (name, label) => ({ name, label, type: "textbox", query: "", current: { text: "", value: "" } });

function dashboard({ uid, title, description, panels, variables, links, annotateTitles }) {
  const ids = panels.filter((p) => annotateTitles.includes(p.title)).map((p) => p.id);
  return {
    uid,
    title,
    description,
    tags: ["ilmari", "loki"],
    timezone: "browser",
    editable: true,
    graphTooltip: 1,
    refresh: "30s",
    time: { from: "now-24h", to: "now" },
    schemaVersion: 39,
    version: 1,
    templating: { list: variables },
    annotations: {
      list: [
        {
          name: "Task failures",
          datasource: DS,
          enable: true,
          iconColor: "red",
          expr: `${sel('type="task_failed"')} ${json('task, title, reason="data.reason"')}`,
          target: { refId: "Anno", expr: `${sel('type="task_failed"')} ${json('task, title, reason="data.reason"')}` },
          titleFormat: "Task failed: {{title}}",
          textFormat: "{{reason}}",
          filter: { exclude: false, ids },
        },
      ],
    },
    links,
    panels,
  };
}

const LINKS = [
  { title: "Overview", type: "link", url: "/d/ilmari-overview/ilmari-overview", icon: "apps", keepTime: true, includeVars: false },
  { title: "Task explorer", type: "link", url: "/d/ilmari-task/ilmari-task-explorer", icon: "search", keepTime: true },
  { title: "Host", type: "link", url: "/d/ilmari-host/ilmari-host", icon: "bolt", keepTime: true },
  {
    title: "Logs Drilldown",
    type: "link",
    url: "/a/grafana-lokiexplore-app/explore/service/ilmari/logs",
    icon: "external link",
    keepTime: true,
    tooltip: "Grafana's point-and-click log browser, pre-filtered to ilmari",
  },
];

/**
 * One row per task: every metric is grouped by (task, title, project), which
 * the plugin puts on every line, then merged into a single table.
 */
function tasksTable(title, pos, extraFilter = "", description) {
  const by = "task, title, project";
  const j = (extra = "") => json(`task, title${extra ? `, ${extra}` : ""}`);
  const f = extraFilter ? ` ${extraFilter}` : "";
  const q = (expr) => ({ expr, instant: true, format: "table", legendFormat: "" });
  return panel(
    "table",
    title,
    pos,
    [
      q(`sum by (${by}) (sum_over_time(${NODE} ${j('v="data.costUsd"')}${f} | unwrap v | __error__="" [$__range]))`),
      q(`sum by (${by}) (count_over_time(${NODE} ${j()}${f} [$__range]))`),
      q(`sum by (${by}) (count_over_time(${sel('type="node_finished", level="error"')} ${j()}${f} [$__range]))`),
      q(`sum by (${by}) (count_over_time(${sel('type="tool_use"')} ${j()}${f} [$__range]))`),
      q(`sum by (${by}) (sum_over_time(${NODE} ${j('v="data.durationMs"')}${f} | unwrap v | __error__="" [$__range]))`),
      q(`sum by (${by}) (count_over_time(${sel('type="task_failed"')} ${j()}${f} [$__range]))`),
      q(`sum by (${by}) (count_over_time(${sel('type="mr_created"')} ${j()}${f} [$__range]))`),
      q(`min by (${by}) (min_over_time(${sel('type!="system"')} ${j('v="at"')}${f} | unwrap v | __error__="" [$__range]))`),
      q(`max by (${by}) (max_over_time(${sel('type!="system"')} ${j('v="at"')}${f} | unwrap v | __error__="" [$__range]))`),
    ],
    {
      description,
      transformations: [
        { id: "merge", options: {} },
        {
          id: "organize",
          options: {
            excludeByName: { Time: true },
            indexByName: { project: 0, title: 1, "Value #F": 2, "Value #G": 3, "Value #A": 4, "Value #B": 5, "Value #C": 6, "Value #D": 7, "Value #E": 8, task: 9 },
            renameByName: {
              project: "Project",
              title: "Task",
              task: "Task id",
              "Value #A": "Spend",
              "Value #B": "Steps",
              "Value #C": "Failed steps",
              "Value #D": "Tool calls",
              "Value #E": "Agent time",
              "Value #F": "Outcome",
              "Value #G": "MR",
              "Value #H": "first",
              "Value #I": "last",
            },
          },
        },
        // tasks with no steps yet (only task_created) still get a row
        { id: "filterByValue", options: { filters: [{ fieldName: "Task", config: { id: "isNotNull" } }], type: "include", match: "all" } },
        { id: "sortBy", options: { sort: [{ field: "Spend", desc: true }] } },
      ],
      options: { showHeader: true, cellHeight: "sm" },
      fieldConfig: {
        defaults: { custom: { align: "auto", filterable: true }, noValue: "-" },
        overrides: [
          byName("Task", [
            { id: "custom.width", value: 340 },
            { id: "links", value: [{ title: "Open in Task explorer", url: TASK_RUN_LINK }] },
          ]),
          byName("Task id", [{ id: "custom.width", value: 300 }]),
          byName("first", [{ id: "custom.hidden", value: true }]),
          byName("last", [{ id: "custom.hidden", value: true }]),
          byName("Spend", [
            { id: "unit", value: "currencyUSD" },
            { id: "decimals", value: 2 },
            { id: "custom.cellOptions", value: { type: "gauge", mode: "gradient", valueDisplayMode: "text" } },
            { id: "color", value: { mode: "continuous-BlPu" } },
            { id: "min", value: 0 },
          ]),
          byName("Agent time", [{ id: "unit", value: "ms" }]),
          byName("Failed steps", [
            { id: "custom.cellOptions", value: { type: "color-text" } },
            { id: "thresholds", value: { mode: "absolute", steps: [{ color: "text", value: null }, { color: "red", value: 1 }] } },
          ]),
          byName("Outcome", [
            { id: "custom.width", value: 110 },
            { id: "custom.cellOptions", value: { type: "color-text" } },
            { id: "thresholds", value: { mode: "absolute", steps: [{ color: "transparent", value: null }, { color: "red", value: 1 }] } },
            { id: "mappings", value: [{ type: "range", options: { from: 1, to: 1e9, result: { text: "failed", color: "red", index: 0 } } }] },
            { id: "noValue", value: "" },
          ]),
          byName("MR", [
            { id: "custom.width", value: 90 },
            { id: "custom.cellOptions", value: { type: "color-text" } },
            { id: "mappings", value: [{ type: "range", options: { from: 1, to: 1e9, result: { text: "opened", color: "green", index: 0 } } }] },
            { id: "noValue", value: "" },
          ]),
        ],
      },
    },
  );
}

// ---------------------------------------------------------------- overview
nextId = 1;
const cost = (by) => `sum by (${by}) (sum_over_time(${unwrap(NODE, "costUsd", by === "project" ? "" : `${by}="data.${by}"`)} [$__interval]))`;
const tokens = (field) => `sum(sum_over_time(${unwrap(NODE, `usage.${field}`)} [$__interval]))`;
const spendTotal = `sum(sum_over_time(${unwrap(NODE, "costUsd")} [$__range]))`;
const verifyFails = sel('type="verify_result", level="error"');
const FEED = sel('type=~"$type", type!="system", level=~"$level"');

const overview = dashboard({
  uid: "ilmari-overview",
  title: "ilmari - Overview",
  description: "Tasks, agent spend, tokens, reliability and a browsable activity log from ilmari task events.",
  variables: [
    datasourceVar,
    labelVar("project", "Project"),
    labelVar("type", "Event type"),
    labelVar("level", "Level"),
    textVar("search", "Search logs"),
  ],
  links: LINKS.filter((l) => l.title !== "Overview"),
  annotateTitles: ["Tasks per 30 min"],
  panels: [
    row("At a glance", 0),
    stat("Tasks started", grid(0, 1, 3, 4), count(sel('type="task_created"')), "short", { color: "blue" }),
    stat("Tasks failed", grid(3, 1, 3, 4), count(sel('type="task_failed"')), "short", {
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "red", value: 1 }] },
    }),
    stat("Failure rate", grid(6, 1, 3, 4), `${count(sel('type="task_failed"'))} / ${count(sel('type="task_created"'))}`, "percentunit", {
      decimals: 1,
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 0.1 }, { color: "red", value: 0.25 }] },
    }),
    stat("Agent spend", grid(9, 1, 3, 4), spendTotal, "currencyUSD", { color: "purple", decimals: 2 }),
    stat("Avg spend per task", grid(12, 1, 3, 4), `${spendTotal} / ${count(sel('type="task_created"'))}`, "currencyUSD", {
      color: "purple",
      decimals: 2,
      description: "Agent spend divided by tasks started in the range.",
    }),
    stat("Agent steps", grid(15, 1, 3, 4), count(NODE), "short", { color: "blue" }),
    stat("Avg step time", grid(18, 1, 3, 4), `sum(sum_over_time(${unwrap(NODE, "durationMs")} [$__range])) / ${count(NODE)}`, "ms", {
      color: "#1f7a8c",
      decimals: 1,
    }),
    stat("MRs opened", grid(21, 1, 3, 4), count(sel('type="mr_created"')), "short", { color: "green" }),

    row("Tasks", 5),
    tasksTable("Tasks", grid(0, 6, 24, 10), "", "Every task in the range. Click a task to open it in the Task explorer; columns are sortable and filterable."),

    row("Spend and tokens", 16),
    series("Spend by model", grid(0, 17, 12, 8), [{ expr: cost("model"), legendFormat: "{{model}}" }], "currencyUSD", {
      description: "Agent cost of finished steps per 30 minutes, by the model that ran them.",
    }),
    series("Spend by project", grid(12, 17, 12, 8), [{ expr: cost("project"), legendFormat: "{{project}}" }], "currencyUSD"),
    series(
      "Tokens",
      grid(0, 25, 16, 8),
      [
        { expr: tokens("inputTokens"), legendFormat: "input" },
        { expr: tokens("outputTokens"), legendFormat: "output" },
        { expr: tokens("cacheReadTokens"), legendFormat: "cache read" },
        { expr: tokens("cacheCreationTokens"), legendFormat: "cache write" },
      ],
      "short",
      {
        overrides: [colorOf("input", "blue"), colorOf("output", "orange"), colorOf("cache read", "green"), colorOf("cache write", "purple")],
      },
    ),
    donut(
      "Spend by adapter",
      grid(16, 25, 8, 8),
      [{ expr: `sum by (adapter) (sum_over_time(${unwrap(NODE, "costUsd", 'adapter="data.adapter"')} [$__range]))`, instant: true, format: "table" }],
      "currencyUSD",
    ),

    row("Reliability", 33),
    series(
      "Tasks per 30 min",
      grid(0, 34, 8, 8),
      [
        { expr: count(sel('type="task_created"'), "$__interval"), legendFormat: "started" },
        { expr: count(sel('type="mr_created"'), "$__interval"), legendFormat: "MR opened" },
        { expr: count(sel('type="task_failed"'), "$__interval"), legendFormat: "failed" },
      ],
      "short",
      {
        stack: false,
        description: "Red markers are task failures; hover one for its reason.",
        overrides: [colorOf("started", "blue"), colorOf("MR opened", "green"), colorOf("failed", "red")],
      },
    ),
    series(
      "Failed steps by cause",
      grid(8, 34, 8, 8),
      [
        {
          expr: `sum by (cause) (count_over_time(${sel('type="node_finished", level="error"')} ${json('cause="data.failureClass"')} [$__interval]))`,
          legendFormat: "{{cause}}",
        },
      ],
      "short",
      { description: "failureClass of steps that finished with ok=false." },
    ),
    series(
      "Verification runs",
      grid(16, 34, 8, 8),
      [
        { expr: count(sel('type="verify_result", level="info"'), "$__interval"), legendFormat: "passed" },
        { expr: count(verifyFails, "$__interval"), legendFormat: "failed" },
      ],
      "short",
      { overrides: [colorOf("passed", "green"), colorOf("failed", "red")] },
    ),
    bars(
      "Failing verify commands",
      grid(0, 42, 8, 8),
      [{ expr: `topk(8, sum by (command) (count_over_time(${verifyFails} ${json('command="data.command"')} [$__range])))`, instant: true, format: "table" }],
      "short",
      { color: "red" },
    ),
    donut(
      "Review verdicts",
      grid(8, 42, 8, 8),
      [{ expr: `sum by (verdict) (count_over_time(${sel('type="review_result"')} ${json('verdict="data.verdict"')} [$__range]))`, instant: true, format: "table" }],
      "short",
      { overrides: [colorOf("PASS", "green"), colorOf("REJECT", "red")] },
    ),
    bars(
      "Most used agent tools",
      grid(16, 42, 8, 8),
      [{ expr: `topk(10, sum by (tool) (count_over_time(${sel('type="tool_use"')} ${json('tool="data.name"')} [$__range])))`, instant: true, format: "table" }],
      "short",
      { color: "orange" },
    ),

    row("Where the time and money go", 50),
    bars(
      "Spend per step",
      grid(0, 51, 12, 8),
      [{ expr: `topk(10, sum by (node) (sum_over_time(${unwrap(NODE, "costUsd", 'node="data.node"')} [$__range])))`, instant: true, format: "table" }],
      "currencyUSD",
      { decimals: 2 },
    ),
    bars(
      "Average step duration",
      grid(12, 51, 12, 8),
      [{ expr: `topk(10, avg by (node) (avg_over_time(${unwrap(NODE, "durationMs", 'node="data.node"')} [$__range])))`, instant: true, format: "table" }],
      "ms",
      { color: "#1f7a8c", decimals: 0 },
    ),

    row("Logs", 59),
    series(
      "Log volume",
      grid(0, 60, 24, 5),
      [{ expr: `sum by (level) (count_over_time(${FEED} |~ "(?i)$search" [$__interval]))`, legendFormat: "{{level}}" }],
      "short",
      {
        interval: "10m",
        description: "Events matching the Event type, Level and Search filters above.",
        overrides: [colorOf("info", "#3274d9"), colorOf("warn", "orange"), colorOf("error", "red")],
      },
    ),
    logs("Activity log", grid(0, 65, 24, 20), `${FEED} |~ "(?i)$search" ${pretty()}`, {
      description:
        "Every task event as one readable line, newest first. Filter with Event type, Level and Search above; expand a line for all fields and a link to its task. Scroll down to load older events.",
    }),
  ],
});

// ------------------------------------------------------------ task explorer
nextId = 1;
const T = (extra) => `${sel(extra)} |= "$task" ${json("task")} | task="$task"`;
const TNODE = (field, by) =>
  `${sel('type="node_finished"')} |= "$task" ${json(`task, v="data.${field}"${by ? `, ${by}="data.${by}"` : ""}`)} | task="$task" | unwrap v | __error__=""`;

const taskDash = dashboard({
  uid: "ilmari-task",
  title: "ilmari - Task explorer",
  description: "One ilmari task: its steps, spend, verification, and the full agent transcript.",
  variables: [datasourceVar, labelVar("project", "Project"), textVar("task", "Task id")],
  links: LINKS.filter((l) => l.title !== "Task explorer"),
  annotateTitles: [],
  panels: [
    tasksTable("Pick a task", grid(0, 0, 24, 8), "", "Click a task to load it below, or paste an id into the Task id box."),
    stat("Spend", grid(0, 8, 4, 4), `sum(sum_over_time(${TNODE("costUsd")} [$__range]))`, "currencyUSD", { color: "purple", decimals: 2 }),
    stat("Steps", grid(4, 8, 4, 4), count(T('type="node_finished"')), "short", { color: "blue" }),
    stat("Failed steps", grid(8, 8, 4, 4), count(T('type="node_finished", level="error"')), "short", {
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "red", value: 1 }] },
    }),
    stat("Agent time", grid(12, 8, 4, 4), `sum(sum_over_time(${TNODE("durationMs")} [$__range]))`, "ms", { color: "#1f7a8c", decimals: 1 }),
    stat("Output tokens", grid(16, 8, 4, 4), `sum(sum_over_time(${TNODE("usage.outputTokens")} [$__range]))`, "short", { color: "orange" }),
    stat("Tool calls", grid(20, 8, 4, 4), count(T('type="tool_use"')), "short", { color: "blue" }),
    panel(
      "table",
      "Steps",
      grid(0, 12, 14, 8),
      [
        { expr: `sum by (node, model) (sum_over_time(${TNODE("costUsd", "node").replace('v="data.costUsd"', 'v="data.costUsd", model="data.model"')} [$__range]))`, instant: true, format: "table" },
        { expr: `sum by (node) (sum_over_time(${TNODE("durationMs", "node")} [$__range]))`, instant: true, format: "table" },
        { expr: `sum by (node) (sum_over_time(${TNODE("turns", "node")} [$__range]))`, instant: true, format: "table" },
        { expr: `sum by (node) (sum_over_time(${TNODE("usage.outputTokens", "node")} [$__range]))`, instant: true, format: "table" },
      ],
      {
        transformations: [
          { id: "merge", options: {} },
          {
            id: "organize",
            options: {
              excludeByName: { Time: true },
              indexByName: { node: 0, model: 1, "Value #A": 2, "Value #B": 3, "Value #C": 4, "Value #D": 5 },
              renameByName: { node: "Step", model: "Model", "Value #A": "Spend", "Value #B": "Time", "Value #C": "Turns", "Value #D": "Output tokens" },
            },
          },
          { id: "sortBy", options: { sort: [{ field: "Spend", desc: true }] } },
        ],
        fieldConfig: {
          defaults: { custom: { align: "auto" }, noValue: "-" },
          overrides: [
            byName("Spend", [
              { id: "unit", value: "currencyUSD" },
              { id: "decimals", value: 2 },
              { id: "custom.cellOptions", value: { type: "gauge", mode: "gradient", valueDisplayMode: "text" } },
              { id: "color", value: { mode: "continuous-BlPu" } },
              { id: "min", value: 0 },
            ]),
            byName("Time", [{ id: "unit", value: "ms" }]),
          ],
        },
      },
    ),
    bars(
      "Tools used",
      grid(14, 12, 10, 8),
      [{ expr: `topk(10, sum by (tool) (count_over_time(${sel('type="tool_use"')} |= "$task" ${json('task, tool="data.name"')} | task="$task" [$__range])))`, instant: true, format: "table" }],
      "short",
      { color: "orange" },
    ),
    series(
      "Task process: memory and CPU",
      grid(0, 20, 24, 7),
      [
        { expr: `max(max_over_time(${sel('type="system"').replace(BASE, 'service_name="ilmari"')} |= "$task" ${json('t="data.task", v="data.rss"')} | t="$task" | unwrap v | __error__="" [$__interval]))`, legendFormat: "RSS" },
        { expr: `max(max_over_time(${sel('type="system"').replace(BASE, 'service_name="ilmari"')} |= "$task" ${json('t="data.task", v="data.processCpuPct"')} | t="$task" | unwrap v | __error__="" [$__interval]))`, legendFormat: "CPU %" },
      ],
      "bytes",
      {
        lines: true,
        stack: false,
        interval: "1m",
        description: "Samples from the ilmari process that ran this task (the plugin's once-a-minute system event).",
        overrides: [
          byName("CPU %", [
            { id: "unit", value: "percent" },
            { id: "custom.axisPlacement", value: "right" },
            { id: "color", value: { mode: "fixed", fixedColor: "orange" } },
          ]),
          colorOf("RSS", "purple"),
        ],
      },
    ),
    logs("Timeline", grid(0, 27, 12, 18), `${sel('type!~"agent_text|tool_use|system"')} |= "$task" ${pretty('| task="$task"')}`, {
      description: "Lifecycle: steps, verification, review, delivery and failures, newest first.",
    }),
    logs("Agent transcript", grid(12, 27, 12, 18), `${sel('type=~"agent_text|tool_use"')} |= "$task" ${pretty('| task="$task"')}`, {
      description: "What the agent said and which tools it called, newest first.",
    }),
  ],
});

// -------------------------------------------------------------------- host
nextId = 1;
const SYS = '{service_name="ilmari", type="system", host=~"$host"}';
const su = (field, extra = "") => unwrap(SYS, field, extra);
const perProc = (field) => `max by (role, pid) (max_over_time(${su(field, 'role="data.role", pid="data.pid"')} [$__interval]))`;
const running = `count(max by (pid) (count_over_time(${SYS} ${json('role="data.role", pid="data.pid"')} | role="run" [$__interval])))`;
const rightAxis = (name, unit, color) =>
  byName(name, [
    { id: "unit", value: unit },
    { id: "custom.axisPlacement", value: "right" },
    { id: "custom.drawStyle", value: "bars" },
    { id: "custom.fillOpacity", value: 45 },
    { id: "custom.lineWidth", value: 0 },
    { id: "color", value: { mode: "fixed", fixedColor: color } },
  ]);

const hostDash = dashboard({
  uid: "ilmari-host",
  title: "ilmari - Host",
  description: "The machines ilmari runs on: CPU, memory, ilmari's own processes, and how they track task activity.",
  variables: [
    datasourceVar,
    { ...labelVar("host", "Host"), query: { refId: "host", stream: '{service_name="ilmari", type="system"}', type: 1, label: "host" } },
  ],
  links: LINKS.filter((l) => l.title !== "Host"),
  annotateTitles: ["Load vs. running tasks", "Memory vs. agent spend"],
  panels: [
    row("Right now", 0),
    stat("Load per core", grid(0, 1, 3, 4), `max(last_over_time(${su("load1")} [5m])) / max(last_over_time(${su("cpus")} [5m]))`, "percentunit", {
      decimals: 0,
      description: "1-minute load average divided by CPU cores; above 100% work is queueing.",
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 0.7 }, { color: "red", value: 1 }] },
    }),
    stat("Memory used", grid(3, 1, 3, 4), `max(last_over_time(${su("memUsedPct")} [5m]))`, "percent", {
      decimals: 0,
      description: "Host memory in use. On macOS the OS counts file cache as used, so this reads high.",
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 80 }, { color: "red", value: 92 }] },
    }),
    stat("CPU cores", grid(6, 1, 3, 4), `max(last_over_time(${su("cpus")} [5m]))`, "short", { color: "blue" }),
    stat("Total memory", grid(9, 1, 3, 4), `max(last_over_time(${su("memTotal")} [5m]))`, "bytes", { color: "blue", decimals: 0 }),
    stat("ilmari processes", grid(12, 1, 3, 4), `count(max by (pid) (count_over_time(${SYS} ${json('pid="data.pid"')} [3m])))`, "short", {
      color: "purple",
      description: "The serve daemon plus one process per running task.",
    }),
    stat("ilmari memory", grid(15, 1, 3, 4), `sum(max by (pid) (last_over_time(${su("rss", 'pid="data.pid"')} [3m])))`, "bytes", {
      color: "purple",
      decimals: 0,
      description: "Resident memory of all ilmari processes together.",
    }),
    stat("Event loop lag", grid(18, 1, 3, 4), `max(max_over_time(${su("eventLoopLagMs")} [5m]))`, "ms", {
      decimals: 1,
      description: "Worst p99 event loop delay of any ilmari process in the last 5 minutes; high values mean a blocked daemon.",
      thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 50 }, { color: "red", value: 200 }] },
    }),
    stat("Host uptime", grid(21, 1, 3, 4), `max(last_over_time(${su("hostUptimeSec")} [5m]))`, "s", { color: "#1f7a8c", decimals: 0 }),

    row("Host", 5),
    series(
      "CPU load",
      grid(0, 6, 12, 8),
      [
        { expr: `max by (host) (max_over_time(${su("load1")} [$__interval]))`, legendFormat: "{{host}} load (1m)" },
        { expr: `max(max_over_time(${su("cpus")} [$__interval]))`, legendFormat: "cores" },
      ],
      "short",
      {
        lines: true,
        stack: false,
        interval: "2m",
        overrides: [byName("cores", [{ id: "custom.lineStyle", value: { fill: "dash", dash: [10, 10] } }, { id: "custom.fillOpacity", value: 0 }, { id: "color", value: { mode: "fixed", fixedColor: "red" } }])],
      },
    ),
    series("Memory used", grid(12, 6, 12, 8), [{ expr: `max by (host) (max_over_time(${su("memUsedPct")} [$__interval]))`, legendFormat: "{{host}}" }], "percent", {
      lines: true,
      stack: false,
      interval: "2m",
      max: 100,
    }),

    row("ilmari processes", 14),
    series("Memory by role", grid(0, 15, 8, 8), [{ expr: `sum by (role) (${perProc("rss")})`, legendFormat: "{{role}}" }], "bytes", {
      lines: true,
      interval: "2m",
      description: "Resident memory: the serve daemon vs. all task processes together (stacked).",
    }),
    series("CPU by role", grid(8, 15, 8, 8), [{ expr: `sum by (role) (${perProc("processCpuPct")})`, legendFormat: "{{role}}" }], "percent", {
      lines: true,
      interval: "2m",
      description: "Process CPU, 100% = one full core.",
    }),
    series("Event loop lag (p99)", grid(16, 15, 8, 8), [{ expr: `max by (role) (${perProc("eventLoopLagMs")})`, legendFormat: "{{role}}" }], "ms", {
      lines: true,
      stack: false,
      interval: "2m",
    }),

    row("How the host tracks the work", 23),
    series(
      "Load vs. running tasks",
      grid(0, 24, 12, 9),
      [
        { expr: `max(max_over_time(${su("load1")} [$__interval]))`, legendFormat: "load (1m)" },
        { expr: running, legendFormat: "running tasks" },
      ],
      "short",
      {
        lines: true,
        stack: false,
        interval: "5m",
        description: "Host load next to the number of task processes alive; red markers are task failures.",
        overrides: [rightAxis("running tasks", "short", "purple"), colorOf("load (1m)", "orange")],
      },
    ),
    series(
      "Memory vs. agent spend",
      grid(12, 24, 12, 9),
      [
        { expr: `max(max_over_time(${su("memUsedPct")} [$__interval]))`, legendFormat: "memory used" },
        { expr: `sum(sum_over_time(${unwrap('{service_name="ilmari", type="node_finished"}', "costUsd")} [$__interval]))`, legendFormat: "agent spend" },
      ],
      "percent",
      {
        lines: true,
        stack: false,
        interval: "5m",
        overrides: [rightAxis("agent spend", "currencyUSD", "green"), colorOf("memory used", "blue")],
      },
    ),
    panel(
      "table",
      "Heaviest task runs",
      grid(0, 33, 24, 9),
      [
        { expr: `topk(15, max by (task) (max_over_time(${su("rss", 'task="data.task"')} [$__range])))`, instant: true, format: "table" },
        { expr: `max by (task) (max_over_time(${su("processCpuPct", 'task="data.task"')} [$__range]))`, instant: true, format: "table" },
        { expr: `max by (task) (max_over_time(${su("processUptimeSec", 'task="data.task"')} [$__range]))`, instant: true, format: "table" },
      ],
      {
        description: "Peak memory and CPU of the process that ran each task. Click a task to open it.",
        transformations: [
          { id: "merge", options: {} },
          { id: "filterByValue", options: { filters: [{ fieldName: "Value #A", config: { id: "isNotNull" } }], type: "include", match: "all" } },
          {
            id: "organize",
            options: {
              excludeByName: { Time: true },
              indexByName: { task: 0, "Value #A": 1, "Value #B": 2, "Value #C": 3 },
              renameByName: { task: "Task", "Value #A": "Peak memory", "Value #B": "Peak CPU", "Value #C": "Ran for" },
            },
          },
          { id: "sortBy", options: { sort: [{ field: "Peak memory", desc: true }] } },
        ],
        fieldConfig: {
          defaults: { custom: { align: "auto" }, noValue: "-" },
          overrides: [
            byName("Task", [{ id: "links", value: [{ title: "Open in Task explorer", url: TASK_LINK }] }]),
            byName("Peak memory", [
              { id: "unit", value: "bytes" },
              { id: "custom.cellOptions", value: { type: "gauge", mode: "gradient", valueDisplayMode: "text" } },
              { id: "color", value: { mode: "continuous-BlPu" } },
            ]),
            byName("Peak CPU", [{ id: "unit", value: "percent" }, { id: "decimals", value: 0 }]),
            byName("Ran for", [{ id: "unit", value: "s" }]),
          ],
        },
      },
    ),
  ],
});

const out = (name, d) =>
  writeFileSync(new URL(`../grafana/dashboards/${name}.json`, import.meta.url), `${JSON.stringify(d, null, 2)}\n`);
out("ilmari-overview", overview);
out("ilmari-task", taskDash);
out("ilmari-host", hostDash);
console.log("wrote grafana/dashboards/ilmari-{overview,task,host}.json");
