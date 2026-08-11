const GRADES = ["七年级", "八年级", "九年级", "高一", "高二", "高三"];
const COURSE_TYPES = {
  oneToOne: "一对一",
  oneToTwo: "一对二",
  oneToThree: "一对三",
  oneToFour: "一对四",
  classCourse: "班课(5人+)"
};
const TYPE_GROUPS = [
  ["oneToOne", "一对一"],
  ["oneToTwo", "一对二"],
  ["oneToThree", "一对三"],
  ["oneToFour", "一对四"],
  ["classCourse", "班课(5人+)"]
];
const STATUS_LABELS = {
  present: "到课",
  leave: "请假",
  absent: "缺席"
};
const STATUS_ORDER = ["present", "leave", "absent"];
const DEFAULT_STANDARDS = {
  "七年级": { oneToOne: 120, oneToTwo: 140, oneToThree: 150, oneToFour: 160, classBase: 140 },
  "八年级": { oneToOne: 130, oneToTwo: 150, oneToThree: 160, oneToFour: 170, classBase: 150 },
  "九年级": { oneToOne: 140, oneToTwo: 160, oneToThree: 170, oneToFour: 180, classBase: 160 },
  "高一": { oneToOne: 160, oneToTwo: 200, oneToThree: 210, oneToFour: 220, classBase: 200 },
  "高二": { oneToOne: 180, oneToTwo: 220, oneToThree: 230, oneToFour: 240, classBase: 220 },
  "高三": { oneToOne: 200, oneToTwo: 240, oneToThree: 250, oneToFour: 260, classBase: 240 }
};
const STORE_KEY = "teacher-payroll-v1";
const MIGRATION_KEY = "teacher-payroll-cloud-migrated-v1";
const LOCAL_ONLY = false;
const CLOUD_STATE_TABLE = "app_states";

let activeTemplate = null;
let lessonAttendance = [];
let editingClassStudents = [];
let supabaseClient = null;
let currentUser = null;
let isCloudReady = false;
let isBootstrapping = true;
let syncTimer = null;

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => today().slice(0, 7);
const money = (value) => `¥${Number(value || 0).toLocaleString("zh-CN")}`;
const numberOrNull = (value) => value === "" || value === null || Number.isNaN(Number(value)) ? null : Number(value);
const normalizeCourseType = (type) => type === "smallClass" || type === "multi" ? "classCourse" : type;
const normalizeTag = (value) => String(value || "").trim();
const h = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;"
}[char]));

let state = loadState();

function loadState() {
  const fallback = {
    students: [],
    classes: [],
    courseTemplates: [],
    records: [],
    settlements: [],
    mainIncomes: [],
    settings: {
      standards: clone(DEFAULT_STANDARDS),
      defaultSmallExtra: 10
    }
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    const merged = {
      ...fallback,
      ...saved,
      courseTemplates: saved?.courseTemplates || [],
      settings: {
        ...fallback.settings,
        ...(saved?.settings || {}),
        standards: { ...fallback.settings.standards, ...(saved?.settings?.standards || {}) }
      }
    };
    return migrateState(merged);
  } catch {
    return fallback;
  }
}

function migrateState(data) {
  data.settings = {
    standards: normalizeStandards(data.settings?.standards),
    defaultSmallExtra: data.settings?.defaultSmallExtra ?? 10
  };
  const students = (data.students || []).map((student) => ({
    id: student.id || uid(),
    name: student.name || "",
    grade: student.grade || GRADES[0],
    institutionTag: normalizeTag(student.institutionTag || student.tag || student.sourceTag),
    specialOne: student.specialOne ?? null,
    note: student.note || ""
  }));
  const oldStudents = data.students || [];
  const classes = (data.classes || []).map((classItem) => {
    const existingMembers = Array.isArray(classItem.students) ? classItem.students : [];
    const migratedMembers = existingMembers.length ? existingMembers : oldStudents
      .filter((student) => student.classId === classItem.id || (classItem.memberIds || []).includes(student.id))
      .map((student) => ({ id: student.id || uid(), name: student.name || "", status: "active", note: "" }));
    return {
      id: classItem.id || uid(),
      name: classItem.name || "",
      grade: classItem.grade || GRADES[0],
      institutionTag: normalizeTag(classItem.institutionTag || classItem.tag || classItem.sourceTag),
      students: migratedMembers.map((member) => ({
        id: member.id || uid(),
        name: member.name || "",
        status: member.status || "active",
        note: member.note || ""
      })),
      smallBasePrice: classItem.smallBasePrice ?? null,
      extraPerStudent: classItem.extraPerStudent ?? 10,
      settlementMode: classItem.settlementMode || "wage",
      settlementPerStudent: classItem.settlementPerStudent ?? classItem.perStudentSettlementPrice ?? null,
      note: classItem.note || ""
    };
  });
  const courseTemplates = (data.courseTemplates || []).map((template) => {
    const courseType = normalizeCourseType(template.courseType);
    return {
      ...template,
      courseType,
      sourceType: courseType === "classCourse" ? "class" : "personal",
      fixedMode: template.fixedMode || "auto",
      fixedPrice: template.fixedPrice ?? null
    };
  });
  const records = (data.records || []).map((record) => ({
    ...record,
    courseType: normalizeCourseType(record.courseType),
    institutionTag: normalizeTag(record.institutionTag || record.tag || record.sourceTag),
    settlementAmount: record.settlementAmount ?? null,
    settlementSource: record.settlementSource || "",
    settlementId: record.settlementId || "",
    studentSettlementIds: record.studentSettlementIds || {}
  }));
  const settlements = (data.settlements || []).map((settlement) => ({
    id: settlement.id || uid(),
    title: settlement.title || "",
    mode: settlement.mode || "institution",
    targetId: settlement.targetId || "",
    targetName: settlement.targetName || "",
    month: settlement.month || currentMonth(),
    settledAt: settlement.settledAt || today(),
    amount: Number(settlement.amount || 0),
    recordIds: settlement.recordIds || [],
    note: settlement.note || "",
    createdAt: settlement.createdAt || new Date().toISOString()
  }));
  const mainIncomes = (data.mainIncomes || data.salaryEntries || []).map((income) => ({
    id: income.id || uid(),
    month: income.month || currentMonth(),
    baseSalary: Number(income.baseSalary || 0),
    performance: Number(income.performance || 0),
    allowance: Number(income.allowance || 0),
    deduction: Number(income.deduction || 0),
    amount: Number(income.amount ?? income.actualAmount ?? 0),
    note: income.note || "",
    createdAt: income.createdAt || new Date().toISOString()
  }));
  return { ...data, students, classes, courseTemplates, records, settlements, mainIncomes };
}

function normalizeStandards(standards = {}) {
  return GRADES.reduce((result, grade) => {
    const defaults = DEFAULT_STANDARDS[grade];
    const saved = standards[grade] || {};
    result[grade] = {
      ...defaults,
      ...saved,
      oneToThree: saved.oneToThree ?? defaults.oneToThree ?? saved.oneToTwo ?? defaults.oneToTwo,
      oneToFour: saved.oneToFour ?? defaults.oneToFour ?? saved.oneToThree ?? defaults.oneToThree ?? saved.oneToTwo ?? defaults.oneToTwo,
      classBase: saved.classBase ?? defaults.classBase ?? saved.oneToTwo ?? defaults.oneToTwo
    };
    return result;
  }, {});
}

function saveState() {
  renderAll();
  if (isBootstrapping) return;
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  if (!LOCAL_ONLY && currentUser && isCloudReady) {
    scheduleCloudSync();
  } else {
    setSyncStatus("已保存到本地");
  }
}

function scheduleCloudSync() {
  setSyncStatus("保存中");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncCloudState(), 500);
}

function init() {
  ["studentGrade", "studentGradeFilter", "classGrade", "templateGrade", "simpleGrade"].forEach((id) => fillGradeSelect($(id), id === "studentGradeFilter"));
  $("lessonDate").value = today();
  $("filterDate").value = "";
  $("filterMonth").value = currentMonth();
  $("todayLine").textContent = `${today()}，上完课，点模板，记工资。`;

  document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $("lessonForm").addEventListener("submit", saveLesson);
  $("resetLessonBtn").addEventListener("click", resetLessonForm);
  $("savedLessonTarget").addEventListener("input", applySavedLessonTarget);
  $("toggleLessonExtraBtn").addEventListener("click", toggleLessonExtra);
  $("saveTempLessonBtn").addEventListener("click", saveTempLesson);
  $("manualAmount").addEventListener("input", updateLessonCalculation);
  ["simpleCourseType", "simpleGrade", "simpleClass", "simpleSettlementMode", "simplePerStudentPrice"].forEach((id) => $(id).addEventListener("input", () => {
    renderSimpleLessonPickers();
    updateLessonCalculation();
  }));
  $("simpleStudentNames").addEventListener("input", () => {
    buildSimpleAttendance();
    renderLessonPickers();
    updateLessonCalculation();
  });
  $("simpleStudentTag").addEventListener("input", updateLessonCalculation);
  $("trialStudentsInput").addEventListener("input", syncTrialStudents);
  $("allPresentBtn").addEventListener("click", () => {
    lessonAttendance = lessonAttendance.map((item) => ({ ...item, status: "present" }));
    renderLessonPickers();
    updateLessonCalculation();
  });
  document.querySelectorAll(".quick-notes button").forEach((button) => {
    button.addEventListener("click", () => appendNote(button.dataset.note));
  });

  $("templateForm").addEventListener("submit", saveTemplate);
  $("resetTemplateBtn").addEventListener("click", resetTemplateForm);
  $("templateName").addEventListener("input", updateTemplateNameManualState);
  $("templateClass").addEventListener("input", () => syncTemplateNameWithSelection());
  ["templateType", "templateGrade", "templateBillingMode"].forEach((id) => $(id).addEventListener("input", renderTemplateFormPickers));

  $("studentForm").addEventListener("submit", saveStudent);
  $("resetStudentBtn").addEventListener("click", resetStudentForm);
  $("studentSearch").addEventListener("input", renderStudents);
  $("studentGradeFilter").addEventListener("input", renderStudents);

  $("classForm").addEventListener("submit", saveClass);
  $("resetClassBtn").addEventListener("click", resetClassForm);
  $("addClassStudentsBtn").addEventListener("click", addBulkClassStudents);

  $("filterDate").addEventListener("input", renderStats);
  $("filterMonth").addEventListener("input", () => {
    $("filterDate").value = "";
    renderStats();
  });
  $("filterTag").addEventListener("input", renderStats);
  $("filterCourseType").addEventListener("input", renderStats);
  $("exportCsvBtn").addEventListener("click", exportCurrentMonthCsv);
  $("exportJsonBtn").addEventListener("click", exportJsonBackup);
  $("importJsonBtn").addEventListener("click", () => $("importJsonFile").click());
  $("importJsonFile").addEventListener("change", importJsonBackup);

  $("saveStandardsBtn").addEventListener("click", saveStandards);
  $("resetStandardsBtn").addEventListener("click", resetStandards);
  $("settlementForm").addEventListener("submit", saveSettlement);
  $("settlementMode").addEventListener("input", () => {
    renderSettlementTargets();
    renderSettlementPreview();
  });
  $("settlementTarget").addEventListener("input", renderSettlementPreview);
  $("settlementMonth").addEventListener("input", renderSettlementPreview);
  $("settlementDate").value = today();
  $("settlementMonth").value = currentMonth();
  $("refreshSettlementBtn").addEventListener("click", renderSettlementPreview);
  $("mainIncomeForm").addEventListener("submit", saveMainIncome);
  $("resetMainIncomeBtn").addEventListener("click", resetMainIncomeForm);
  $("mainIncomeMonth").value = currentMonth();
  $("loginBtn").addEventListener("click", loginUser);
  $("registerBtn").addEventListener("click", registerUser);
  $("logoutBtn").addEventListener("click", logoutUser);

  resetClassForm(false);
  if (LOCAL_ONLY) initLocalApp();
  else initSupabase();
}

function fillGradeSelect(select, includeAll = false) {
  select.innerHTML = (includeAll ? [`<option value="">全部年级</option>`] : [])
    .concat(GRADES.map((grade) => `<option value="${grade}">${grade}</option>`))
    .join("");
}

