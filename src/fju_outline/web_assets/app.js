const state = {
  page: 1,
  pageSize: 25,
  totalPages: 1,
  facets: null,
};

const els = {
  stats: document.querySelector("#stats"),
  query: document.querySelector("#query"),
  department: document.querySelector("#department"),
  grade: document.querySelector("#grade"),
  classGroup: document.querySelector("#classGroup"),
  division: document.querySelector("#division"),
  req: document.querySelector("#req"),
  done: document.querySelector("#done"),
  sort: document.querySelector("#sort"),
  pageSize: document.querySelector("#pageSize"),
  rows: document.querySelector("#courseRows"),
  resultMeta: document.querySelector("#resultMeta"),
  pageMeta: document.querySelector("#pageMeta"),
  prevPage: document.querySelector("#prevPage"),
  nextPage: document.querySelector("#nextPage"),
  searchBtn: document.querySelector("#searchBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  panel: document.querySelector("#detailPanel"),
  detailTitle: document.querySelector("#detailTitle"),
  detailSubtitle: document.querySelector("#detailSubtitle"),
  detailBody: document.querySelector("#detailBody"),
  closeDetail: document.querySelector("#closeDetail"),
  scrim: document.querySelector("#scrim"),
};

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[ch]);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function setOptions(select, options, allLabel) {
  select.innerHTML = `<option value="">${html(allLabel)}</option>` +
    options.map((item) => `<option value="${html(item.value)}">${html(item.label)}</option>`).join("");
}

async function init() {
  const [summary, facets] = await Promise.all([
    getJson("/api/summary"),
    getJson("/api/facets"),
  ]);
  els.stats.innerHTML = [
    ["課程", summary.courses],
    ["系別", summary.departments],
    ["教師", summary.teachers],
    ["週進度", summary.weekly_progress],
    ["關聯項", summary.relations],
    ["教材", summary.materials],
  ].map(([label, value]) => `<div class="stat"><strong>${value.toLocaleString()}</strong><span>${label}</span></div>`).join("");
  setOptions(els.department, facets.departments, "全部系別");
  setOptions(els.grade, facets.grades, "全部年級");
  state.facets = facets;
  updateClassOptions();
  setOptions(els.division, facets.divisions, "全部部別");
  setOptions(els.req, facets.required_elective, "全部");
  setOptions(els.done, facets.outline_done, "全部");
  await loadCourses();
}

function queryParams() {
  const params = new URLSearchParams({
    q: els.query.value.trim(),
    department: els.department.value,
    grade: els.grade.value,
    class_group: els.classGroup.value,
    division: els.division.value,
    req: els.req.value,
    done: els.done.value,
    sort: els.sort.value,
    page: state.page,
    page_size: state.pageSize,
  });
  return params.toString();
}

async function loadCourses() {
  els.rows.innerHTML = `<tr><td colspan="9">載入中</td></tr>`;
  const data = await getJson(`/api/courses?${queryParams()}`);
  state.totalPages = data.total_pages;
  els.resultMeta.textContent = `${data.total.toLocaleString()} 門課程`;
  els.pageMeta.textContent = `第 ${data.page} / ${data.total_pages} 頁`;
  els.prevPage.disabled = data.page <= 1;
  els.nextPage.disabled = data.page >= data.total_pages;
  els.rows.innerHTML = data.items.map(renderRow).join("") ||
    `<tr><td colspan="9">沒有符合條件的課程</td></tr>`;
}

function renderRow(row) {
  return `
    <tr>
      <td>
        <div class="course-name">${html(row.name_zh)}</div>
        <div class="course-sub">${html(row.name_en)} · ${html(row.ava_no)}</div>
      </td>
      <td>${html(row.teacher)}<div class="course-sub">${html(row.teacher_en)}</div></td>
      <td>${html(row.department)}<div class="course-sub">${html(row.division)}</div></td>
      <td>${html(row.grade || "未分級")}</td>
      <td>${html(row.class_group || "未分班")}</td>
      <td>${html(row.credits)}</td>
      <td><span class="badge">${html(row.required_elective_name)}</span></td>
      <td><span class="badge ${row.is_outline_done ? "done" : "missing"}">${row.is_outline_done ? "已完成" : "未完成"}</span></td>
      <td><button type="button" onclick="openDetail('${html(row.course_id)}')">查看</button></td>
    </tr>
  `;
}

async function openDetail(courseId) {
  const data = await getJson(`/api/courses/${courseId}`);
  const course = data.course;
  els.detailTitle.textContent = course.name_zh || "課程詳情";
  els.detailSubtitle.textContent = `${course.name_en || ""} · ${course.ava_no || ""} · ${course.primary_teacher_name_zh || ""}`;
  els.detailBody.innerHTML = renderDetail(data);
  els.panel.classList.add("open");
  els.scrim.classList.add("open");
  els.panel.setAttribute("aria-hidden", "false");
}

window.openDetail = openDetail;

