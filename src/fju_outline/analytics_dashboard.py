"""The internal analytics dashboard, as one self-contained HTML document.

Served from ``/api/v1/analytics/dashboard``. It is a plain page rather than a
route in the React app on purpose: an admin view inside the SPA would ship
dashboard code to every student's browser, and it would need the admin token to
live somewhere the app can reach. Here the page is public but carries no data —
it asks for the token, keeps it in ``sessionStorage`` for the tab's lifetime, and
sends it as a header to ``/api/v1/analytics/report``.

No external requests: the CSP-free simplicity of an inline style block and one
inline script is the whole point, and it means the dashboard works on the
deployment host with no CDN and no build step.
"""

from __future__ import annotations

DASHBOARD_HTML = """<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CRS Analytics</title>
<style>
  :root { color-scheme: light dark; --bg:#fbfbfd; --fg:#16181d; --muted:#5c6270;
          --line:#e2e4ea; --card:#fff; --accent:#1f6f4a; --warn:#a5460f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#eceef2; --muted:#a0a6b3; --line:#2a2e36; --card:#1b1e24;
            --accent:#63c398; --warn:#e29a63; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:24px 20px 64px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  h2 { font-size:1.05rem; margin:32px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  p.note { color:var(--muted); margin:0 0 20px; font-size:.875rem; }
  form { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:8px; }
  input, select, button { font:inherit; padding:8px 10px; border:1px solid var(--line);
                          border-radius:8px; background:var(--card); color:inherit; min-height:40px; }
  button { cursor:pointer; background:var(--accent); color:#fff; border-color:transparent; font-weight:600; }
  .tiles { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
  .tile span { display:block; color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
  .tile strong { display:block; font-size:1.5rem; font-variant-numeric:tabular-nums; margin-top:2px; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:520px; background:var(--card);
          border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:7px 12px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; }
  th { font-size:.8rem; color:var(--muted); font-weight:600; }
  tr:last-child td { border-bottom:none; }
  td.n, th.n { text-align:right; }
  .flag { color:var(--warn); font-weight:600; }
  .banner { border:1px solid var(--warn); border-radius:10px; padding:10px 12px; margin:12px 0;
            color:var(--warn); background:color-mix(in srgb, var(--warn) 8%, var(--card)); }
  .muted { color:var(--muted); }
  .cols { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
  #error { color:var(--warn); }
</style>
</head>
<body>
<main>
  <h1>CRS Analytics</h1>
  <p class="note">
    匿名彙總資料。沒有 user id、沒有 IP、沒有搜尋原文；session_id 與 interaction_id 會在保存期限後被清空。
  </p>
  <form id="controls">
    <!-- `new-password`, not `off`: Chrome ignores `autocomplete="off"` on a
         password field and will happily autofill a saved site password here.
         Combined with the auto-submit at the bottom of the script, that produced
         a page that 401'd on every load without anyone typing anything. -->
    <input id="token" type="password" name="crs-analytics-token" placeholder="Admin token"
           autocomplete="new-password" spellcheck="false" size="28">
    <select id="days">
      <option value="7">最近 7 天</option>
      <option value="30" selected>最近 30 天</option>
      <option value="90">最近 90 天</option>
      <option value="180">最近 180 天</option>
    </select>
    <button type="submit">載入</button>
    <span id="error" role="status"></span>
  </form>
  <div id="out"></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const KEY = "crs-analytics-token";
try { $("token").value = sessionStorage.getItem(KEY) || ""; } catch (e) {}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const num = (v) => v === null || v === undefined ? "—" : Number(v).toLocaleString("zh-TW");
const pct = (v) => v === null || v === undefined ? "—" : (Number(v) * 100).toFixed(2) + "%";
const ms  = (v) => v === null || v === undefined ? "—" : Math.round(Number(v)) + " ms";

function tiles(items) {
  return '<div class="tiles">' + items.map(([label, value]) =>
    `<div class="tile"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("") + "</div>";
}

function table(headers, rows) {
  if (!rows.length) return '<p class="note">這段期間沒有資料。</p>';
  const head = headers.map((h, i) => `<th class="${i ? "n" : ""}">${esc(h)}</th>`).join("");
  const body = rows.map((cells) => "<tr>" + cells.map((c, i) =>
    `<td class="${i ? "n" : ""}">${c}</td>`).join("") + "</tr>").join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function ranked(map, headers) {
  const rows = Object.entries(map || {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [esc(k), num(v)]);
  return table(headers, rows);
}

function renderLegacy(data) {
  const o = data.overview, api = data.api, search = data.search || {};
  const timing = search.timing || {};
  const endpoints = Object.keys(api.requests || {}).sort((a, b) => (api.requests[b] || 0) - (api.requests[a] || 0));
  const courses = data.courses.map((c) => {
    const lowCtr = c.impressions >= 20 && c.ctr !== null && c.ctr < 0.05;
    const lowAdd = c.clicks >= 10 && c.click_to_add !== null && c.click_to_add < 0.1;
    const churn  = c.adds >= 10 && c.removes / Math.max(1, c.adds) > 0.3;
    const flags = [lowCtr && "高曝光低 CTR", lowAdd && "高點擊低加入", churn && "高加入高移除"]
      .filter(Boolean).join("、");
    return [esc(c.course_id), num(c.impressions), num(c.clicks), num(c.adds), num(c.removes),
            pct(c.ctr), pct(c.adoption), pct(c.click_to_add),
            flags ? `<span class="flag">${esc(flags)}</span>` : "—"];
  });

  $("out").innerHTML = [
    "<h2>Overview</h2>",
    tiles([
      ["Page views", num(o.page_views)], ["Sessions", num(o.sessions)],
      ["Searches", num(o.searches)], ["Searches / session", o.searches_per_session ?? "—"],
      ["Zero-result rate", pct(o.zero_result_rate)], ["Refinement rate", o.search_refinement_rate ?? "—"],
      ["Rec. impressions", num(o.recommendation_impressions)], ["Rec. CTR", pct(o.recommendation_ctr)],
      ["Rec. adoption", pct(o.recommendation_adoption_rate)], ["Click → add", pct(o.click_to_add_rate)],
      ["API error rate", pct(o.api_error_rate)], ["Error events", num(o.error_events)],
    ]),
    "<h2>API 效能</h2>",
    table(["Endpoint", "Requests", "Errors", "P50", "P95", "P99"], endpoints.map((e) => [
      esc(e), num(api.requests[e]), num(api.errors[e] || 0),
      ms(api.p50[e]), ms(api.p95[e]), ms(api.p99[e]),
    ])),
    "<h2>課程層級</h2>",
    table(["Course", "曝光", "點擊", "加入", "移除", "CTR", "Adoption", "Click→Add", "訊號"], courses),
    '<p class="note">移除數是課程層級的彙總，不是同一位使用者的撤銷率——沒有永久 id 可以把兩者關聯起來。</p>',
    "<h2>推薦位置表現</h2>",
    '<div class="cols">',
    "<div><h3>Impressions by position</h3>" + ranked(data.recommendation.impressions_by_position, ["Position", "次數"]) + "</div>",
    "<div><h3>Clicks by position</h3>" + ranked(data.recommendation.clicks_by_position, ["Position", "次數"]) + "</div>",
    "</div>",
    "<h2>搜尋</h2>",
    '<div class="cols">',
    "<div><h3>Searches by mode</h3>" + ranked(data.search.by_mode, ["Mode", "次數"]) + "</div>",
    "<div><h3>Zero result by mode</h3>" + ranked(data.search.zero_result_by_mode, ["Mode", "次數"]) + "</div>",
    "<div><h3>Result count 分布</h3>" + ranked(search.result_count_buckets, ["Bucket", "次數"]) + "</div>",
    "</div>",
    "<div class=\"cols\">",
    "<div><h3>Semantic latency phases</h3>" + table(["Phase", "P50", "P95", "P99"],
      ["total_ms", "asset_wait_ms", "embedding_ms", "ranking_ms"].map((phase) => [
        esc(phase), ms(timing[phase]?.p50), ms(timing[phase]?.p95), ms(timing[phase]?.p99),
      ])) + "</div>",
    "<div><h3>Asset state</h3>" + ranked(search.asset_state, ["State", "次數"]) +
      "<h3>Query cache</h3>" + ranked(search.query_cache_state, ["State", "次數"]) + "</div>",
    "</div>",
    "<h2>UX</h2>",
    '<div class="cols">',
    "<div><h3>Pages</h3>" + ranked(data.pages, ["Page", "次數"]) + "</div>",
    "<div><h3>Features</h3>" + ranked(data.features, ["Feature", "次數"]) + "</div>",
    "<div><h3>Filters</h3>" + ranked(data.filters, ["Filter", "次數"]) + "</div>",
    "<div><h3>衝堂處理</h3>" + ranked(data.conflicts.actions, ["Action", "次數"]) + "</div>",
    "</div>",
    "<h2>錯誤與相容性</h2>",
    '<div class="cols">',
    "<div><h3>Errors</h3>" + ranked(data.errors, ["component:code", "次數"]) + "</div>",
    "<div><h3>Browsers</h3>" + ranked(data.clients.browsers, ["Browser", "事件數"]) + "</div>",
    "<div><h3>Devices</h3>" + ranked(data.clients.devices, ["Device", "事件數"]) + "</div>",
    "</div>",
    "<h2>保存期限</h2>",
    tiles(Object.entries(data.retention).map(([k, v]) => [k, v])),
  ].join("");
}

function distributionRows(distribution, label) {
  const rows = Object.entries(distribution?.values || {})
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => [esc(label ? `${label}: ${value}` : value), num(count)]);
  if (distribution?.suppressed) {
    rows.push([`<span class="muted">${esc(label ? `${label}: ` : "")}n &lt; ${num(10)}（已隱藏）</span>`,
      num(distribution.suppressed_sample_size)]);
  }
  return rows;
}

function renderResearch(data) {
  const quality = data.data_quality || {};
  const overview = data.overview || {};
  const surfaces = data.surfaces || {};
  const recommendation = data.recommendation || {};
  const search = data.search || {};
  const banners = [];
  if (quality.legacy_data?.present) banners.push(quality.legacy_data.warning);
  if ((quality.unknown_source?.surface_events || 0) > 0) {
    banners.push(`有 ${num(quality.unknown_source.surface_events)} 筆 surface/source 無法判定。`);
  }
  const missing = Object.entries(quality.missing_provenance || {})
    .filter(([, item]) => item.missing > 0)
    .map(([field, item]) => `${field}: ${num(item.missing)}`);
  if (missing.length) banners.push(`缺少 provenance：${missing.join("、")}`);
  if (quality.insufficient_sample_size?.suppressed_dimensions?.length) {
    banners.push(`小樣本切片已隱藏（n < ${num(quality.insufficient_sample_size.minimum_n)}）：` +
      quality.insufficient_sample_size.suppressed_dimensions.join("、"));
  }
  const surfaceRows = Object.entries(surfaces).map(([surface, item]) => [
    esc(surface), num(item.impressions), num(item.clicks), num(item.adds), num(item.removes),
    pct(item.ctr), pct(item.adoption), pct(item.click_to_add),
  ]);
  const courseRows = (data.courses || []).map((course) => [
    esc(course.course_id), esc(course.surface), num(course.impressions), num(course.clicks),
    num(course.adds), num(course.removes), pct(course.ctr), pct(course.adoption), pct(course.click_to_add),
  ]);
  const runRows = (recommendation.by_method || []).map((item) => [
    esc(item.method), num(item.run_count), num(item.zero_result_runs), num(item.skipped_runs),
    num(item.total_impressions), num(item.total_clicks), pct(item.ctr), pct(item.skip_rate), pct(item.zero_result_rate),
  ]);
  if (recommendation.totals) runRows.push([
    "合計", num(recommendation.totals.run_count), num(recommendation.totals.zero_result_runs),
    num(recommendation.totals.skipped_runs), num(recommendation.totals.total_impressions),
    num(recommendation.totals.total_clicks), pct(recommendation.totals.ctr),
    pct(recommendation.totals.skip_rate), pct(recommendation.totals.zero_result_rate),
  ]);
  const funnelRows = (search.by_mode || []).map((item) => [
    esc(item.search_mode), num(item.result_sets), num(item.zero_result_sets), num(item.result_impressions),
    num(item.result_clicks), pct(item.ctr), pct(item.result_set_click_rate),
    pct(item.result_set_add_rate), num(item.adds_after_click),
  ]);
  if (search.totals) funnelRows.push([
    "合計", num(search.totals.result_sets), num(search.totals.zero_result_sets),
    num(search.totals.result_impressions), num(search.totals.result_clicks), pct(search.totals.ctr),
    pct(search.totals.result_set_click_rate), pct(search.totals.result_set_add_rate),
    num(search.totals.adds_after_click),
  ]);
  const decisionRows = Object.entries(data.decision_time?.by_origin || {}).map(([origin, item]) => [
    esc(origin), num(item.sample_size), ms(item.p50_ms), ms(item.p75_ms), ms(item.p90_ms),
  ]);
  const relationRows = Object.entries(data.department_relation || {}).flatMap(([scope, item]) =>
    distributionRows(item, scope));
  const removalRows = [
    ...distributionRows(data.removals?.by_source, "source"),
    ...distributionRows(data.removals?.by_age_bucket, "age_bucket"),
  ];
  const provenanceRows = Object.entries(data.provenance || {}).flatMap(([field, item]) =>
    distributionRows(item, field));
  const bannerHtml = banners.map((message) => `<div class="banner" role="status">${esc(message)}</div>`).join("");
  $("out").innerHTML = [
    bannerHtml,
    `<p class="note">Definition ${esc(data.data_definition_version)}；研究資料起始日：${esc(data.data_start_date || "—")}；只從 Phase 1 durable aggregates 讀取。</p>`,
    "<h2>Research overview</h2>",
    tiles([
      ["Semantic recommendation CTR", pct(overview.semantic_recommendation_ctr)],
      ["Schedule-slot CTR", pct(overview.schedule_slot_ctr)],
      ["Recommendation skip rate", pct(overview.recommendation_run_skip_rate)],
      ["Zero-result run rate", pct(overview.zero_result_run_rate)],
    ]),
    "<h2>Surface-specific course metrics</h2>",
    table(["Surface", "曝光", "點擊", "加入", "移除", "CTR", "Adoption", "Click→Add"], surfaceRows),
    "<h2>Course / surface</h2>",
    table(["Course", "Surface", "曝光", "點擊", "加入", "移除", "CTR", "Adoption", "Click→Add"], courseRows),
    "<h2>Recommendation run funnel</h2>",
    table(["Method", "Runs", "Zero", "Skipped", "曝光", "點擊", "CTR", "Skip rate", "Zero rate"], runRows),
    "<h2>Explore result funnel</h2>",
    table(["Mode", "Result sets", "Zero sets", "Impressions", "Clicks", "CTR", "Set→click", "Set→add", "Adds after click"], funnelRows),
    "<h2>Decision time</h2>",
    table(["Origin", "N", "P50", "P75", "P90"], decisionRows),
    '<p class="note">Percentiles are derived from the cross-day fixed histogram; they are not the maximum of daily percentiles.</p>',
    "<h2>Removal / undo</h2>",
    table(["Slice", "次數"], removalRows),
    "<h2>Department relation</h2>",
    table(["Relation slice", "次數"], relationRows),
    "<h2>Provenance versions</h2>",
    table(["Version field / value", "次數"], provenanceRows),
    `<p class="note">${esc(data.legacy_mixed_metric_warning || "Legacy mixed adds are retained for compatibility only.")}</p>`,
    "<h2>Data governance</h2>",
    tiles([
      ["Definition", data.data_definition_version],
      ["Data start", data.data_start_date || "—"],
      ["Raw event policy", data.backfill?.source || "—"],
      ["Estimated backfill", data.backfill?.estimated_values ? "yes" : "no"],
    ]),
  ].join("");
}

function render(data) {
  if (data.data_definition_version === "phase2-research-v1") renderResearch(data);
  else renderLegacy(data);
}

$("controls").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = $("token").value.trim();
  $("error").textContent = "";
  if (!token) { $("error").textContent = "請先輸入 token。"; return; }
  try {
    const response = await fetch(`/api/v1/analytics/report?days=${encodeURIComponent($("days").value)}`,
                                 { headers: { "X-Analytics-Token": token } });
    if (response.status === 401) {
      // Forget it, so a reload does not silently retry the same wrong value
      // forever. This is what turned one bad paste into a wall of 401s.
      try { sessionStorage.removeItem(KEY); } catch (e) {}
      throw new Error("token 不正確。請確認與伺服器 .env 中的 FJU_ANALYTICS_ADMIN_TOKEN 逐字相同（含大小寫、底線與連字號）。");
    }
    if (response.status === 503) {
      throw new Error("伺服器沒有設定 FJU_ANALYTICS_ADMIN_TOKEN，或統計功能已被關閉。");
    }
    if (!response.ok) {
      const detail = await response.json().then((body) => body.detail).catch(() => "");
      throw new Error(`${response.status} ${detail || ""}`);
    }
    const data = await response.json();
    // Only a token that actually worked is worth remembering.
    try { sessionStorage.setItem(KEY, token); } catch (e) {}
    render(data);
  } catch (error) {
    $("out").innerHTML = "";
    $("error").textContent = "載入失敗：" + error.message;
  }
});
// Safe to auto-run: the field is only pre-filled from a token that already
// returned 200 once in this tab.
if ($("token").value) $("controls").requestSubmit();
</script>
</body>
</html>
"""