function switchTab(tabId) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.tab === tabId));
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("is-active", page.id === tabId));
}

function initLocalApp() {
  currentUser = null;
  isCloudReady = false;
  showApp();
  $("accountEmail").textContent = "本地保存";
  $("logoutBtn").classList.add("hidden");
  setSyncStatus("已保存到本地");
  renderAll();
  updateLessonCalculation();
  isBootstrapping = false;
}

async function initSupabase() {
  const config = window.SUPABASE_CONFIG || {};
  if (!window.supabase) {
    showAuthOnly("Supabase 登录库没有加载成功，请确认网络可以访问 jsdelivr CDN。");
    setSyncStatus("未连接");
    isBootstrapping = false;
    return;
  }
  isCloudReady = Boolean(config.url && config.anonKey && !config.url.includes("YOUR_SUPABASE") && !config.anonKey.includes("YOUR_SUPABASE"));
  if (!isCloudReady) {
    showAuthOnly("请先在 supabase-config.js 填写 Supabase URL 和 anon public key。");
    setSyncStatus("未配置");
    isBootstrapping = false;
    return;
  }
  supabaseClient = window.supabase.createClient(config.url, config.anonKey);
  const { data } = await supabaseClient.auth.getSession();
  currentUser = data.session?.user || null;
  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    if (currentUser) await enterApp();
    else showAuthOnly();
  });
  if (currentUser) await enterApp();
  else showAuthOnly();
  isBootstrapping = false;
}

function showAuthOnly(message = "") {
  $("authPage").classList.remove("hidden");
  document.querySelector(".app-shell").classList.add("hidden");
  $("authMessage").textContent = message;
  $("accountEmail").textContent = "未登录";
}

function showApp() {
  $("authPage").classList.add("hidden");
  document.querySelector(".app-shell").classList.remove("hidden");
  $("accountEmail").textContent = currentUser?.email || "";
  $("logoutBtn").classList.toggle("hidden", !currentUser);
}

async function enterApp() {
  showApp();
  setSyncStatus("加载中");
  try {
    state = await loadCloudState();
    await maybeMigrateLocalData();
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    renderAll();
    updateLessonCalculation();
    setSyncStatus("已同步");
  } catch (error) {
    setSyncStatus("同步失败");
    $("authMessage").textContent = error.message || "云端数据加载失败。";
  }
}

async function loginUser() {
  if (!supabaseClient) return $("authMessage").textContent = "请先配置 Supabase。";
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (!email || !password) return $("authMessage").textContent = "请填写邮箱和密码。";
  $("authMessage").textContent = "登录中...";
  try {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    $("authMessage").textContent = error ? authErrorText(error) : "";
  } catch (error) {
    $("authMessage").textContent = authErrorText(error);
  }
}

async function registerUser() {
  if (!supabaseClient) return $("authMessage").textContent = "请先配置 Supabase。";
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (!email || !password) return $("authMessage").textContent = "请填写邮箱和密码。";
  $("authMessage").textContent = "注册中...";
  try {
    const { error } = await supabaseClient.auth.signUp({ email, password });
    $("authMessage").textContent = error ? authErrorText(error) : "注册成功。如果 Supabase 开启了邮箱验证，请先去邮箱确认。";
  } catch (error) {
    $("authMessage").textContent = authErrorText(error);
  }
}

function authErrorText(error) {
  const message = String(error?.message || error || "");
  if (/load failed|failed to fetch|networkerror|fetch/i.test(message)) {
    return "云端服务连接失败。请检查网络，或确认 Supabase 项目没有暂停、删除，项目地址和 anon key 仍然有效。";
  }
  if (/invalid login credentials/i.test(message)) {
    return "邮箱或密码不正确。";
  }
  return message || "登录失败，请稍后再试。";
}

async function logoutUser() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  state = loadState();
  activeTemplate = null;
  lessonAttendance = [];
  showAuthOnly();
}

function setSyncStatus(text) {
  $("syncStatus").textContent = text;
}

async function maybeMigrateLocalData() {
  if (localStorage.getItem(MIGRATION_KEY)) return;
  const localRaw = localStorage.getItem(STORE_KEY);
  if (!localRaw) return;
  let localState;
  try {
    localState = migrateState(JSON.parse(localRaw));
  } catch {
    localStorage.setItem(MIGRATION_KEY, "invalid-local-data");
    return;
  }
  const hasLocalData = localState.students.length || localState.classes.length || localState.courseTemplates.length || localState.records.length;
  const hasCloudData = state.students.length || state.classes.length || state.courseTemplates.length || state.records.length;
  if (!hasLocalData || hasCloudData) {
    localStorage.setItem(MIGRATION_KEY, "ignored-or-not-needed");
    return;
  }
  if (confirm("检测到本地旧数据，是否迁移到云端？")) {
    state = localState;
    await syncCloudState();
    localStorage.setItem(MIGRATION_KEY, "migrated");
    alert("本地旧数据已迁移到云端。");
  } else {
    localStorage.setItem(MIGRATION_KEY, "ignored");
  }
}

function renderAll() {
  renderSavedLessonTargets();
  renderLessonTemplates();
  renderSimpleLessonPickers();
  renderLessonPickers();
  renderTemplateFormPickers();
  renderTemplateList();
  renderStudents();
  renderClasses();
  renderClassStudentList();
  renderTagFilter();
  renderStats();
  renderDashboard();
  renderSettlementPage();
  renderMainIncomePage();
  renderSettings();
  updateHeaderTotal();
}

async function loadCloudState() {
  const { data, error } = await supabaseClient
    .from(CLOUD_STATE_TABLE)
    .select("state")
    .eq("user_id", currentUser.id)
    .maybeSingle();
  if (error) throw error;
  return migrateState(data?.state || {});
}

async function syncCloudState() {
  if (!currentUser || !isCloudReady) return;
  setSyncStatus("保存中");
  try {
    const userId = currentUser.id;
    const now = new Date().toISOString();
    await ensureProfile(userId);
    const { error } = await supabaseClient.from(CLOUD_STATE_TABLE).upsert({
      user_id: userId,
      state,
      updated_at: now
    }, { onConflict: "user_id" });
    if (error) throw error;
    setSyncStatus("已同步");
  } catch (error) {
    console.error(error);
    setSyncStatus("同步失败");
  }
}

async function ensureProfile(userId) {
  await supabaseClient.from("profiles").upsert({
    user_id: userId,
    email: currentUser.email,
    updated_at: new Date().toISOString()
  }, { onConflict: "user_id" });
}

async function deleteUserRows() {
  const userId = currentUser.id;
  await Promise.all([
    supabaseClient.from("one_on_one_students").delete().eq("user_id", userId),
    supabaseClient.from("classes").delete().eq("user_id", userId),
    supabaseClient.from("course_templates").delete().eq("user_id", userId),
    supabaseClient.from("lesson_records").delete().eq("user_id", userId),
    supabaseClient.from("salary_settings").delete().eq("user_id", userId)
  ]);
}

async function insertRows(table, rows) {
  if (!rows.length) return;
  const { error } = await supabaseClient.from(table).insert(rows);
  if (error) throw error;
}

function toStudentRow(student, userId, now) {
  return {
    id: student.id,
    user_id: userId,
    name: student.name,
    grade: student.grade,
    institution_tag: student.institutionTag || "",
    special_one: student.specialOne,
    note: student.note || "",
    created_at: now,
    updated_at: now
  };
}

function fromStudentRow(row) {
  return {
    id: row.id,
    name: row.name,
    grade: row.grade,
    institutionTag: row.institution_tag || "",
    specialOne: row.special_one ?? null,
    note: row.note || ""
  };
}

function toClassRow(classItem, userId, now) {
  return {
    id: classItem.id,
    user_id: userId,
    name: classItem.name,
    grade: classItem.grade,
    institution_tag: classItem.institutionTag || "",
    students: classItem.students || [],
    fixed_price: classItem.smallBasePrice,
    extra_per_student: classItem.extraPerStudent ?? 10,
    note: classItem.note || "",
    created_at: now,
    updated_at: now
  };
}

function fromClassRow(row) {
  return {
    id: row.id,
    name: row.name,
    grade: row.grade,
    institutionTag: row.institution_tag || "",
    students: row.students || [],
    smallBasePrice: row.fixed_price ?? null,
    extraPerStudent: row.extra_per_student ?? 10,
    note: row.note || ""
  };
}

function toTemplateRow(template, userId, now) {
  return {
    id: template.id,
    user_id: userId,
    name: template.name,
    course_type: template.courseType,
    grade: template.grade,
    student_ids: template.studentIds || [],
    class_id: template.classId || null,
    class_name: template.className || "",
    fixed_mode: template.fixedMode || "auto",
    fixed_price: template.fixedPrice,
    enabled: template.enabled !== false,
    sort_order: template.sortOrder ?? 100,
    note: template.note || "",
    last_used_at: template.lastUsedAt || null,
    created_at: now,
    updated_at: now
  };
}

function fromTemplateRow(row) {
  return {
    id: row.id,
    name: row.name,
    courseType: row.course_type,
    grade: row.grade,
    studentIds: row.student_ids || [],
    classId: row.class_id || "",
    className: row.class_name || "",
    fixedMode: row.fixed_mode || "auto",
    fixedPrice: row.fixed_price ?? null,
    enabled: row.enabled !== false,
    sortOrder: row.sort_order ?? 100,
    note: row.note || "",
    lastUsedAt: row.last_used_at || ""
  };
}

function toRecordRow(record, userId, now) {
  return {
    id: record.id,
    user_id: userId,
    date: record.date,
    template_id: record.templateId || null,
    course_name: record.courseName || "",
    course_type: record.courseType,
    grade: record.grade,
    institution_tag: record.institutionTag || "",
    student_name: record.studentName || "",
    class_id: record.classId || null,
    class_name: record.className || "",
    attendance: record.attendance || [],
    attendance_count: record.attendanceCount || 0,
    leave_count: record.leaveCount || 0,
    absent_count: record.absentCount || 0,
    amount: record.amount || 0,
    price_source: record.priceSource || "",
    manual_amount: record.manualAmount,
    note: record.note || "",
    confirmed: Boolean(record.confirmed),
    student_settlement_ids: record.studentSettlementIds || {},
    created_at: now,
    updated_at: now
  };
}

function fromRecordRow(row) {
  return {
    id: row.id,
    date: row.date,
    templateId: row.template_id || "",
    courseName: row.course_name || "",
    courseType: row.course_type,
    grade: row.grade,
    institutionTag: row.institution_tag || "",
    studentName: row.student_name || "",
    classId: row.class_id || "",
    className: row.class_name || "",
    attendance: row.attendance || [],
    attendanceCount: row.attendance_count || 0,
    leaveCount: row.leave_count || 0,
    absentCount: row.absent_count || 0,
    amount: row.amount || 0,
    priceSource: row.price_source || "",
    manualAmount: row.manual_amount ?? null,
    note: row.note || "",
    confirmed: Boolean(row.confirmed),
    studentSettlementIds: row.student_settlement_ids || {}
  };
}

function appendNote(text) {
  const current = $("lessonNote").value.trim();
  $("lessonNote").value = current ? `${current}；${text}` : text;
}

function sortedTemplates(includeDisabled = false) {
  return state.courseTemplates
    .filter((template) => includeDisabled || template.enabled !== false)
    .sort((a, b) => ((b.lastUsedAt || "").localeCompare(a.lastUsedAt || "")) || a.name.localeCompare(b.name, "zh-CN"));
}