function renderDetail(data) {
  const course = data.course;
  const sections = data.document.sections || {};
  return `
    <div class="section">
      <h3>課程基本資訊</h3>
      <dl class="kv">
        <dt>系別</dt><dd>${html(course.department_base_zh)}</dd>
        <dt>年級</dt><dd>${html(course.grade_label || "未分級")}</dd>
        <dt>班別</dt><dd>${html(course.class_label || "未分班")}</dd>
        <dt>原始單位</dt><dd>${html(course.organization_department_name_zh)}</dd>
        <dt>部別</dt><dd>${html(course.organization_division_name_zh)}</dd>
        <dt>教師</dt><dd>${html(course.primary_teacher_name_zh)} ${html(course.primary_teacher_name_en)}</dd>
        <dt>學分</dt><dd>${html(course.credits)}</dd>
        <dt>必選修</dt><dd>${html(course.required_elective_name)}</dd>
        <dt>來源</dt><dd><a href="${html(course.source_source_url)}" target="_blank" rel="noreferrer">原課綱頁面</a></dd>
      </dl>
    </div>
    ${textSection("課程學習目標", sections.objective)}
    ${renderMaterials(data.materials)}
    ${textSection("學習規範", sections.learning_norms)}
    ${renderMethods("教學方法", data.teaching_methods)}
    ${renderMethods("學習評量", data.assessments)}
    ${renderWeekly(data.weekly_progress)}
    ${renderRelations(data.relations)}
    ${textSection("全文文件", data.document.full_document_zh)}
  `;
}

function textSection(title, text) {
  if (!text) return "";
  return `<div class="section"><h3>${html(title)}</h3><div class="text-block">${html(text)}</div></div>`;
}

function renderMaterials(rows) {
  if (!rows.length) return "";
  return `<div class="section"><h3>課程教材</h3><table class="mini-table"><tbody>${
    rows.map((row) => `<tr><th>${html(row.kind)}</th><td class="text-block">${html(row.value)}</td></tr>`).join("")
  }</tbody></table></div>`;
}

function renderMethods(title, rows) {
  if (!rows.length) return "";
  return `<div class="section"><h3>${html(title)}</h3><div class="chips">${
    rows.map((row) => `<span class="badge">${html(row.name_zh)} ${html(row.percent)}%</span>`).join("")
  }</div></div>`;
}

function renderWeekly(rows) {
  if (!rows.length) return "";
  return `<div class="section"><h3>授課進度</h3><table class="mini-table">
    <thead><tr><th>週次</th><th>日期</th><th>主題 / 單元</th><th>時數</th></tr></thead>
    <tbody>${rows.map((row) => `
      <tr>
        <td>${html(row.week)}</td>
        <td>${html(row.date)}</td>
        <td class="text-block">${html(row.topic || row.unit)}</td>
        <td>${html(row.physical_hours)}</td>
      </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderRelations(groups) {
  const labels = {
    literacy: "基本素養",
    core_competencies: "核心能力",
    special_issues: "課程與專門議題之關聯性",
    sdgs: "永續發展目標",
    innovation_features: "創新教學特色",
  };
  return Object.entries(labels).map(([key, label]) => {
    const rows = (groups[key] || []).filter((row) => Number(row.relation || 0) > 0);
    if (!rows.length) return "";
    return `<div class="section"><h3>${html(label)}</h3><table class="mini-table">
      <thead><tr><th>項目</th><th>關聯</th><th>備註</th></tr></thead>
      <tbody>${rows.map((row) => `
        <tr>
          <td>${html(row.name)}</td>
          <td>${html(row.relation_label)}</td>
          <td class="text-block">${html(row.note)}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
  }).join("");
}

function closeDetail() {
  els.panel.classList.remove("open");
  els.scrim.classList.remove("open");
  els.panel.setAttribute("aria-hidden", "true");
}

function updateClassOptions() {
  if (!state.facets) return;
  const department = els.department.value;
  const grade = els.grade.value;
  const rows = state.facets.class_availability.filter((item) => {
    if (department && item.department !== department) return false;
    if (grade && item.grade !== grade) return false;
    return true;
  });
  const sortByClass = new Map(state.facets.classes.map((item, index) => [item.value, index]));
  const options = [...new Set(rows.map((item) => item.class_group))]
    .sort((left, right) => (sortByClass.get(left) ?? 999) - (sortByClass.get(right) ?? 999))
    .map((value) => ({ value, label: value }));

  if (!options.length) {
    els.classGroup.value = "";
    els.classGroup.disabled = true;
    setOptions(els.classGroup, [], "無班別可選");
    return;
  }
  const previous = els.classGroup.value;
  setOptions(els.classGroup, options, "全部班別");
  els.classGroup.disabled = false;
  if (options.some((item) => item.value === previous)) {
    els.classGroup.value = previous;
  }
}

els.searchBtn.addEventListener("click", () => { state.page = 1; loadCourses(); });
els.resetBtn.addEventListener("click", () => {
  [els.query, els.department, els.grade, els.classGroup, els.division, els.req, els.done].forEach((el) => { el.value = ""; });
  updateClassOptions();
  state.page = 1;
  loadCourses();
});
els.query.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    state.page = 1;
    loadCourses();
  }
});
els.sort.addEventListener("change", () => { state.page = 1; loadCourses(); });
els.department.addEventListener("change", () => {
  updateClassOptions();
});
els.grade.addEventListener("change", () => {
  updateClassOptions();
});
els.pageSize.addEventListener("change", () => {
  state.pageSize = Number(els.pageSize.value);
  state.page = 1;
  loadCourses();
});
els.prevPage.addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    loadCourses();
  }
});
els.nextPage.addEventListener("click", () => {
  if (state.page < state.totalPages) {
    state.page += 1;
    loadCourses();
  }
});
els.closeDetail.addEventListener("click", closeDetail);
els.scrim.addEventListener("click", closeDetail);

init().catch((error) => {
  els.rows.innerHTML = `<tr><td colspan="9">載入失敗：${html(error.message)}</td></tr>`;
});