function renderLessonTemplates() {
  const templates = sortedTemplates(false);
  if (!templates.length) {
    $("lessonTemplates").innerHTML = `<div class="empty">还没有启用的课程模板，请先到“课程模板”页新增。</div>`;
    return;
  }
  $("lessonTemplates").innerHTML = TYPE_GROUPS.map(([type, label]) => {
    const group = templates.filter((template) => template.courseType === type);
    if (!group.length) return "";
    return `
      <div class="template-group">
        <h3>${label}</h3>
        <div class="template-grid">
          ${group.map((template) => lessonTemplateCard(template)).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function lessonTemplateCard(template) {
  const classItem = getClass(template.classId);
  const students = (template.studentIds || []).map((id) => getStudent(id)).filter(Boolean);
  const className = classItem?.name || template.className || "";
  const studentNames = students.map((student) => student.name).join("、") || (template.studentIds || []).map(() => "已删除学生").join("、");
  const tag = template.courseType === "classCourse" ? classItem?.institutionTag : students[0]?.institutionTag;
  const subtitle = template.courseType === "classCourse" ? className : studentNames;
  return `
    <button type="button" class="template-card ${activeTemplate?.id === template.id ? "is-selected" : ""}" onclick="selectLessonTemplate('${template.id}')">
      <strong>${h(template.name)}</strong>
      <span>${h(COURSE_TYPES[template.courseType])}｜${h(template.grade)}</span>
      <small>${h([subtitle || "未关联", tag].filter(Boolean).join("｜"))}</small>
    </button>
  `;
}

function selectLessonTemplate(id) {
  const template = state.courseTemplates.find((item) => item.id === id);
  if (!template) return;
  activeTemplate = template;
  $("selectedTemplateId").value = id;
  $("trialStudentsInput").value = "";
  lessonAttendance = buildAttendanceFromTemplate(template);
  renderLessonTemplates();
  renderLessonPickers();
  updateLessonCalculation();
}

function buildAttendanceFromTemplate(template) {
  if (template.courseType === "classCourse") {
    const classItem = getClass(template.classId);
    return (classItem?.students || [])
      .filter((student) => student.status !== "inactive")
      .map((student) => ({ studentId: student.id, name: student.name, status: "present" }));
  }
  return (template.studentIds || [])
    .map((id) => getStudent(id))
    .filter(Boolean)
    .map((student) => ({ studentId: student.id, name: student.name, status: "present" }));
}

function renderLessonPickers() {
  const hasTemplate = !!activeTemplate;
  const simpleType = $("simpleCourseType")?.value || "";
  const isSimpleClass = !hasTemplate && simpleType === "classCourse";
  const showAttendance = hasTemplate || lessonAttendance.length || isSimpleClass;
  $("selectedLessonSummary").classList.toggle("hidden", !hasTemplate);
  $("attendancePanel").classList.toggle("hidden", !showAttendance);
  if (!hasTemplate) $("selectedLessonSummary").innerHTML = "";
  const classItem = hasTemplate && activeTemplate.courseType === "classCourse" ? getClass(activeTemplate.classId) : null;
  const student = hasTemplate && activeTemplate.courseType === "oneToOne" ? getStudent((activeTemplate.studentIds || [])[0]) : null;
  const className = classItem?.name || activeTemplate?.className || "";
  const tag = classItem?.institutionTag || student?.institutionTag || "";
  if (hasTemplate) {
    $("selectedLessonSummary").innerHTML = `
      <strong>${h(activeTemplate.name)}</strong>
      <span>${h(COURSE_TYPES[activeTemplate.courseType])}｜${h(activeTemplate.grade)}${className ? `｜${h(className)}` : ""}${tag ? `｜${h(tag)}` : ""}</span>
    `;
  }
  const courseType = hasTemplate ? activeTemplate.courseType : simpleType;
  $("allPresentBtn").classList.toggle("hidden", courseType !== "classCourse");
  $("trialStudentsWrap").classList.toggle("hidden", courseType !== "classCourse");
  $("attendanceList").innerHTML = lessonAttendance.length ? lessonAttendance.map((item) => {
    if (courseType === "classCourse") {
      return `
        <button type="button" class="attendance-card ${item.status} ${item.isTrial ? "trial" : ""}" onclick="cycleAttendance('${item.studentId}')">
          <strong>${h(item.name)}</strong>
          <span>${item.isTrial ? `试听｜${STATUS_LABELS[item.status]}` : STATUS_LABELS[item.status]}</span>
        </button>
      `;
    }
    return `
      <div class="attendance-card present static">
        <strong>${h(item.name)}</strong>
        <span>到课</span>
      </div>
    `;
  }).join("") : `<div class="empty">这个模板还没有可点名的学生。</div>`;
  renderAttendanceSummary();
}

function renderAttendanceSummary() {
  const counts = attendanceCounts(lessonAttendance);
  $("attendanceSummary").textContent = `总人数：${lessonAttendance.length}　到课：${counts.present}　请假：${counts.leave}　缺席：${counts.absent}`;
}

function cycleAttendance(studentId) {
  const isClass = activeTemplate ? activeTemplate.courseType === "classCourse" : $("simpleCourseType").value === "classCourse";
  if (!isClass) return;
  lessonAttendance = lessonAttendance.map((item) => {
    if (item.studentId !== studentId) return item;
    const next = STATUS_ORDER[(STATUS_ORDER.indexOf(item.status) + 1) % STATUS_ORDER.length];
    return { ...item, status: next };
  });
  renderLessonPickers();
  updateLessonCalculation();
}

function syncTrialStudents() {
  const isClass = activeTemplate ? activeTemplate.courseType === "classCourse" : $("simpleCourseType").value === "classCourse";
  if (!isClass) return;
  const existing = lessonAttendance.filter((item) => !item.isTrial);
  const trials = parseTrialStudentNames($("trialStudentsInput").value).map((name, index) => ({
    studentId: `trial-${index}`,
    name,
    status: "present",
    isTrial: true
  }));
  lessonAttendance = [...existing, ...trials];
  renderLessonPickers();
  updateLessonCalculation();
}

function parseTrialStudentNames(value) {
  return [...new Set(String(value || "")
    .split(/[\n,，、;；\s]+/)
    .map((name) => name.trim())
    .filter(Boolean))];
}

function renderSavedLessonTargets() {
  const current = $("savedLessonTarget").value;
  const studentOptions = state.students.map((student) => ({
    value: `student:${student.id}`,
    label: `${student.name}${student.institutionTag ? `｜${student.institutionTag}` : ""}`
  }));
  const classOptions = state.classes.map((classItem) => ({
    value: `class:${classItem.id}`,
    label: `${classItem.name}${classItem.institutionTag ? `｜${classItem.institutionTag}` : ""}`
  }));
  $("savedLessonTarget").innerHTML = [
    `<option value="">选择已保存学生或班级</option>`,
    classOptions.length ? `<optgroup label="班级">${classOptions.map((item) => `<option value="${h(item.value)}">${h(item.label)}</option>`).join("")}</optgroup>` : "",
    studentOptions.length ? `<optgroup label="学生">${studentOptions.map((item) => `<option value="${h(item.value)}">${h(item.label)}</option>`).join("")}</optgroup>` : ""
  ].join("");
  if ([...studentOptions, ...classOptions].some((item) => item.value === current)) $("savedLessonTarget").value = current;
}

function applySavedLessonTarget() {
  const value = $("savedLessonTarget").value;
  if (!value) {
    $("simpleStudentNames").value = "";
    $("simpleStudentTag").value = "";
    buildSimpleAttendance();
    renderLessonPickers();
    updateLessonCalculation();
    return;
  }
  const [kind, id] = value.split(":");
  if (kind === "class") {
    const classItem = getClass(id);
    if (!classItem) return;
    $("simpleCourseType").value = "classCourse";
    $("simpleGrade").value = classItem.grade;
    $("simpleStudentNames").value = "";
    $("simpleStudentTag").value = classItem.institutionTag || "";
    renderSimpleLessonPickers();
    $("simpleClass").value = classItem.id;
  } else {
    const student = getStudent(id);
    if (!student) return;
    $("simpleCourseType").value = "oneToOne";
    $("simpleGrade").value = student.grade;
    $("simpleStudentNames").value = student.name;
    $("simpleStudentTag").value = student.institutionTag || "";
  }
  renderSimpleLessonPickers();
  updateLessonCalculation();
}

function toggleLessonExtra() {
  $("lessonExtraPanel").classList.toggle("hidden");
}

function simpleCourseSize(type) {
  return { oneToOne: 1, oneToTwo: 2, oneToThree: 3, oneToFour: 4 }[type] || 0;
}

function renderSimpleLessonPickers() {
  const type = $("simpleCourseType").value;
  const grade = $("simpleGrade").value;
  const isClass = type === "classCourse";
  $("simpleStudentsWrap").classList.toggle("hidden", isClass);
  $("simpleClassWrap").classList.toggle("hidden", !isClass);
  $("trialStudentsWrap").classList.toggle("hidden", !isClass);
  $("allPresentBtn").classList.toggle("hidden", !isClass);

  const selectedClass = $("simpleClass").value;
  const classes = state.classes.filter((item) => item.grade === grade);
  $("simpleClass").innerHTML = `<option value="">${classes.length ? "选择班级" : "当前年级还没有班级"}</option>` + classes
    .map((item) => `<option value="${item.id}">${h(item.name)}${item.institutionTag ? `｜${h(item.institutionTag)}` : ""}</option>`)
    .join("");
  if (classes.some((item) => item.id === selectedClass)) $("simpleClass").value = selectedClass;
  const selectedClassItem = getClass($("simpleClass").value);
  if (isClass && selectedClassItem?.settlementMode === "perHead") {
    $("simpleSettlementMode").value = "perHead";
    $("simplePerStudentPrice").value = selectedClassItem.settlementPerStudent ?? "";
  }
  $("simplePerStudentWrap").classList.toggle("hidden", $("simpleSettlementMode").value !== "perHead");

  const limit = simpleCourseSize(type);
  const count = parseNames($("simpleStudentNames").value).length;
  $("simpleStudentHint").textContent = limit ? `请填写 ${limit} 名学生，当前 ${count} 名` : "班课请直接选择班级";
  buildSimpleAttendance();
  renderLessonPickers();
}

function simpleNamedStudents({ create = false } = {}) {
  const grade = $("simpleGrade").value;
  const tag = normalizeTag($("simpleStudentTag").value);
  return parseNames($("simpleStudentNames").value).map((name) => {
    let student = state.students.find((item) => item.name === name && item.grade === grade);
    if (!student && create) {
      student = { id: uid(), name, grade, institutionTag: tag, specialOne: null, note: "" };
      state.students.push(student);
    } else if (student && create && tag && student.institutionTag !== tag) {
      student.institutionTag = tag;
    }
    return student || { id: `temp-${name}`, name, grade, institutionTag: tag, specialOne: null, note: "" };
  });
}

function buildSimpleAttendance() {
  const type = $("simpleCourseType").value;
  if (type === "classCourse") {
    const classItem = getClass($("simpleClass").value);
    lessonAttendance = (classItem?.students || [])
      .filter((student) => student.status !== "inactive")
      .map((student) => ({ studentId: student.id, name: student.name, status: "present" }));
    syncTrialStudents();
    return;
  }
  lessonAttendance = simpleNamedStudents()
    .map((student) => ({ studentId: student.id, name: student.name, status: "present" }));
}

function simpleLessonData() {
  const type = $("simpleCourseType").value;
  const selectedClass = type === "classCourse" ? getClass($("simpleClass").value) : null;
  const selectedStudents = type === "classCourse" ? [] : simpleNamedStudents();
  return {
    grade: $("simpleGrade").value,
    courseType: type,
    selectedStudents,
    selectedClass,
    attendance: lessonAttendance.map((item) => ({ ...item })),
    manualAmount: numberOrNull($("manualAmount").value),
    settings: state.settings
  };
}

function simpleCourseName(data) {
  if (activeTemplate) return activeTemplate.name;
  if (data.courseType === "classCourse") return data.selectedClass?.name || COURSE_TYPES.classCourse;
  const names = data.selectedStudents.map((student) => student.name).join("、");
  return names || COURSE_TYPES[data.courseType] || "课程";
}

function getSelectedLessonData() {
  if (!activeTemplate) return simpleLessonData();
  const attendance = lessonAttendance.map((item) => ({ ...item }));
  const selectedClass = activeTemplate.courseType === "classCourse" ? getClass(activeTemplate.classId) : null;
  const selectedStudents = activeTemplate.courseType !== "classCourse"
    ? (activeTemplate?.studentIds || [])
      .map((id) => getStudent(id))
      .filter(Boolean)
    : [];
  return {
    grade: activeTemplate.grade || "",
    courseType: activeTemplate.courseType || "",
    selectedStudents,
    selectedClass,
    attendance,
    manualAmount: numberOrNull($("manualAmount").value),
    settings: state.settings
  };
}

function calculateWage({ grade, courseType, selectedStudents, selectedClass, attendance, manualAmount, settings }) {
  const standards = settings.standards;
  const defaultExtra = settings.defaultSmallExtra ?? 10;
  const warnings = [];
  const presentCount = attendance.filter((item) => item.status === "present").length;
  if (manualAmount !== null) {
    return { amount: manualAmount, source: `手动改价：本次实际工资 ${manualAmount} 元`, warnings };
  }
  if (!grade || !standards[grade]) return { amount: 0, source: "请选择年级", warnings: ["请选择年级"] };

  if (courseType !== "classCourse") {
    const expectedCount = simpleCourseSize(courseType) || 1;
    if (selectedStudents.length !== expectedCount) warnings.push(`${COURSE_TYPES[courseType]}需要选择 ${expectedCount} 名学生`);
    const student = selectedStudents[0];
    if (!student) return { amount: 0, source: "请选择学生", warnings };
    if (courseType === "oneToOne" && student.specialOne !== null && student.specialOne !== undefined) {
      return { amount: student.specialOne, source: `学生特殊价：${student.name}一对一特殊价格 ${student.specialOne} 元`, warnings };
    }
    const amount = Number(standards[grade][courseType] ?? standards[grade].oneToTwo ?? standards[grade].oneToOne ?? 0);
    return { amount, source: `工资标准：${grade}${COURSE_TYPES[courseType]} ${amount} 元`, warnings };
  }

  if (courseType === "classCourse") {
    if (!selectedClass) warnings.push("班课需要选择班级");
    if (presentCount < 2) warnings.push("班课到课人数少于 2 人，建议填写本次实际工资后保存");
    if (activeTemplate?.fixedMode === "fixed" && activeTemplate.fixedPrice !== null && activeTemplate.fixedPrice !== undefined) {
      return { amount: activeTemplate.fixedPrice, source: `模板固定价：${activeTemplate.name}固定价格 ${activeTemplate.fixedPrice} 元`, warnings };
    }
    const extra = defaultExtra;
    const extraCount = Math.max(presentCount - 2, 0);
    const base = standards[grade].classBase ?? standards[grade].oneToTwo;
    const amount = base + extraCount * extra;
    return { amount, source: `聚能结算：${grade}班课，到课 ${presentCount} 人，${base} + ${extraCount * extra} = ${amount} 元`, warnings };
  }
  return { amount: 0, source: "未识别课程类型", warnings: ["未识别课程类型"] };
}

function calculateLessonSettlementAmount({ wageAmount, courseType, selectedClass, attendance, settlementMode, perStudentPrice }) {
  const usePerHead = settlementMode === "perHead" || (courseType === "classCourse" && selectedClass?.settlementMode === "perHead");
  if (usePerHead) {
    const price = Number(perStudentPrice ?? selectedClass?.settlementPerStudent ?? 0);
    const presentCount = attendance.filter((item) => item.status === "present").length;
    return {
      amount: presentCount * price,
      source: `按人头收费：到课 ${presentCount} 人 × ${price} 元`
    };
  }
  return {
    amount: Number(wageAmount || 0),
    source: "按本次工资金额结算"
  };
}

function getLessonSettlementInput(data) {
  const classCustomPrice = data.selectedClass?.settlementPerStudent;
  const hasClassCustomPrice = classCustomPrice !== null && classCustomPrice !== undefined && classCustomPrice !== "";
  return {
    settlementMode: hasClassCustomPrice ? "perHead" : $("simpleSettlementMode").value,
    perStudentPrice: hasClassCustomPrice
      ? numberOrNull(data.selectedClass.settlementPerStudent)
      : numberOrNull($("simplePerStudentPrice").value)
  };
}

function calculateDisplayAmount(data, wageResult) {
  if (data.manualAmount !== null) return wageResult;
  const settlementInput = getLessonSettlementInput(data);
  const settlementInfo = calculateLessonSettlementAmount({
    wageAmount: wageResult.amount,
    courseType: data.courseType,
    selectedClass: data.selectedClass,
    attendance: data.attendance,
    settlementMode: settlementInput.settlementMode,
    perStudentPrice: settlementInput.perStudentPrice
  });
  return settlementInput.settlementMode === "perHead" ? settlementInfo : wageResult;
}

function updateLessonCalculation() {
  if (!activeTemplate && !($("simpleCourseType")?.value)) {
    $("computedAmount").textContent = money(0);
    $("priceSource").textContent = "请选择课程类型后自动计算";
    $("calcWarning").classList.add("hidden");
    return;
  }
  if (!activeTemplate && !$("savedLessonTarget").value && !$("simpleStudentNames").value.trim() && $("simpleCourseType").value !== "classCourse") {
    $("computedAmount").textContent = money(0);
    $("priceSource").textContent = "从已保存学生或班级里选择后自动计算";
    $("calcWarning").classList.add("hidden");
    return;
  }
  const data = getSelectedLessonData();
  const result = calculateWage(data);
  const displayResult = calculateDisplayAmount(data, result);
  $("computedAmount").textContent = money(displayResult.amount);
  $("priceSource").textContent = displayResult.source;
  $("calcWarning").innerHTML = result.warnings.map(h).join("<br>");
  $("calcWarning").classList.toggle("hidden", result.warnings.length === 0);
}

function saveLesson(event) {
  event.preventDefault();
  if (!$("savedLessonTarget").value && !$("simpleStudentNames").value.trim() && $("simpleCourseType").value !== "classCourse") return alert("请先从已保存里选择学生或班级，或者使用下方临时一节课。");
  if (!activeTemplate && $("simpleCourseType").value !== "classCourse") simpleNamedStudents({ create: true });
  if (!activeTemplate) buildSimpleAttendance();
  const data = getSelectedLessonData();
  const result = calculateWage(data);
  const settlementInput = getLessonSettlementInput(data);
  const hasManual = data.manualAmount !== null;
  if (settlementInput.settlementMode === "perHead" && settlementInput.perStudentPrice === null) return alert("按每人收费结算时，请填写每人收费金额。");
  if (result.warnings.length && !hasManual) return alert(`${result.warnings.join("；")}。如确实要保存，请填写本次实际工资。`);
  const courseName = simpleCourseName(data);
  const duplicateKey = activeTemplate?.id || `${data.courseType}-${data.selectedClass?.id || data.selectedStudents.map((student) => student.id).join("-")}`;
  if (state.records.some((record) => record.date === $("lessonDate").value && (record.templateId || record.simpleKey) === duplicateKey && record.id !== $("lessonId").value)) {
    if (!confirm("今天已经记录过这节课，是否继续保存？")) return;
  }
  const counts = attendanceCounts(data.attendance);
  const id = $("lessonId").value || uid();
  const settlementInfo = calculateLessonSettlementAmount({
    wageAmount: result.amount,
    courseType: data.courseType,
    selectedClass: data.selectedClass,
    attendance: data.attendance,
    settlementMode: settlementInput.settlementMode,
    perStudentPrice: settlementInput.perStudentPrice
  });
  const shouldUseSettlementAmount = settlementInput.settlementMode === "perHead" && data.manualAmount === null;
  const savedSettlementInfo = shouldUseSettlementAmount ? settlementInfo : { amount: result.amount, source: result.source };
  const finalAmount = savedSettlementInfo.amount;
  const finalSource = savedSettlementInfo.source;
  const record = {
    id,
    date: $("lessonDate").value,
    templateId: activeTemplate?.id || "",
    simpleKey: duplicateKey,
    courseName,
    courseType: data.courseType,
    grade: data.grade,
    institutionTag: data.selectedClass?.institutionTag || data.selectedStudents[0]?.institutionTag || "",
    classId: data.selectedClass?.id || "",
    className: data.selectedClass?.name || "",
    studentIds: data.attendance.filter((item) => item.status === "present").map((item) => item.studentId),
    attendance: data.attendance,
    attendanceCount: counts.present,
    leaveCount: counts.leave,
    absentCount: counts.absent,
    amount: finalAmount,
    priceSource: finalSource,
    settlementAmount: savedSettlementInfo.amount,
    settlementSource: savedSettlementInfo.source,
    manualAmount: data.manualAmount,
    note: $("lessonNote").value.trim(),
    confirmed: state.records.find((item) => item.id === id)?.confirmed || false,
    settlementId: state.records.find((item) => item.id === id)?.settlementId || "",
    studentSettlementIds: state.records.find((item) => item.id === id)?.studentSettlementIds || {}
  };
  const index = state.records.findIndex((item) => item.id === id);
  if (index >= 0) state.records[index] = record;
  else state.records.push(record);
  if (activeTemplate) {
    const template = state.courseTemplates.find((item) => item.id === activeTemplate.id);
    if (template) template.lastUsedAt = new Date().toISOString();
  }
  state.records.sort((a, b) => b.date.localeCompare(a.date));
  const keepDate = $("lessonDate").value;
  saveState();
  resetLessonForm(keepDate);
}

function saveTempLesson() {
  const name = $("tempLessonName").value.trim();
  const tag = normalizeTag($("tempLessonTag").value);
  const amount = numberOrNull($("tempLessonAmount").value);
  if (!name) return alert("请填写临时课姓名或课程。");
  if (amount === null) return alert("请填写临时课价格。");
  const id = uid();
  const record = {
    id,
    date: $("lessonDate").value || today(),
    templateId: "",
    simpleKey: `temp-${id}`,
    courseName: name,
    courseType: "oneToOne",
    grade: "",
    institutionTag: tag,
    classId: "",
    className: "",
    studentIds: [`temp-${id}`],
    attendance: [{ studentId: `temp-${id}`, name, status: "present", isTemp: true }],
    attendanceCount: 1,
    leaveCount: 0,
    absentCount: 0,
    amount,
    priceSource: `临时课：${amount} 元`,
    settlementAmount: amount,
    settlementSource: "临时课按填写价格结算",
    manualAmount: amount,
    note: $("tempLessonNote").value.trim(),
    confirmed: false,
    settlementId: "",
    studentSettlementIds: {}
  };
  state.records.push(record);
  state.records.sort((a, b) => b.date.localeCompare(a.date));
  $("tempLessonName").value = "";
  $("tempLessonTag").value = "";
  $("tempLessonAmount").value = "";
  $("tempLessonNote").value = "";
  saveState();
}

function resetLessonForm(keepDate = $("lessonDate").value || today()) {
  $("lessonId").value = "";
  $("selectedTemplateId").value = "";
  $("savedLessonTarget").value = "";
  $("lessonDate").value = keepDate;
  $("manualAmount").value = "";
  $("lessonNote").value = "";
  $("trialStudentsInput").value = "";
  $("simpleStudentNames").value = "";
  $("simpleStudentTag").value = "";
  activeTemplate = null;
  lessonAttendance = [];
  renderSimpleLessonPickers();
  renderLessonTemplates();
  renderLessonPickers();
  updateLessonCalculation();
}

function editLesson(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  activeTemplate = record.templateId ? (state.courseTemplates.find((item) => item.id === record.templateId) || {
    id: record.templateId,
    name: record.courseName || "历史记录",
    courseType: record.courseType,
    grade: record.grade,
    studentIds: record.studentIds || [],
    classId: record.classId || "",
    className: record.className || "",
    enabled: true
  }) : null;
  $("lessonId").value = record.id;
  $("selectedTemplateId").value = activeTemplate?.id || "";
  $("lessonDate").value = record.date;
  $("manualAmount").value = record.manualAmount ?? "";
  $("lessonNote").value = record.note || "";
  lessonAttendance = normalizedAttendance(record);
  $("simpleCourseType").value = record.courseType || "oneToOne";
  $("simpleGrade").value = record.grade || GRADES[0];
  $("simpleStudentNames").value = record.courseType === "classCourse" ? "" : lessonAttendance.map((item) => item.name).join("、");
  $("simpleStudentTag").value = record.institutionTag || "";
  $("savedLessonTarget").value = record.classId ? `class:${record.classId}` : "";
  if (!record.classId) {
    const firstStudentId = normalizedAttendance(record)[0]?.studentId;
    if (firstStudentId && state.students.some((student) => student.id === firstStudentId)) $("savedLessonTarget").value = `student:${firstStudentId}`;
  }
  $("trialStudentsInput").value = lessonAttendance.filter((item) => item.isTrial).map((item) => item.name).join("、");
  switchTab("record");
  renderSimpleLessonPickers();
  if (record.classId) {
    $("simpleClass").value = record.classId;
    lessonAttendance = normalizedAttendance(record);
  }
  renderLessonTemplates();
  renderLessonPickers();
  updateLessonCalculation();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function deleteLesson(id) {
  if (!confirm("确定删除这条上课记录吗？")) return;
  state.records = state.records.filter((item) => item.id !== id);
  saveState();
}

function toggleRecordConfirmed(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  record.confirmed = !record.confirmed;
  saveState();
}

function toggleRecordGroupConfirmed(idsText) {
  const ids = idsText.split(",").filter(Boolean);
  const records = state.records.filter((record) => ids.includes(record.id));
  const shouldConfirm = records.some((record) => !record.confirmed);
  records.forEach((record) => {
    record.confirmed = shouldConfirm;
  });
  saveState();
}

function saveTemplate(event) {
  event.preventDefault();
  const id = $("templateId").value || uid();
  const type = $("templateType").value;
  const studentIds = type === "oneToOne" ? selectedTemplateStudentIds() : [];
  const classId = type === "classCourse" ? $("templateClass").value : "";
  if (type === "oneToOne" && studentIds.length !== 1) return alert("一对一模板必须关联 1 个个人学生。");
  if (type === "classCourse" && !classId) return alert("班课模板必须关联 1 个班级。");
  const templateName = $("templateName").value.trim() || suggestedTemplateName();
  if (!templateName) return alert("请选择学生或班级，系统会自动生成课程名称。");
  $("templateName").value = templateName;
  const template = {
    id,
    name: templateName,
    courseType: type,
    sourceType: type === "classCourse" ? "class" : "personal",
    grade: $("templateGrade").value,
    studentIds,
    classId,
    className: getClass(classId)?.name || "",
    fixedMode: $("templateBillingMode").value,
    fixedPrice: numberOrNull($("templateFixedPrice").value),
    enabled: $("templateEnabled").checked,
    sortOrder: state.courseTemplates.find((item) => item.id === id)?.sortOrder ?? 100,
    note: $("templateNote").value.trim(),
    lastUsedAt: state.courseTemplates.find((item) => item.id === id)?.lastUsedAt || ""
  };
  const index = state.courseTemplates.findIndex((item) => item.id === id);
  if (index >= 0) state.courseTemplates[index] = template;
  else state.courseTemplates.push(template);
  resetTemplateForm();
  saveState();
}

function resetTemplateForm() {
  $("templateId").value = "";
  $("templateName").value = "";
  $("templateName").dataset.manualName = "false";
  $("templateName").dataset.suggestedName = "";
  $("templateType").value = "oneToOne";
  $("templateGrade").value = GRADES[0];
  $("templateClass").value = "";
  $("templateBillingMode").value = "auto";
  $("templateFixedPrice").value = "";
  $("templateNote").value = "";
  $("templateEnabled").checked = true;
  renderTemplateFormPickers();
}

function renderTemplateFormPickers() {
  const type = $("templateType").value;
  const grade = $("templateGrade").value;
  const selectedClassId = $("templateClass").value;
  const isClass = type === "classCourse";
  $("templateClassWrap").classList.toggle("hidden", !isClass);
  $("templateBillingWrap").classList.toggle("hidden", !isClass);
  $("templateFixedPriceWrap").classList.toggle("hidden", !isClass || $("templateBillingMode").value !== "fixed");
  $("templateStudentsWrap").classList.toggle("hidden", isClass);
  const classOptions = state.classes.filter((item) => item.grade === grade);
  $("templateClass").innerHTML = `<option value="">${classOptions.length ? "选择班级" : `当前年级还没有班级`}</option>` + classOptions
    .map((item) => `<option value="${item.id}">${h(item.name)}（${h(item.grade)}）</option>`)
    .join("");
  if (classOptions.some((item) => item.id === selectedClassId)) $("templateClass").value = selectedClassId;
  const selectedIds = selectedTemplateStudentIds();
  $("templateStudentHint").textContent = "一对一请选择 1 名学生";
  const students = state.students.filter((student) => student.grade === grade);
  $("templateStudents").innerHTML = students.length ? students.map((student) => `
    <label class="check-card">
      <input type="checkbox" value="${student.id}" ${selectedIds.includes(student.id) ? "checked" : ""}>
      <span>${h(student.name)}</span>
    </label>
  `).join("") : `<div class="empty">当前年级还没有个人学生。</div>`;
  $("templateStudents").querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", (event) => {
      const limit = 1;
      const checked = Array.from($("templateStudents").querySelectorAll("input:checked"));
      if (checked.length > limit) event.target.checked = false;
      syncTemplateNameWithSelection();
    });
  });
  syncTemplateNameWithSelection();
}

function selectedTemplateStudentIds() {
  return Array.from($("templateStudents").querySelectorAll("input:checked")).map((input) => input.value);
}

function suggestedTemplateName() {
  const type = $("templateType").value;
  if (type === "classCourse") return getClass($("templateClass").value)?.name || "";
  const studentId = selectedTemplateStudentIds()[0];
  return getStudent(studentId)?.name || "";
}

function syncTemplateNameWithSelection({ force = false } = {}) {
  const input = $("templateName");
  const suggestion = suggestedTemplateName();
  const previousSuggestion = input.dataset.suggestedName || "";
  const current = input.value.trim();
  const isManual = input.dataset.manualName === "true";
  input.dataset.suggestedName = suggestion;
  if (!suggestion) return;
  if (force || !isManual || !current || current === previousSuggestion) {
    input.value = suggestion;
    input.dataset.manualName = "false";
  }
}

function updateTemplateNameManualState() {
  const input = $("templateName");
  const current = input.value.trim();
  const suggestion = input.dataset.suggestedName || suggestedTemplateName();
  input.dataset.manualName = current && current !== suggestion ? "true" : "false";
}

function renderTemplateList() {
  const templates = sortedTemplates(true);
  $("templateList").innerHTML = templates.length ? TYPE_GROUPS.map(([type, label]) => {
    const group = templates.filter((template) => template.courseType === type);
    if (!group.length) return "";
    return `
      <div class="template-list-group">
        <h3>${label}</h3>
        ${group.map((template) => {
    const names = template.courseType === "classCourse"
      ? (getClass(template.classId)?.name || template.className || "")
      : (template.studentIds || []).map((id) => getStudent(id)?.name || "已删除学生").join("、");
    return `
      <article class="item">
        <div class="item-head">
          <strong>${h(template.name)}</strong>
          <span class="muted">${template.enabled === false ? "停用" : "启用"}</span>
        </div>
        <p>${h(COURSE_TYPES[template.courseType])}｜${h(template.grade)}｜${h(names || "未关联")}</p>
        ${template.note ? `<p>${h(template.note)}</p>` : ""}
        <div class="item-actions">
          <button class="secondary small" onclick="editTemplate('${template.id}')">编辑</button>
          <button class="danger small" onclick="deleteTemplate('${template.id}')">删除</button>
        </div>
      </article>
    `;
        }).join("")}
      </div>
    `;
  }).join("") : `<div class="empty">还没有课程模板。</div>`;
}

function editTemplate(id) {
  const template = state.courseTemplates.find((item) => item.id === id);
  if (!template) return;
  $("templateId").value = template.id;
  $("templateName").value = template.name;
  $("templateType").value = template.courseType;
  $("templateGrade").value = template.grade;
  $("templateNote").value = template.note || "";
  $("templateBillingMode").value = template.fixedMode || "auto";
  $("templateFixedPrice").value = template.fixedPrice ?? "";
  $("templateEnabled").checked = template.enabled !== false;
  $("templateName").dataset.manualName = "true";
  $("templateName").dataset.suggestedName = "";
  renderTemplateFormPickers();
  $("templateClass").value = template.classId || "";
  $("templateStudents").querySelectorAll("input").forEach((input) => {
    input.checked = (template.studentIds || []).includes(input.value);
  });
  const suggestion = suggestedTemplateName();
  $("templateName").dataset.suggestedName = suggestion;
  $("templateName").dataset.manualName = template.name && template.name !== suggestion ? "true" : "false";
  syncTemplateNameWithSelection();
  switchTab("templates");
}

function deleteTemplate(id) {
  if (!confirm("确定删除这个课程模板吗？历史上课记录不会删除。")) return;
  state.courseTemplates = state.courseTemplates.filter((item) => item.id !== id);
  if (activeTemplate?.id === id) resetLessonForm();
  saveState();
}

function saveStudent(event) {
  event.preventDefault();
  const id = $("studentId").value || uid();
  const student = {
    id,
    name: $("studentName").value.trim(),
    grade: $("studentGrade").value,
    institutionTag: normalizeTag($("studentTag").value),
    specialOne: numberOrNull($("specialOne").value),
    note: $("studentNote").value.trim()
  };
  if (!student.name) return alert("请填写学生姓名。");
  const index = state.students.findIndex((item) => item.id === id);
  if (index >= 0) state.students[index] = student;
  else state.students.push(student);
  resetStudentForm();
  saveState();
}

function resetStudentForm() {
  $("studentId").value = "";
  $("studentName").value = "";
  $("studentGrade").value = GRADES[0];
  $("studentTag").value = "";
  $("specialOne").value = "";
  $("studentNote").value = "";
}

function renderStudents() {
  const keyword = $("studentSearch").value.trim().toLowerCase();
  const grade = $("studentGradeFilter").value;
  const students = state.students.filter((student) => {
    if (keyword && !student.name.toLowerCase().includes(keyword)) return false;
    if (grade && student.grade !== grade) return false;
    return true;
  });
  $("studentList").innerHTML = students.length ? students.map((student) => {
    const specials = student.specialOne !== null ? `一对一特殊价 ${student.specialOne}` : "使用默认价格";
    return `
      <article class="item">
        <div class="item-head">
          <strong>${h(student.name)}</strong>
          <span class="muted">${h([student.grade, student.institutionTag].filter(Boolean).join("｜"))}</span>
        </div>
        <p>${h(specials)}</p>
        ${student.note ? `<p>${h(student.note)}</p>` : ""}
        <div class="item-actions">
          <button class="secondary small" onclick="editStudent('${student.id}')">编辑</button>
          <button class="danger small" onclick="deleteStudent('${student.id}')">删除</button>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty">没有符合条件的个人学生。</div>`;
}

function editStudent(id) {
  const student = getStudent(id);
  if (!student) return;
  $("studentId").value = student.id;
  $("studentName").value = student.name;
  $("studentGrade").value = student.grade;
  $("studentTag").value = student.institutionTag || "";
  $("specialOne").value = student.specialOne ?? "";
  $("studentNote").value = student.note || "";
  switchTab("students");
}

function deleteStudent(id) {
  if (!confirm("确定删除这个个人学生吗？相关课程模板会失去关联。")) return;
  state.students = state.students.filter((item) => item.id !== id);
  state.courseTemplates = state.courseTemplates.map((template) => ({ ...template, studentIds: (template.studentIds || []).filter((studentId) => studentId !== id) }));
  saveState();
}

function addBulkClassStudents() {
  const names = parseNames($("classBulkStudents").value);
  if (!names.length) return;
  const existing = new Set(editingClassStudents.map((item) => item.name));
  names.forEach((name) => {
    if (existing.has(name)) return;
    existing.add(name);
    editingClassStudents.push({ id: uid(), name, status: "active", note: "" });
  });
  $("classBulkStudents").value = "";
  renderClassStudentList();
}

function parseNames(text) {
  return [...new Set(String(text || "")
    .split(/[\n\r、,，\s]+/)
    .map((name) => name.trim())
    .filter(Boolean))];
}

function renderClassStudentList() {
  $("classStudentList").innerHTML = editingClassStudents.length ? editingClassStudents.map((student) => `
    <div class="class-student-row ${student.status === "inactive" ? "is-inactive" : ""}">
      <input value="${h(student.name)}" oninput="updateClassStudentName('${student.id}', this.value)">
      <input value="${h(student.note || "")}" placeholder="备注" oninput="updateClassStudentNote('${student.id}', this.value)">
      <span>${student.status === "inactive" ? "停用" : "在读"}</span>
      <button type="button" class="secondary small" onclick="toggleClassStudent('${student.id}')">${student.status === "inactive" ? "恢复" : "停用"}</button>
      <button type="button" class="danger small" onclick="deleteClassStudent('${student.id}')">删除</button>
    </div>
  `).join("") : `<div class="empty">还没有班级学生。可以批量输入姓名后添加。</div>`;
}

function updateClassStudentName(id, value) {
  editingClassStudents = editingClassStudents.map((item) => item.id === id ? { ...item, name: value.trim() } : item);
}

function updateClassStudentNote(id, value) {
  editingClassStudents = editingClassStudents.map((item) => item.id === id ? { ...item, note: value.trim() } : item);
}

function toggleClassStudent(id) {
  editingClassStudents = editingClassStudents.map((item) => item.id === id ? { ...item, status: item.status === "inactive" ? "active" : "inactive" } : item);
  renderClassStudentList();
}

function deleteClassStudent(id) {
  if (!confirm("确定删除这个班级学生吗？历史记录中已保存的姓名不会丢失。")) return;
  editingClassStudents = editingClassStudents.filter((item) => item.id !== id);
  renderClassStudentList();
}

function saveClass(event) {
  event.preventDefault();
  addBulkClassStudents();
  const id = $("classId").value || uid();
  const classItem = {
    id,
    name: $("className").value.trim(),
    grade: $("classGrade").value,
    institutionTag: normalizeTag($("classTag").value),
    students: editingClassStudents.filter((student) => student.name).map((student) => ({ ...student })),
    smallBasePrice: null,
    extraPerStudent: 10,
    settlementMode: numberOrNull($("classSettlementPerStudent").value) === null ? "wage" : "perHead",
    settlementPerStudent: numberOrNull($("classSettlementPerStudent").value),
    note: $("classNote").value.trim()
  };
  if (!classItem.name) return alert("请填写班级名称。");
  const index = state.classes.findIndex((item) => item.id === id);
  if (index >= 0) state.classes[index] = classItem;
  else state.classes.push(classItem);
  resetClassForm();
  saveState();
}

function resetClassForm(shouldRender = true) {
  $("classId").value = "";
  $("className").value = "";
  $("classGrade").value = GRADES[0];
  $("classTag").value = "";
  $("classSettlementPerStudent").value = "";
  $("classBulkStudents").value = "";
  $("classNote").value = "";
  editingClassStudents = [];
  if (shouldRender) renderClassStudentList();
}

function renderClasses() {
  $("classList").innerHTML = state.classes.length ? state.classes.map((classItem) => {
    const active = (classItem.students || []).filter((student) => student.status !== "inactive");
    const inactive = (classItem.students || []).filter((student) => student.status === "inactive");
    const settlement = classItem.settlementPerStudent !== null && classItem.settlementPerStudent !== undefined
      ? `自定义收费：每人 ${classItem.settlementPerStudent} 元`
      : "聚能结算";
    return `
      <article class="item">
        <div class="item-head">
          <strong>${h(classItem.name)}</strong>
          <span class="muted">${h([classItem.grade, classItem.institutionTag].filter(Boolean).join("｜"))}</span>
        </div>
        <p>${h(settlement)}</p>
        <p>在读：${h(active.map((student) => student.name).join("、") || "暂无")}</p>
        ${inactive.length ? `<p>停用：${h(inactive.map((student) => student.name).join("、"))}</p>` : ""}
        ${classItem.note ? `<p>${h(classItem.note)}</p>` : ""}
        <div class="item-actions">
          <button class="secondary small" onclick="editClass('${classItem.id}')">编辑</button>
          <button class="danger small" onclick="deleteClass('${classItem.id}')">删除</button>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty">还没有班级资料。</div>`;
}

function editClass(id) {
  const classItem = getClass(id);
  if (!classItem) return;
  $("classId").value = classItem.id;
  $("className").value = classItem.name;
  $("classGrade").value = classItem.grade;
  $("classTag").value = classItem.institutionTag || "";
  $("classSettlementPerStudent").value = classItem.settlementPerStudent ?? "";
  $("classNote").value = classItem.note || "";
  $("classBulkStudents").value = "";
  editingClassStudents = clone(classItem.students || []);
  renderClassStudentList();
  switchTab("classes");
}

function deleteClass(id) {
  if (!confirm("确定删除这个班级吗？相关课程模板会失去关联。")) return;
  state.classes = state.classes.filter((item) => item.id !== id);
  state.courseTemplates = state.courseTemplates.map((template) => template.classId === id ? { ...template, classId: "" } : template);
  saveState();
}

function renderDashboard() {
  const year = String(new Date().getFullYear());
  const mainYear = state.mainIncomes.filter((item) => item.month.startsWith(year));
  const settlementsYear = state.settlements.filter((item) => item.settledAt.startsWith(year) || item.month.startsWith(year));
  const pendingYear = state.records.filter((record) => record.date.startsWith(year) && recordPendingSettlementAmount(record) > 0);
  const mainTotal = sumMainIncome(mainYear);
  const sideSettled = settlementsYear.reduce((total, item) => total + Number(item.amount || 0), 0);
  const sidePending = sumPendingSettlement(pendingYear);
  $("yearIncomeTotal").textContent = money(mainTotal + sideSettled);
  $("yearMainIncome").textContent = money(mainTotal);
  $("yearSideSettled").textContent = money(sideSettled);
  $("yearSidePending").textContent = money(sidePending);
  $("overviewYearLabel").textContent = `${year} 年`;
  renderMonthlyIncomeList(year);
  renderIncomeSourceList(mainYear, settlementsYear);
  renderPendingSettlementList(pendingYear);
}

function renderMonthlyIncomeList(year) {
  const rows = Array.from({ length: 12 }, (_, index) => {
    const month = `${year}-${String(index + 1).padStart(2, "0")}`;
    const main = sumMainIncome(state.mainIncomes.filter((item) => item.month === month));
    const side = state.settlements.filter((item) => item.month === month || item.settledAt.startsWith(month))
      .reduce((total, item) => total + Number(item.amount || 0), 0);
    const pending = sumPendingSettlement(state.records.filter((record) => record.date.startsWith(month)));
    return { month, main, side, pending, total: main + side };
  });
  const max = Math.max(...rows.map((row) => row.total + row.pending), 1);
  $("monthlyIncomeList").innerHTML = rows.map((row) => `
    <div class="month-row">
      <span>${row.month}</span>
      <div class="bar-track">
        <i class="bar-main" style="width:${Math.round(row.main / max * 100)}%"></i>
        <i class="bar-side" style="width:${Math.round(row.side / max * 100)}%"></i>
        <i class="bar-pending" style="width:${Math.round(row.pending / max * 100)}%"></i>
      </div>
      <strong>${money(row.total)}</strong>
      <em>未结 ${money(row.pending)}</em>
    </div>
  `).join("");
}

function renderIncomeSourceList(mainYear, settlementsYear) {
  const sources = new Map();
  sources.set("省机关医院", sumMainIncome(mainYear));
  settlementsYear.forEach((item) => {
    const name = item.targetName || item.title || "副业";
    sources.set(name, (sources.get(name) || 0) + Number(item.amount || 0));
  });
  const rows = Array.from(sources.entries()).filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]);
  $("incomeSourceList").innerHTML = rows.length ? rows.map(([name, amount]) => `
    <div class="source-row">
      <span>${h(name)}</span>
      <strong>${money(amount)}</strong>
    </div>
  `).join("") : `<div class="empty">还没有已结算收入。</div>`;
}

function renderPendingSettlementList(records) {
  const groups = groupPendingRecords(records);
  $("pendingSettlementList").innerHTML = groups.length ? groups.slice(0, 6).map((group) => `
    <article class="compact-item">
      <strong>${h(group.name)} ${money(group.amount)}</strong>
      <p>${group.count} 次课｜${h(group.kind)}｜${h(group.months.join("、"))}</p>
    </article>
  `).join("") : `<div class="empty">今年副业课时都已结算。</div>`;
}

function renderSettlementPage() {
  renderSettlementTargets();
  renderSettlementPreview();
  renderSettlementList();
}

function renderSettlementTargets() {
  const mode = $("settlementMode").value;
  const current = $("settlementTarget").value;
  let options = [];
  if (mode === "juneng") {
    options = availableInstitutionTags().map((tag) => ({ id: tag, name: tag }));
  } else {
    options = settlementStudentOptions();
  }
  $("settlementTarget").innerHTML = `<option value="">选择结算对象</option>` + options.map((item) => `<option value="${h(item.id)}">${h(item.name)}</option>`).join("");
  if (options.some((item) => item.id === current)) $("settlementTarget").value = current;
  else if (mode === "juneng" && options.some((item) => item.id === "聚能")) $("settlementTarget").value = "聚能";
}

function settlementStudentOptions() {
  const map = new Map();
  state.records.filter((record) => !record.settlementId).forEach((record) => {
    if (recordInstitutionTag(record) === "聚能") return;
    normalizedAttendance(record).filter((item) => item.status === "present").forEach((item) => {
      const key = studentSettlementKey(item);
      if (key && !record.studentSettlementIds?.[key] && !map.has(key)) {
        map.set(key, {
          id: key,
          name: `${item.name}${recordInstitutionTag(record) ? `｜${recordInstitutionTag(record)}` : ""}`
        });
      }
    });
  });
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function settlementCandidateRecords() {
  const mode = $("settlementMode").value;
  const target = $("settlementTarget").value;
  const month = $("settlementMonth").value || currentMonth();
  if (!target) return [];
  return state.records.filter((record) => {
    if (!record.date.startsWith(month)) return false;
    if (mode === "juneng") return !record.settlementId && recordInstitutionTag(record) === target;
    if (record.settlementId || recordInstitutionTag(record) === "聚能") return false;
    return recordPresentStudents(record).some((item) => studentSettlementKey(item) === target && !record.studentSettlementIds?.[target]);
  });
}

function renderSettlementPreview() {
  const records = settlementCandidateRecords();
  const mode = $("settlementMode").value;
  const target = $("settlementTarget").value;
  const total = settlementRecordsAmount(records, mode, target);
  $("settlementPreviewAmount").textContent = money(total);
  $("settlementPreviewText").textContent = records.length
    ? mode === "ownStudent"
      ? `${records.length} 次未结算课，将给这个学生生成一张结算单。`
      : `${records.length} 次未结算课，将生成一张结算单。`
    : "当前条件下没有未结算课。";
  $("settlementPreviewList").innerHTML = records.length ? records.map((record) => `
    <article class="compact-item">
      <strong>${h(record.date)} ${h(record.courseName)} ${money(settlementRecordAmountForMode(record, mode, target))}</strong>
      <p>${h(COURSE_TYPES[record.courseType])}｜整节 ${money(recordSettlementAmount(record))}｜${h(recordSettlementSource(record))}</p>
    </article>
  `).join("") : `<div class="empty">没有可结算课时。</div>`;
}

function saveSettlement(event) {
  event.preventDefault();
  const records = settlementCandidateRecords();
  if (!records.length) return alert("当前条件下没有未结算课。");
  const mode = $("settlementMode").value;
  const targetId = $("settlementTarget").value;
  const targetName = settlementTargetName(mode, targetId);
  const month = $("settlementMonth").value || currentMonth();
  const id = uid();
  const settlement = {
    id,
    title: `${targetName} ${month} 结算`,
    mode,
    targetId,
    targetName,
    month,
    settledAt: $("settlementDate").value || today(),
    amount: settlementRecordsAmount(records, mode, targetId),
    recordIds: records.map((record) => record.id),
    note: $("settlementNote").value.trim(),
    createdAt: new Date().toISOString()
  };
  records.forEach((record) => markRecordSettled(record, mode, targetId, id));
  state.settlements.push(settlement);
  $("settlementNote").value = "";
  saveState();
}

function settlementTargetName(mode, targetId) {
  if (mode === "juneng") return targetId || "聚能";
  return settlementStudentName(targetId);
}

function settlementStudentName(targetId) {
  const student = getStudent(targetId);
  if (student) return student.name;
  for (const record of state.records) {
    const item = normalizedAttendance(record).find((studentItem) => studentItem.studentId === targetId || studentItem.name === targetId);
    if (item) return item.name;
  }
  return "个人";
}

function renderSettlementList() {
  const settlements = [...state.settlements].sort((a, b) => (b.settledAt || "").localeCompare(a.settledAt || ""));
  $("settlementCountText").textContent = `${settlements.length} 张`;
  $("settlementList").innerHTML = settlements.length ? settlements.map((item) => `
    <article class="item settlement-item">
      <div class="item-head">
        <strong>${h(item.title || item.targetName)}</strong>
        <span class="pill">${money(item.amount)}</span>
      </div>
      <p>${h(item.settledAt)} 到账｜${h(settlementModeLabel(item.mode))}｜${item.recordIds.length} 次课</p>
      ${item.note ? `<p>${h(item.note)}</p>` : ""}
      <div class="item-actions">
        <button class="danger small" onclick="deleteSettlement('${item.id}')">撤销结算</button>
      </div>
    </article>
  `).join("") : `<div class="empty">还没有结算单。</div>`;
}

function settlementModeLabel(mode) {
  return { juneng: "聚能默认结算", ownStudent: "我的学生逐个结算", institution: "按机构", class: "按班级", student: "按个人" }[mode] || "结算";
}

function deleteSettlement(id) {
  const settlement = state.settlements.find((item) => item.id === id);
  if (!settlement) return;
  if (!confirm("撤销后，这批课会重新变成未结算，确定继续吗？")) return;
  state.records.forEach((record) => {
    let touched = false;
    if (record.settlementId === id) {
      record.settlementId = "";
      touched = true;
    }
    if (record.studentSettlementIds) {
      Object.keys(record.studentSettlementIds).forEach((key) => {
        if (record.studentSettlementIds[key] === id) {
          delete record.studentSettlementIds[key];
          touched = true;
        }
      });
    }
    if (touched) record.confirmed = isRecordFullySettled(record);
  });
  state.settlements = state.settlements.filter((item) => item.id !== id);
  saveState();
}

function saveMainIncome(event) {
  event.preventDefault();
  const id = $("mainIncomeId").value || uid();
  const baseSalary = Number($("mainBaseSalary").value || 0);
  const performance = Number($("mainPerformance").value || 0);
  const allowance = Number($("mainAllowance").value || 0);
  const deduction = Number($("mainDeduction").value || 0);
  const autoAmount = baseSalary + performance + allowance - deduction;
  const amount = numberOrNull($("mainActualAmount").value) ?? autoAmount;
  const income = {
    id,
    month: $("mainIncomeMonth").value || currentMonth(),
    baseSalary,
    performance,
    allowance,
    deduction,
    amount,
    note: $("mainIncomeNote").value.trim(),
    createdAt: state.mainIncomes.find((item) => item.id === id)?.createdAt || new Date().toISOString()
  };
  const index = state.mainIncomes.findIndex((item) => item.id === id);
  if (index >= 0) state.mainIncomes[index] = income;
  else state.mainIncomes.push(income);
  resetMainIncomeForm();
  saveState();
}

function resetMainIncomeForm() {
  $("mainIncomeId").value = "";
  $("mainIncomeMonth").value = currentMonth();
  $("mainBaseSalary").value = "0";
  $("mainPerformance").value = "0";
  $("mainAllowance").value = "0";
  $("mainDeduction").value = "0";
  $("mainActualAmount").value = "";
  $("mainIncomeNote").value = "";
}

function renderMainIncomePage() {
  const year = String(new Date().getFullYear());
  const incomes = [...state.mainIncomes].sort((a, b) => b.month.localeCompare(a.month));
  $("mainIncomeYearTotal").textContent = money(sumMainIncome(state.mainIncomes.filter((item) => item.month.startsWith(year))));
  $("mainIncomeList").innerHTML = incomes.length ? incomes.map((item) => `
    <article class="item">
      <div class="item-head">
        <strong>${h(item.month)} 省机关医院</strong>
        <span class="pill">${money(item.amount)}</span>
      </div>
      <p>基本 ${money(item.baseSalary)}｜绩效 ${money(item.performance)}｜补贴 ${money(item.allowance)}｜扣款 ${money(item.deduction)}</p>
      ${item.note ? `<p>${h(item.note)}</p>` : ""}
      <div class="item-actions">
        <button class="secondary small" onclick="editMainIncome('${item.id}')">编辑</button>
        <button class="danger small" onclick="deleteMainIncome('${item.id}')">删除</button>
      </div>
    </article>
  `).join("") : `<div class="empty">还没有主业收入记录。</div>`;
}

function editMainIncome(id) {
  const item = state.mainIncomes.find((income) => income.id === id);
  if (!item) return;
  $("mainIncomeId").value = item.id;
  $("mainIncomeMonth").value = item.month;
  $("mainBaseSalary").value = item.baseSalary || 0;
  $("mainPerformance").value = item.performance || 0;
  $("mainAllowance").value = item.allowance || 0;
  $("mainDeduction").value = item.deduction || 0;
  $("mainActualAmount").value = item.amount ?? "";
  $("mainIncomeNote").value = item.note || "";
  switchTab("mainIncome");
}

function deleteMainIncome(id) {
  if (!confirm("确定删除这条主业收入吗？")) return;
  state.mainIncomes = state.mainIncomes.filter((item) => item.id !== id);
  saveState();
}

function sumMainIncome(items) {
  return items.reduce((total, item) => total + Number(item.amount || 0), 0);
}

function groupPendingRecords(records) {
  const groups = new Map();
  records.forEach((record) => {
    const tag = recordInstitutionTag(record);
    if (tag === "聚能") {
      if (record.settlementId) return;
      addPendingGroup(groups, `institution|${tag}`, tag, "聚能统一", record.date, recordSettlementAmount(record));
      return;
    }
    recordPresentStudents(record).forEach((student) => {
      const key = studentSettlementKey(student);
      if (record.studentSettlementIds?.[key]) return;
      addPendingGroup(groups, `student|${key}`, student.name || record.courseName, "学生单独", record.date, settlementRecordAmountForMode(record, "ownStudent", key));
    });
  });
  return Array.from(groups.values()).map((group) => ({
    ...group,
    months: Array.from(group.months).sort()
  })).sort((a, b) => b.amount - a.amount);
}

function addPendingGroup(groups, key, name, kind, date, amount) {
  if (!groups.has(key)) groups.set(key, { name, kind, count: 0, amount: 0, months: new Set() });
  const group = groups.get(key);
  group.count += 1;
  group.amount += Number(amount || 0);
  group.months.add(date.slice(0, 7));
}

function renderStats() {
  const todayDate = today();
  const month = $("filterMonth").value || currentMonth();
  const filterDate = $("filterDate").value;
  const filterTag = $("filterTag").value;
  const filterCourseType = $("filterCourseType").value;
  const todayRecords = state.records.filter((record) => record.date === todayDate);
  const monthRecords = state.records.filter((record) => record.date.startsWith(month));
  const displayRecords = state.records.filter((record) => {
    if (filterDate ? record.date !== filterDate : !record.date.startsWith(month)) return false;
    if (filterTag && recordInstitutionTag(record) !== filterTag) return false;
    if (filterCourseType && record.courseType !== filterCourseType) return false;
    return true;
  });
  renderStatNumbers(todayRecords, monthRecords, displayRecords);
  renderTodayRecords(todayRecords);
  renderPayrollTable(displayRecords);
}

function renderTagFilter() {
  const select = $("filterTag");
  const current = select.value;
  const tags = availableInstitutionTags();
  select.innerHTML = `<option value="">全部机构</option>` + tags.map((tag) => `<option value="${h(tag)}">${h(tag)}</option>`).join("");
  if (tags.includes(current)) select.value = current;
}

function renderStatNumbers(todayRecords, monthRecords, displayRecords) {
  const monthPayrollRows = payrollRowsFromRecords(monthRecords);
  const displayPayrollRows = payrollRowsFromRecords(displayRecords);
  const todayPayrollRows = payrollRowsFromRecords(todayRecords);
  const junengMonth = monthPayrollRows.filter((row) => row.owner === "聚能");
  const ownMonth = monthPayrollRows.filter((row) => row.owner === "自有");
  $("todayTotal").textContent = money(sum(todayRecords));
  $("todayCount").textContent = todayRecords.length;
  $("todayOneTotal").textContent = money(sum(todayRecords.filter((record) => record.courseType !== "classCourse")));
  $("todayClassTotal").textContent = money(sum(todayRecords.filter((record) => record.courseType === "classCourse")));
  $("statsTodayTotal").textContent = money(payrollRowsTotal(todayPayrollRows));
  $("statsMonthTotal").textContent = money(payrollRowsTotal(monthPayrollRows));
  $("statsTotal").textContent = money(payrollRowsTotal(displayPayrollRows));
  $("statsCount").textContent = displayRecords.length;
  $("oneTotal").textContent = money(payrollRowsTotal(junengMonth));
  $("classTotal").textContent = money(payrollRowsTotal(ownMonth));
  $("oneCount").textContent = `${junengMonth.reduce((total, row) => total + row.count, 0)} 次`;
  $("classCount").textContent = `${ownMonth.reduce((total, row) => total + row.count, 0)} 人次`;
}

function renderTodayRecords(records) {
  $("todayRecords").innerHTML = records.length ? records.map((record) => {
    const counts = attendanceCounts(normalizedAttendance(record));
    return `
      <article class="compact-item">
        <strong>${h(record.courseName || COURSE_TYPES[record.courseType])} ${money(record.amount)}</strong>
        <p>${h(record.grade)}｜到课 ${counts.present}｜请假 ${counts.leave}｜缺席 ${counts.absent}</p>
        <p>${h(record.priceSource)}</p>
        ${record.note ? `<p>${h(record.note)}</p>` : ""}
      </article>
    `;
  }).join("") : `<div class="empty">今天还没有记录。</div>`;
}

function renderPayrollTable(records) {
  const rows = payrollRowsFromRecords(records);
  $("recordTable").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td>${h(row.dateText)}</td>
      <td>${h(row.owner)}</td>
      <td>${h(row.target)}</td>
      <td>${h(row.courseName)}</td>
      <td>${h(row.typeText)}</td>
      <td><strong>${row.count}</strong></td>
      <td><strong>${money(row.amount)}</strong></td>
      <td>${h(row.note || "")}</td>
    </tr>
  `).join("") : `<tr><td colspan="8">暂无发工资数据。</td></tr>`;
}

function payrollRowsFromRecords(records) {
  const groups = new Map();
  records.forEach((record) => {
    if (recordInstitutionTag(record) === "聚能") {
      const key = ["聚能", "聚能", record.classId || record.className || record.courseName, record.courseType, record.grade].join("|");
      addPayrollItem(groups, key, {
        owner: "聚能",
        target: "聚能",
        courseName: payrollCourseName(record),
        typeText: COURSE_TYPES[record.courseType] || "",
        date: record.date,
        amount: recordSettlementAmount(record),
        note: payrollRecordNote(record)
      });
      return;
    }
    recordPresentStudents(record).forEach((student) => {
      const studentKey = studentSettlementKey(student);
      const key = ["自有", studentKey, record.classId || record.className || record.courseName, record.courseType, record.grade].join("|");
      addPayrollItem(groups, key, {
        owner: "自有",
        target: student.name || record.courseName,
        courseName: payrollCourseName(record),
        typeText: COURSE_TYPES[record.courseType] || "",
        date: record.date,
        amount: settlementRecordAmountForMode(record, "ownStudent", studentKey),
        note: payrollRecordNote(record, student)
      });
    });
  });
  return Array.from(groups.values()).map((group) => {
    const dates = Array.from(group.dates).sort();
    return {
      owner: group.owner,
      target: group.target,
      courseName: group.courseName,
      typeText: group.typeText,
      count: group.count,
      amount: group.amount,
      note: Array.from(group.notes).join("；"),
      dateText: dates.length === 1 ? dates[0] : `${dates[0]} 至 ${dates[dates.length - 1]}`
    };
  }).sort((a, b) => {
    if (a.owner !== b.owner) return a.owner === "聚能" ? -1 : 1;
    return a.target.localeCompare(b.target, "zh-CN") || a.courseName.localeCompare(b.courseName, "zh-CN");
  });
}

function addPayrollItem(groups, key, item) {
  if (!groups.has(key)) {
    groups.set(key, {
      owner: item.owner,
      target: item.target,
      courseName: item.courseName,
      typeText: item.typeText,
      count: 0,
      amount: 0,
      dates: new Set(),
      notes: new Set()
    });
  }
  const group = groups.get(key);
  group.count += 1;
  group.amount += Number(item.amount || 0);
  group.dates.add(item.date);
  if (item.note) group.notes.add(item.note);
}

function payrollCourseName(record) {
  if (record.courseType === "classCourse") return record.className || record.courseName || "班课";
  return record.courseName || attendanceNames(record, "present") || "个人课";
}

function payrollRecordNote(record, student = null) {
  const notes = [];
  if (record.note) notes.push(record.note);
  const leaveNames = attendanceNames(record, "leave");
  const absentNames = attendanceNames(record, "absent");
  if (leaveNames) notes.push(`请假：${leaveNames}`);
  if (absentNames) notes.push(`缺席：${absentNames}`);
  if (student && record.courseType !== "oneToOne") notes.push(`本次到课：${student.name}`);
  return notes.join("；");
}

function payrollRowsTotal(rows) {
  return rows.reduce((total, row) => total + Number(row.amount || 0), 0);
}

function groupRecordsForStats(records) {
  const groups = new Map();
  records.forEach((record) => {
    const tag = recordInstitutionTag(record);
    const key = `${tag}|${record.templateId || `${record.courseName || ""}|${record.courseType}|${record.grade}|${record.className || ""}`}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return Array.from(groups.values()).map((items) => {
    const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));
    const dates = [...new Set(sorted.map((record) => record.date))].sort();
    return {
      records: sorted,
      count: sorted.length,
      totalAmount: sum(sorted),
      allConfirmed: sorted.every((record) => record.confirmed),
      institutionTag: recordInstitutionTag(sorted[0]),
      dateText: dates.length === 1 ? dates[0] : `${dates[0]} 至 ${dates[dates.length - 1]}`
    };
  }).sort((a, b) => {
    if (a.allConfirmed !== b.allConfirmed) return a.allConfirmed ? 1 : -1;
    return b.records[0].date.localeCompare(a.records[0].date);
  });
}

function exportCurrentMonthCsv() {
  const month = $("filterMonth").value || currentMonth();
  const filterDate = $("filterDate").value;
  const filterTag = $("filterTag").value;
  const filterCourseType = $("filterCourseType").value;
  const records = state.records.filter((record) => {
    if (filterDate ? record.date !== filterDate : !record.date.startsWith(month)) return false;
    if (filterTag && recordInstitutionTag(record) !== filterTag) return false;
    if (filterCourseType && record.courseType !== filterCourseType) return false;
    return true;
  });
  const headers = ["日期范围", "归属", "结算对象", "班级/个人", "一对几", "次数", "总金额", "备注"];
  const rows = payrollRowsFromRecords(records).map((row) => [
    row.dateText,
    row.owner,
    row.target,
    row.courseName,
    row.typeText,
    row.count,
    row.amount,
    row.note
  ]);
  downloadBlob("\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n"), `${filterDate || month}-发工资表.csv`, "text/csv;charset=utf-8");
}

function exportJsonBackup() {
  downloadBlob(JSON.stringify(state, null, 2), `工资统计备份-${today()}.json`, "application/json;charset=utf-8");
}

function importJsonBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!confirm("导入备份会替换当前浏览器里的本地数据，确定继续吗？")) return;
      state = migrateState({
        students: data.students || [],
        classes: data.classes || [],
        courseTemplates: data.courseTemplates || [],
        records: data.records || [],
        settlements: data.settlements || [],
        mainIncomes: data.mainIncomes || data.salaryEntries || [],
        settings: data.settings || { standards: clone(DEFAULT_STANDARDS), defaultSmallExtra: 10 }
      });
      activeTemplate = null;
      lessonAttendance = [];
      saveState();
      resetLessonForm(today());
      alert("备份已导入。");
    } catch {
      alert("备份文件格式不正确。");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file, "utf-8");
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function renderSettings() {
  $("standardsTable").innerHTML = GRADES.map((grade) => `
    <tr>
      <td>${grade}</td>
      <td><input data-grade="${grade}" data-type="oneToOne" type="number" min="0" step="1" value="${state.settings.standards[grade].oneToOne}"></td>
      <td><input data-grade="${grade}" data-type="oneToTwo" type="number" min="0" step="1" value="${state.settings.standards[grade].oneToTwo}"></td>
      <td><input data-grade="${grade}" data-type="oneToThree" type="number" min="0" step="1" value="${state.settings.standards[grade].oneToThree ?? state.settings.standards[grade].oneToTwo}"></td>
      <td><input data-grade="${grade}" data-type="oneToFour" type="number" min="0" step="1" value="${state.settings.standards[grade].oneToFour ?? state.settings.standards[grade].oneToThree ?? state.settings.standards[grade].oneToTwo}"></td>
      <td><input data-grade="${grade}" data-type="classBase" type="number" min="0" step="1" value="${state.settings.standards[grade].classBase ?? state.settings.standards[grade].oneToTwo}"></td>
    </tr>
  `).join("");
  $("defaultSmallExtra").value = state.settings.defaultSmallExtra ?? 10;
}

function saveStandards() {
  const standards = clone(state.settings.standards);
  $("standardsTable").querySelectorAll("input").forEach((input) => {
    standards[input.dataset.grade][input.dataset.type] = Number(input.value || 0);
  });
  state.settings.standards = standards;
  state.settings.defaultSmallExtra = Number($("defaultSmallExtra").value || 10);
  saveState();
  alert("工资标准已保存，历史记录金额不会自动改变。");
}

function resetStandards() {
  if (!confirm("确定恢复默认工资标准吗？")) return;
  state.settings.standards = clone(DEFAULT_STANDARDS);
  state.settings.defaultSmallExtra = 10;
  saveState();
}

function getStudent(id) {
  return state.students.find((student) => student.id === id);
}

function getClass(id) {
  return state.classes.find((classItem) => classItem.id === id);
}

function normalizedAttendance(record) {
  if (Array.isArray(record.attendance) && record.attendance.length) return record.attendance;
  return (record.studentIds || []).map((id) => ({ studentId: id, name: getStudent(id)?.name || "已删除学生", status: "present" }));
}

function recordPresentStudents(record) {
  return normalizedAttendance(record).filter((item) => item.status === "present");
}

function studentSettlementKey(student) {
  return student.studentId || student.name || "";
}

function attendanceCounts(attendance) {
  return attendance.reduce((counts, item) => {
    counts[item.status] += 1;
    return counts;
  }, { present: 0, leave: 0, absent: 0 });
}

function attendanceNames(record, status) {
  return normalizedAttendance(record).filter((item) => item.status === status).map((item) => item.name).join("、");
}

function sum(records) {
  return records.reduce((total, record) => total + Number(record.amount || 0), 0);
}

function recordSettlementAmount(record) {
  if (record.settlementAmount !== null && record.settlementAmount !== undefined) return Number(record.settlementAmount || 0);
  const classItem = record.courseType === "classCourse" ? getClass(record.classId) : null;
  if (classItem?.settlementMode === "perHead") {
    const price = Number(classItem.settlementPerStudent || 0);
    const presentCount = normalizedAttendance(record).filter((item) => item.status === "present").length;
    return presentCount * price;
  }
  return Number(record.amount || 0);
}

function recordSettlementSource(record) {
  if (record.settlementSource) return record.settlementSource;
  const classItem = record.courseType === "classCourse" ? getClass(record.classId) : null;
  if (classItem?.settlementMode === "perHead") {
    const price = Number(classItem.settlementPerStudent || 0);
    const presentCount = normalizedAttendance(record).filter((item) => item.status === "present").length;
    return `按人头收费：到课 ${presentCount} 人 × ${price} 元`;
  }
  return "按本次工资金额结算";
}

function settlementRecordAmountForMode(record, mode, targetId) {
  if (mode !== "ownStudent") return recordSettlementAmount(record);
  const present = recordPresentStudents(record);
  const targetIncluded = present.some((item) => studentSettlementKey(item) === targetId);
  if (!targetIncluded) return 0;
  const perHeadMatch = /×\s*(\d+(?:\.\d+)?)\s*元/.exec(recordSettlementSource(record));
  if (perHeadMatch) return Number(perHeadMatch[1] || 0);
  return present.length ? recordSettlementAmount(record) / present.length : recordSettlementAmount(record);
}

function settlementRecordsAmount(records, mode, targetId) {
  return records.reduce((total, record) => total + settlementRecordAmountForMode(record, mode, targetId), 0);
}

function markRecordSettled(record, mode, targetId, settlementId) {
  if (mode === "ownStudent") {
    record.studentSettlementIds = { ...(record.studentSettlementIds || {}), [targetId]: settlementId };
    record.confirmed = isRecordFullySettled(record);
    return;
  }
  record.settlementId = settlementId;
  record.confirmed = true;
}

function isRecordFullySettled(record) {
  if (record.settlementId) return true;
  if (recordInstitutionTag(record) === "聚能") return false;
  const present = recordPresentStudents(record);
  return present.length > 0 && present.every((student) => record.studentSettlementIds?.[studentSettlementKey(student)]);
}

function recordPendingSettlementAmount(record) {
  if (record.settlementId) return 0;
  if (recordInstitutionTag(record) === "聚能") return recordSettlementAmount(record);
  return recordPresentStudents(record).reduce((total, student) => {
    const key = studentSettlementKey(student);
    return record.studentSettlementIds?.[key] ? total : total + settlementRecordAmountForMode(record, "ownStudent", key);
  }, 0);
}

function sumPendingSettlement(records) {
  return records.reduce((total, record) => total + recordPendingSettlementAmount(record), 0);
}

function sumSettlement(records) {
  return records.reduce((total, record) => total + recordSettlementAmount(record), 0);
}

function availableInstitutionTags() {
  return [...new Set([
    ...state.students.map((student) => student.institutionTag),
    ...state.classes.map((classItem) => classItem.institutionTag),
    ...state.records.map((record) => recordInstitutionTag(record))
  ].map(normalizeTag).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function recordInstitutionTag(record) {
  const savedTag = normalizeTag(record.institutionTag);
  if (savedTag) return savedTag;
  const classTag = normalizeTag(getClass(record.classId)?.institutionTag);
  if (classTag) return classTag;
  const template = state.courseTemplates.find((item) => item.id === record.templateId);
  if (template?.courseType === "classCourse") return normalizeTag(getClass(template.classId)?.institutionTag);
  const studentId = (template?.studentIds || record.studentIds || normalizedAttendance(record).map((item) => item.studentId)).filter(Boolean)[0];
  return normalizeTag(getStudent(studentId)?.institutionTag);
}

function updateHeaderTotal() {
  $("headerMonthTotal").textContent = money(sum(state.records.filter((record) => record.date.startsWith(currentMonth()))));
}

window.selectLessonTemplate = selectLessonTemplate;
window.cycleAttendance = cycleAttendance;
window.editLesson = editLesson;
window.deleteLesson = deleteLesson;
window.toggleRecordConfirmed = toggleRecordConfirmed;
window.toggleRecordGroupConfirmed = toggleRecordGroupConfirmed;
window.editTemplate = editTemplate;
window.deleteTemplate = deleteTemplate;
window.editStudent = editStudent;
window.deleteStudent = deleteStudent;
window.editClass = editClass;
window.deleteClass = deleteClass;
window.updateClassStudentName = updateClassStudentName;
window.updateClassStudentNote = updateClassStudentNote;
window.toggleClassStudent = toggleClassStudent;
window.deleteClassStudent = deleteClassStudent;
window.deleteSettlement = deleteSettlement;
window.editMainIncome = editMainIncome;
window.deleteMainIncome = deleteMainIncome;

init();
