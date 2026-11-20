import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, sendEmailVerification, updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  subscribeTasks, saveTask, setTaskStatus, removeTask, restoreTask,
  permanentlyDeleteTask, setTaskFavorite, saveTaskItems, duplicateTaskDraft,
  uploadTaskAttachment, deleteTaskAttachments, validateTaskAttachment,
  ensureTasksMigrated, subscribeGroups, subscribeAssignedTasks, saveGroup, deleteGroup,
  subscribeSettings, saveSettings, subscribeActivities, addActivity, subscribeNotificationLogs
} from "./tasks.js";
import {
  asDate, calendarTaskRange, dateFromKey, dateKey, dayOrdinal,
  getCalendarDays, shiftTaskSchedule, startOfDay
} from "./calendar-utils.mjs";
import {
  buildDateRangeReport, getCategoryStats, getDashboardMetrics, getProgressBuckets, taskProgress
} from "./report-utils.mjs";
import { buildExcelXmlWorkbook } from "./report-export.mjs";
import { createTelegramLink } from "./telegram.js";
import { showToast, formatDate, toDateTimeLocal, renderTaskList } from "./ui.js";

const $ = id => document.getElementById(id);
let currentUser = null, tasks = [], ownedTasks = [], assignedTasks = [], groups = [];
let tasksUnsubscribe = null, assignedTasksUnsubscribe = null, groupsUnsubscribe = null;
let activities = [], userSettings = null, settingsUnsubscribe = null, activitiesUnsubscribe = null;
let settingsFormUserUid = null;
let notificationLogs = [], notificationLogsUnsubscribe = null;
let telegramAccount = { chatId: null, pendingExpiresAt: null };
let telegramPendingUrl = "";
let settingsHolidayDraft = [];
let authMode = "login", activeView = "dashboard", activeFilter = "all", activeCategory = null, activeGroup = null;
let dueNotificationTimer = null, dueNotificationUid = null, notificationAudio = null;
let calendarMode = "week", calendarDate = new Date(), calendarDraggingTaskId = null, calendarDragSourceDate = null;
let progressChartMode="week", currentReport=null;
const notifiedDueTasks = new Set();
let taskAttachmentDraft = [], pendingAttachmentFiles = [], removedTaskAttachments = [];
const MAX_TASK_ATTACHMENTS = 10;
let userRole = "user", collaborationTask = null, editingTaskOwnerUid = null, adminTargetUser = null;

const views = ["dashboard","tasks","calendar","today","upcoming","favorites","trash","settings"];
const titles = {
  dashboard:"Tổng quan",tasks:"Tất cả công việc",calendar:"Lịch & kế hoạch",today:"Hôm nay",
  upcoming:"Sắp tới",favorites:"Yêu thích",trash:"Thùng rác",settings:"Cài đặt hệ thống"
};
const DEFAULT_SETTINGS = {
  theme:"light",accentColor:"#2563eb",workStart:"09:00",workEnd:"17:00",
  daysOff:[0,6],holidays:[],defaultReminderMinutes:0
};

$("todayLabel").textContent = new Intl.DateTimeFormat("vi-VN",{weekday:"long",day:"numeric",month:"long"}).format(new Date()).toUpperCase();
$("currentDate").textContent = new Intl.DateTimeFormat("vi-VN",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date());
$("linkTelegramBtn").href = createTelegramLink();
const reportToday = new Date();
$("reportStartDate").value = dateKey(new Date(reportToday.getFullYear(), reportToday.getMonth(), 1));
$("reportEndDate").value = dateKey(reportToday);
userSettings = { ...DEFAULT_SETTINGS, daysOff:[...DEFAULT_SETTINGS.daysOff], holidays:[] };

function normalizeSettings(value = {}) {
  const isTime = time => typeof time==="string"&&/^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const toList = list => {
    if(Array.isArray(list))return list;
    if(typeof list==="string")return list?list.split(","):[];
    if(list&&typeof list==="object"){
      const entries=Object.entries(list);
      return entries.length&&entries.every(([,entry])=>entry===true)
        ? entries.map(([key])=>key)
        : entries.map(([,entry])=>entry);
    }
    return null;
  };
  const rawHolidays=toList(value.holidays);
  const rawDaysOff=toList(value.daysOff);
  const holidays = [...new Set((rawHolidays||[]).filter(date=>
    typeof date==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&dateKey(dateFromKey(date))===date
  ))];
  return {
    theme:value.theme==="dark"?"dark":"light",
    accentColor:typeof value.accentColor==="string"&&/^#[0-9a-f]{6}$/i.test(value.accentColor)
      ? value.accentColor
      : DEFAULT_SETTINGS.accentColor,
    workStart:isTime(value.workStart)?value.workStart:DEFAULT_SETTINGS.workStart,
    workEnd:isTime(value.workEnd)?value.workEnd:DEFAULT_SETTINGS.workEnd,
    daysOff:rawDaysOff
      ? [...new Set(rawDaysOff.map(Number).filter(day=>Number.isInteger(day)&&day>=0&&day<=6))]
      : [...DEFAULT_SETTINGS.daysOff],
    holidays,
    defaultReminderMinutes:[0,5,15,30,60].includes(Number(value.defaultReminderMinutes))
      ? Number(value.defaultReminderMinutes)
      : DEFAULT_SETTINGS.defaultReminderMinutes
  };
}

async function callAuthenticatedApi(path, body) {
  if (!auth.currentUser) throw new Error("Hãy đăng nhập lại để tiếp tục.");
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Máy chủ trả về phản hồi không hợp lệ.");
  }
  if (!response.ok) throw new Error(result.error || "Yêu cầu không thành công.");
  return result;
}

function renderUserRole() {
  $("profileRole").textContent = userRole === "admin" ? "Admin" : "User";
  $("adminUsersPanel").classList.toggle("hidden", userRole !== "admin");
}

function renderProfileForm(user, profile = {}) {
  const displayName = profile.displayName || user.displayName || user.email?.split("@")[0] || "";
  $("profileDisplayName").value = displayName;
  $("profileEmail").value = user.email || "";
  $("userEmail").textContent = displayName || user.email || "Tài khoản";
  $("userAvatar").textContent = (displayName || user.email || "U").charAt(0).toUpperCase();
  renderUserRole();
}

function formatCollaborationTime(value) {
  const date = asDate(value);
  return date ? new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" }).format(date) : "";
}

function renderCollaboration(data) {
  const task = collaborationTask;
  const canManage = Boolean(task && (task.ownerUid === currentUser?.uid || userRole === "admin"));
  $("collaborationManageSection").classList.toggle("hidden", !canManage);
  $("collaborationProgressSection").classList.toggle("hidden", !task?.sharedReadOnly);
  $("collaborationAccessNote").textContent = task?.sharedReadOnly
    ? "Bạn có thể cập nhật tiến độ cá nhân và bình luận. Nội dung chính do chủ công việc quản lý."
    : "Thành viên được giao có thể cập nhật tiến độ riêng và trao đổi trong phần bình luận.";

  const membersContainer = $("collaborationMembers");
  membersContainer.replaceChildren();
  const members = [...(data.members || [])].sort((a, b) =>
    String(a.displayName || a.email).localeCompare(String(b.displayName || b.email), "vi")
  );
  if (!members.length && canManage) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Chưa giao công việc cho thành viên nào.";
    membersContainer.append(empty);
  }
  members.forEach(member => {
    const row = document.createElement("div");
    row.className = "collaboration-member";
    const identity = document.createElement("div");
    identity.className = "collaboration-member-identity";
    const name = document.createElement("strong");
    name.textContent = member.displayName || member.email || "Thành viên";
    const email = document.createElement("span");
    email.textContent = member.email || "";
    const progress = document.createElement("div");
    progress.className = "collaboration-member-progress";
    const progressBar = document.createElement("progress");
    progressBar.max = 100;
    progressBar.value = Number(data.progress?.[member.uid]?.percent ?? member.progressPercent) || 0;
    const progressLabel = document.createElement("span");
    progressLabel.textContent = `${progressBar.value}%`;
    progress.append(progressBar, progressLabel);
    identity.append(name, email, progress);
    const progressNote = data.progress?.[member.uid]?.note;
    if (progressNote) {
      const note = document.createElement("small");
      note.className = "collaboration-progress-note";
      note.textContent = progressNote;
      identity.append(note);
    }
    row.append(identity);
    if (canManage) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "text-button danger-text";
      remove.textContent = "Gỡ";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await callAuthenticatedApi("/api/task-collaboration", {
            action: "removeMember",
            ownerUid: task.ownerUid,
            taskId: task.id,
            memberUid: member.uid
          });
          showToast("Đã gỡ thành viên khỏi công việc.");
          await loadCollaboration();
        } catch (error) {
          showToast("Không gỡ được thành viên: " + error.message);
          remove.disabled = false;
        }
      });
      row.append(remove);
    }
    membersContainer.append(row);
  });

  const viewerProgress = data.viewerProgress || {};
  $("memberProgressRange").value = String(Number(viewerProgress.percent) || 0);
  $("memberProgressValue").textContent = `${$("memberProgressRange").value}%`;
  $("memberProgressNote").value = viewerProgress.note || "";

  const commentsContainer = $("collaborationComments");
  commentsContainer.replaceChildren();
  if (!(data.comments || []).length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Chưa có bình luận nào.";
    commentsContainer.append(empty);
    return;
  }
  data.comments.forEach(comment => {
    const item = document.createElement("article");
    item.className = "collaboration-comment";
    const heading = document.createElement("div");
    heading.className = "collaboration-comment-heading";
    const author = document.createElement("strong");
    author.textContent = comment.displayName || "Người dùng";
    const time = document.createElement("time");
    time.textContent = formatCollaborationTime(comment.createdAt);
    const text = document.createElement("p");
    text.textContent = comment.text || "";
    heading.append(author, time);
    item.append(heading, text);
    commentsContainer.append(item);
  });
}

async function loadCollaboration() {
  if (!collaborationTask || !currentUser) return;
  const selectedTask = collaborationTask;
  try {
    const data = await callAuthenticatedApi("/api/task-collaboration", {
      action: "list",
      ownerUid: selectedTask.ownerUid || currentUser.uid,
      taskId: selectedTask.id
    });
    if (collaborationTask === selectedTask) renderCollaboration(data);
  } catch (error) {
    showToast("Không tải được thông tin cộng tác: " + error.message);
  }
}

async function openCollaboration(task) {
  if (!currentUser) return;
  collaborationTask = {
    ...task,
    ownerUid: task.ownerUid || currentUser.uid
  };
  $("collaborationTaskTitle").textContent = task.title || "Cộng tác công việc";
  $("collaborationMembers").replaceChildren();
  $("collaborationComments").replaceChildren();
  $("collaborationMemberEmail").value = "";
  $("collaborationCommentText").value = "";
  if (!$("collaborationDialog").open) $("collaborationDialog").showModal();
  await loadCollaboration();
}

function applyUserSettings() {
  document.documentElement.dataset.theme=userSettings.theme;
  document.documentElement.style.setProperty("--blue",userSettings.accentColor);
}

function renderHolidayList() {
  const list=$("holidayList");
  list.replaceChildren();
  settingsHolidayDraft.forEach(date=>{
    const row=document.createElement("div");
    row.className="holiday-item";
    const label=document.createElement("span");
    label.textContent=formatCalendarDate(dateFromKey(date),{weekday:"short",day:"numeric",month:"short",year:"numeric"});
    const remove=document.createElement("button");
    remove.type="button";
    remove.className="icon-button";
    remove.textContent="×";
    remove.setAttribute("aria-label",`Xóa ngày nghỉ ${label.textContent}`);
    remove.addEventListener("click",()=>{
      settingsHolidayDraft=settingsHolidayDraft.filter(item=>item!==date);
      renderHolidayList();
    });
    row.append(label,remove);
    list.append(row);
  });
}

function renderSettingsForm() {
  $("settingTheme").value=userSettings.theme;
  $("settingAccentColor").value=userSettings.accentColor;
  $("settingWorkStart").value=userSettings.workStart;
  $("settingWorkEnd").value=userSettings.workEnd;
  $("settingReminderDefault").value=String(userSettings.defaultReminderMinutes);
  document.querySelectorAll('input[name="daysOff"]').forEach(input=>{
    input.checked=userSettings.daysOff.includes(Number(input.value));
  });
  settingsHolidayDraft=[...userSettings.holidays];
  renderHolidayList();
}

function renderProgressChart(tasks, referenceDate) {
  const chart = $("progressChart");
  chart.replaceChildren();
  chart.setAttribute("aria-label", progressChartMode === "week"
    ? "Biểu đồ công việc mới và hoàn thành trong tuần hiện tại"
    : "Biểu đồ công việc mới và hoàn thành trong tháng hiện tại");
  const buckets = getProgressBuckets(tasks, progressChartMode, referenceDate);
  chart.style.gridTemplateColumns = `repeat(${buckets.length}, minmax(0, 1fr))`;
  const maxValue = Math.max(1, ...buckets.flatMap(bucket => [bucket.created, bucket.completed]));
  buckets.forEach(bucket => {
    const column = document.createElement("div");
    column.className = "progress-chart-column";
    column.title = `${bucket.label}: ${bucket.created} mới, ${bucket.completed} hoàn thành`;
    const bars = document.createElement("div");
    bars.className = "progress-chart-bars";
    for (const [type, count] of [["created", bucket.created], ["completed", bucket.completed]]) {
      const barWrap = document.createElement("div");
      barWrap.className = "progress-chart-bar-wrap";
      const value = document.createElement("span");
      value.className = "progress-chart-value";
      value.textContent = String(count);
      const track = document.createElement("div");
      track.className = "progress-chart-track";
      const bar = document.createElement("i");
      bar.className = `progress-chart-bar ${type}`;
      bar.style.height = `${count ? Math.max(4, count / maxValue * 100) : 0}%`;
      bar.setAttribute("aria-hidden", "true");
      track.append(bar);
      barWrap.append(value, track);
      bars.append(barWrap);
    }
    const label = document.createElement("span");
    label.className = "progress-chart-label";
    label.textContent = bucket.label;
    column.append(bars, label);
    chart.append(column);
  });
}

function renderCategoryStats(tasks) {
  const container = $("categoryStats");
  container.replaceChildren();
  const categories = getCategoryStats(tasks);
  if (!categories.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Chưa có dữ liệu danh mục.";
    container.append(empty);
    return;
  }
  categories.forEach(category => {
    const row = document.createElement("div");
    row.className = "category-stat";
    const heading = document.createElement("div");
    heading.className = "category-stat-heading";
    const name = document.createElement("strong");
    name.textContent = category.name;
    const count = document.createElement("span");
    count.textContent = `${category.completed}/${category.total}`;
    heading.append(name, count);
    const track = document.createElement("div");
    track.className = "category-stat-track";
    const fill = document.createElement("i");
    fill.style.width = `${category.total ? category.completed / category.total * 100 : 0}%`;
    track.append(fill);
    const caption = document.createElement("small");
    caption.textContent = `${category.total} công việc · ${category.total ? Math.round(category.completed / category.total * 100) : 0}% hoàn thành`;
    row.append(heading, track, caption);
    container.append(row);
  });
}

function reportStatus(task) {
  if (task.status === "completed") return "Đã hoàn thành";
  return taskProgress(task) > 0 ? "Đang thực hiện" : "Chưa làm";
}

function reportDateLabel(value) {
  const date = asDate(value);
  return date ? new Intl.DateTimeFormat("vi-VN", { dateStyle: "short" }).format(date) : "—";
}

function renderReportTable(report) {
  const container = $("reportTable");
  container.replaceChildren();
  if (!report.tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Không có công việc trong khoảng thời gian này.";
    container.append(empty);
    return;
  }
  const table = document.createElement("table");
  table.className = "report-table";
  const headers = ["Công việc", "Danh mục", "Ưu tiên", "Trạng thái", "Ngày tạo", "Đến hạn", "Hoàn thành"];
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach(text => {
    const th = document.createElement("th");
    th.textContent = text;
    headerRow.append(th);
  });
  thead.append(headerRow);
  const tbody = document.createElement("tbody");
  report.tasks.forEach(task => {
    const row = document.createElement("tr");
    const values = [
      task.title || "Công việc",
      task.category || "Khác",
      ({ high: "Cao", medium: "Trung bình", low: "Thấp" })[task.priority] || "Trung bình",
      reportStatus(task),
      reportDateLabel(task.createdAt),
      reportDateLabel(task.dueAt),
      reportDateLabel(task.completedAt || (task.status === "completed" ? task.updatedAt : null))
    ];
    values.forEach(text => {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    });
    tbody.append(row);
  });
  table.append(thead, tbody);
  container.append(table);
}

function renderDateRangeReport(tasks) {
  const startValue = $("reportStartDate").value;
  const endValue = $("reportEndDate").value;
  const report = startValue && endValue
    ? buildDateRangeReport(tasks, dateFromKey(startValue), dateFromKey(endValue))
    : null;
  currentReport = report;
  const summary = $("reportSummary");
  summary.replaceChildren();
  if (!report) {
    $("reportPeriodLabel").textContent = "Vui lòng chọn khoảng ngày hợp lệ.";
    $("reportTable").replaceChildren();
    return;
  }
  $("reportPeriodLabel").textContent = `Từ ${report.startKey} đến ${report.endKey}`;
  const cards = [
    ["Công việc đến hạn trong kỳ", report.dueInRange.length],
    ["Hoàn thành trong kỳ", report.completedInRange.length],
    ["Tạo mới trong kỳ", report.createdInRange.length],
    ["Quá hạn tại cuối kỳ", report.overdueAtEnd.length],
    ["Tỷ lệ hoàn thành đến cuối kỳ", report.completionRate == null ? "—" : `${report.completionRate}%`]
  ];
  cards.forEach(([label, value]) => {
    const card = document.createElement("article");
    card.className = "report-stat";
    const title = document.createElement("span");
    title.textContent = label;
    const number = document.createElement("strong");
    number.textContent = String(value);
    card.append(title, number);
    summary.append(card);
  });
  renderReportTable(report);
}

function renderDashboardAnalytics(activeTasks, now) {
  const metrics = getDashboardMetrics(activeTasks, now);
  $("statTotal").textContent = String(metrics.total);
  $("statDone").textContent = String(metrics.completed);
  $("statInProgress").textContent = String(metrics.inProgress);
  $("statToday").textContent = String(metrics.dueToday);
  $("statOverdue").textContent = String(metrics.overdue);
  $("chartWeekBtn").classList.toggle("active", progressChartMode === "week");
  $("chartMonthBtn").classList.toggle("active", progressChartMode === "month");
  renderProgressChart(activeTasks, now);
  renderCategoryStats(activeTasks);
  renderDateRangeReport(activeTasks);
}

function downloadReportFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportExcelReport() {
  if (!currentReport) {
    showToast("Hãy chọn khoảng ngày hợp lệ trước khi xuất báo cáo.");
    return;
  }
  const dueCategories = getCategoryStats(currentReport.dueInRange);
  const summaryRows = [
    ["Báo cáo công việc", "Task Manager"],
    ["Từ ngày", currentReport.startKey],
    ["Đến ngày", currentReport.endKey],
    ["Công việc đến hạn trong kỳ", currentReport.dueInRange.length],
    ["Hoàn thành trong kỳ", currentReport.completedInRange.length],
    ["Tạo mới trong kỳ", currentReport.createdInRange.length],
    ["Quá hạn tại cuối kỳ", currentReport.overdueAtEnd.length],
    ["Tỷ lệ hoàn thành đến cuối kỳ", currentReport.completionRate == null ? "Không có dữ liệu" : `${currentReport.completionRate}%`],
    [],
    ["Danh mục", "Tổng đến hạn", "Đã hoàn thành", "Tỷ lệ hoàn thành"],
    ...dueCategories.map(category => [
      category.name, category.total, category.completed,
      `${Math.round(category.completed / category.total * 100)}%`
    ])
  ];
  const taskRows = [
    ["Công việc", "Danh mục", "Ưu tiên", "Trạng thái", "Ngày tạo", "Đến hạn", "Hoàn thành", "Tiến độ (%)"],
    ...currentReport.tasks.map(task => [
      task.title || "Công việc",
      task.category || "Khác",
      ({ high: "Cao", medium: "Trung bình", low: "Thấp" })[task.priority] || "Trung bình",
      reportStatus(task),
      reportDateLabel(task.createdAt),
      reportDateLabel(task.dueAt),
      reportDateLabel(task.completedAt || (task.status === "completed" ? task.updatedAt : null)),
      taskProgress(task)
    ])
  ];
  const workbook = buildExcelXmlWorkbook([
    { name: "Tổng quan", rows: summaryRows },
    { name: "Công việc", rows: taskRows }
  ]);
  downloadReportFile(
    `bao-cao-cong-viec-${currentReport.startKey}-${currentReport.endKey}.xml`,
    workbook,
    "application/vnd.ms-excel;charset=utf-8"
  );
}

function renderTelegramAccount() {
  const linked=Boolean(telegramAccount.chatId);
  const anchor=$("telegramLinkAnchor");
  $("telegramLinkStatus").textContent=linked
    ? "Đã liên kết với tài khoản Telegram của bạn."
    : "Chưa liên kết. Tạo liên kết rồi nhấn Start trong bot.";
  $("unlinkTelegramBtn").classList.toggle("hidden",!linked);
  if(linked){
    telegramPendingUrl="";
    anchor.classList.add("hidden");
  }else if(telegramPendingUrl&&telegramAccount.pendingExpiresAt>Date.now()){
    anchor.href=telegramPendingUrl;
    anchor.classList.remove("hidden");
  }else{
    telegramPendingUrl="";
    anchor.classList.add("hidden");
  }
}

async function requestTelegramLink(action) {
  if(!auth.currentUser) throw new Error("Hãy đăng nhập lại để tiếp tục.");
  const token=await auth.currentUser.getIdToken();
  const response=await fetch("/api/telegram-link",{
    method:"POST",
    headers:{"content-type":"application/json",authorization:`Bearer ${token}`},
    body:JSON.stringify({action})
  });
  const result=await response.json();
  if(!response.ok) throw new Error(result.error||"Không thể cập nhật liên kết Telegram.");
  return result;
}

function renderActivityLog() {
  const list=$("activityList");
  list.replaceChildren();
  if(!activities.length){
    const empty=document.createElement("p");
    empty.className="empty-state";
    empty.textContent="Chưa có hoạt động nào.";
    list.append(empty);
    return;
  }
  activities.forEach(activity=>{
    const row=document.createElement("article");
    row.className="activity-item";
    const message=document.createElement("span");
    message.textContent=activity.message||"Hoạt động";
    const time=document.createElement("time");
    const date=asDate(activity.createdAt);
    if(date){
      time.dateTime=date.toISOString();
      time.textContent=formatCalendarDate(date,{dateStyle:"short",timeStyle:"short"});
    }
    row.append(message,time);
    list.append(row);
  });
}

function renderNotificationLog() {
  const list=$("notificationLogList");
  list.replaceChildren();
  if(!notificationLogs.length){
    const empty=document.createElement("p");
    empty.className="empty-state";
    empty.textContent="Chưa có thông báo nào được gửi.";
    list.append(empty);
    return;
  }
  const labels={
    before:"Nhắc trước hạn",due:"Đến hạn",overdue:"Quá hạn",
    report_morning:"Báo cáo đầu ngày",report_evening:"Báo cáo cuối ngày",
    telegram_action_done:"Hoàn thành từ Telegram",
    telegram_action_snooze1h:"Hoãn 1 giờ từ Telegram",
    telegram_action_tomorrow:"Hoãn đến ngày làm việc tiếp theo từ Telegram"
  };
  notificationLogs.forEach(log=>{
    const row=document.createElement("article");
    row.className="notification-log-item";
    const details=document.createElement("div");
    details.className="notification-log-details";
    const title=document.createElement("strong");
    title.textContent=log.taskTitle||labels[log.type]||"Thông báo";
    const description=document.createElement("span");
    description.textContent=labels[log.type]||log.type||"Thông báo";
    const time=document.createElement("time");
    const date=asDate(log.createdAt);
    if(date){
      time.dateTime=date.toISOString();
      time.textContent=formatCalendarDate(date,{dateStyle:"short",timeStyle:"short"});
    }
    const status=document.createElement("span");
    status.className=`notification-log-status ${log.status==="success"?"success":"failed"}`;
    status.textContent=log.status==="success"?"Đã gửi":"Thất bại";
    details.append(title,description);
    row.append(details,time,status);
    if(log.error){
      const error=document.createElement("small");
      error.className="notification-log-error";
      error.textContent=log.error;
      row.append(error);
    }
    list.append(row);
  });
}

async function recordActivity(message) {
  if(!currentUser)return;
  try {
    await addActivity(currentUser.uid,message);
  } catch(error) {
    console.error("Không ghi được nhật ký hoạt động:",error);
    showToast("Đã lưu thay đổi nhưng không ghi được nhật ký: "+error.message);
  }
}

function unlockNotificationAudio() {
  const AudioContextClass=window.AudioContext||window.webkitAudioContext;
  if(AudioContextClass&&!notificationAudio) notificationAudio=new AudioContextClass();
  if(notificationAudio?.state==="suspended"){
    notificationAudio.resume().catch(error=>console.error("Không bật được âm thanh thông báo:",error));
  }
}
document.addEventListener("pointerdown",unlockNotificationAudio,{once:true});
document.addEventListener("keydown",unlockNotificationAudio,{once:true});
document.addEventListener("visibilitychange",()=>{if(!document.hidden)checkDueNotifications();});

function playDueSound() {
  if(!notificationAudio||notificationAudio.state!=="running") return;
  const start=notificationAudio.currentTime;
  [880,1174,1568].forEach((frequency,index)=>{
    const oscillator=notificationAudio.createOscillator();
    const gain=notificationAudio.createGain();
    const time=start+index*0.16;
    oscillator.type="sine";
    oscillator.frequency.value=frequency;
    gain.gain.setValueAtTime(0.0001,time);
    gain.gain.exponentialRampToValueAtTime(0.18,time+0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001,time+0.14);
    oscillator.connect(gain);
    gain.connect(notificationAudio.destination);
    oscillator.start(time);
    oscillator.stop(time+0.15);
  });
}

function checkDueNotifications(initialScan = false) {
  clearTimeout(dueNotificationTimer);
  if(!currentUser) return;
  const now=Date.now();
  const dueTasks=tasks.map(task=>{
    if(task.deletedAt||task.status==="completed"||!task.dueAt) return false;
    const due=task.dueAt?.toDate?task.dueAt.toDate():new Date(task.dueAt);
    return Number.isNaN(due.getTime())?false:{task,due};
  }).filter(Boolean);
  let nextDue=Infinity;
  const newlyDue=[];
  for(const {task,due} of dueTasks){
    const key=`${currentUser.uid}:${task.id}:${due.getTime()}`;
    if(due.getTime()<=now){
      if(initialScan){notifiedDueTasks.add(key);continue;}
      if(notifiedDueTasks.has(key)) continue;
      notifiedDueTasks.add(key);
      newlyDue.push(task);
    }else{
      nextDue=Math.min(nextDue,due.getTime());
    }
  }
  if(newlyDue.length){
    showToast(newlyDue.length===1
      ? `Đến hạn: ${newlyDue[0].title||"Công việc"}`
      : `${newlyDue.length} công việc đã đến hạn.`);
    playDueSound();
  }
  if(Number.isFinite(nextDue)){
    dueNotificationTimer=setTimeout(
      ()=>checkDueNotifications(),
      Math.min(Math.max(0,nextDue-Date.now()),2_147_000_000)
    );
  }
}

$("toggleAuth").addEventListener("click", () => {
  authMode = authMode === "login" ? "register" : "login";
  $("authSubmit").textContent = authMode === "login" ? "Đăng nhập" : "Tạo tài khoản";
  $("toggleAuth").textContent = authMode === "login" ? "Chưa có tài khoản? Đăng ký" : "Đã có tài khoản? Đăng nhập";
  $("authMessage").textContent = "";
});
$("authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("authEmail").value.trim(), password = $("authPassword").value;
  $("authSubmit").disabled = true;
  try {
    if (authMode === "register") {
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, "users", credential.user.uid), {
        email,
        displayName: credential.user.displayName || email.split("@")[0],
        createdAt: serverTimestamp()
      }, { merge: true });
      await sendEmailVerification(credential.user);
      showToast("Tài khoản đã tạo. Hãy xác minh email để có thể được cấp quyền Admin.");
    } else await signInWithEmailAndPassword(auth, email, password);
  } catch (err) { $("authMessage").textContent = friendlyError(err); }
  finally { $("authSubmit").disabled = false; }
});
$("googleSignInBtn").addEventListener("click", async () => {
  const button = $("googleSignInBtn");
  button.disabled = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (error) {
    $("authMessage").textContent = friendlyError(error);
  } finally {
    button.disabled = false;
  }
});
$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, user => {
  currentUser = user;
  $("authView").classList.toggle("hidden", !!user);
  $("appView").classList.toggle("hidden", !user);
  if (tasksUnsubscribe) tasksUnsubscribe();
  if (assignedTasksUnsubscribe) assignedTasksUnsubscribe();
  if (groupsUnsubscribe) groupsUnsubscribe();
  if (settingsUnsubscribe) settingsUnsubscribe();
  if (activitiesUnsubscribe) activitiesUnsubscribe();
  if (notificationLogsUnsubscribe) notificationLogsUnsubscribe();
  tasks = [];
  ownedTasks = [];
  assignedTasks = [];
  groups = [];
  activities = [];
  notificationLogs = [];
  telegramAccount = { chatId:null, pendingExpiresAt:null };
  telegramPendingUrl = "";
  settingsFormUserUid = null;
  userRole = "user";
  renderUserRole();
  renderNotificationLog();
  renderTelegramAccount();
  activeGroup = null;
  if (!user) {
    userSettings = { ...DEFAULT_SETTINGS, daysOff:[...DEFAULT_SETTINGS.daysOff], holidays:[] };
    applyUserSettings();
    renderActivityLog();
    $("profileDisplayName").value = "";
    $("profileEmail").value = "";
    $("adminUserResult").replaceChildren();
    dueNotificationUid=null;
    notifiedDueTasks.clear();
    clearTimeout(dueNotificationTimer);
    return;
  }
  initializeUserSession(user);
});
function friendlyError(err) {
  const map = {
    "auth/email-already-in-use":"Email này đã được đăng ký.",
    "auth/invalid-email":"Email không hợp lệ.",
    "auth/weak-password":"Mật khẩu cần ít nhất 6 ký tự.",
    "auth/invalid-credential":"Email hoặc mật khẩu không chính xác.",
    "auth/network-request-failed":"Lỗi kết nối mạng. Vui lòng thử lại.",
    "auth/popup-closed-by-user":"Bạn đã đóng cửa sổ đăng nhập Google.",
    "auth/popup-blocked":"Trình duyệt đã chặn cửa sổ đăng nhập Google.",
    "auth/unauthorized-domain":"Tên miền hiện tại chưa được cho phép trong Firebase Authentication."
  };
  return map[err.code] || err.message || "Có lỗi xảy ra.";
}

async function initializeUserSession(user) {
  let resolvedRole = "user";
  try {
    const bootstrap = await callAuthenticatedApi("/api/bootstrap-admin", {});
    if (bootstrap.claimsUpdated) await user.getIdToken(true);
    const token = await user.getIdTokenResult();
    resolvedRole = token.claims.role === "admin" ? "admin" : "user";
  } catch (error) {
    try {
      resolvedRole = (await user.getIdTokenResult()).claims.role === "admin" ? "admin" : "user";
    } catch (tokenError) {
      console.error("Could not read the user's role claim:", tokenError);
    }
    if (currentUser?.uid === user.uid) {
      showToast("Không kiểm tra được quyền tài khoản: " + error.message);
    }
  }
  if (currentUser?.uid !== user.uid) return;
  userRole = resolvedRole;
  renderUserRole();

  let profile = {};
  try {
    const profileRef = doc(db, "users", user.uid);
    const snapshot = await getDoc(profileRef);
    profile = snapshot.data() || {};
    const displayName = profile.displayName || user.displayName || user.email?.split("@")[0] || "";
    await setDoc(profileRef, {
      email: user.email || null,
      displayName,
      photoURL: user.photoURL || profile.photoURL || null,
      ...(!profile.createdAt ? { createdAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp()
    }, { merge: true });
    profile = { ...profile, displayName, email: user.email || null };
  } catch (error) {
    showToast("Không tải được hồ sơ cá nhân: " + error.message);
  }
  if (currentUser?.uid !== user.uid) return;
  renderProfileForm(user, profile);
  try {
    const migration = await ensureTasksMigrated(user.uid);
    if (migration.copied) showToast(`Đã chuyển ${migration.copied} công việc cũ sang Realtime Database.`);
  } catch (error) {
    showToast("Không chuyển được dữ liệu cũ: " + error.message);
  }
  if (currentUser?.uid !== user.uid) return;

  settingsUnsubscribe = subscribeSettings(user.uid, data => {
    if(currentUser?.uid!==user.uid) return;
    const nextSettings=normalizeSettings(data);
    const settingsChanged=settingsFormUserUid!==user.uid||
      JSON.stringify(userSettings)!==JSON.stringify(nextSettings);
    userSettings = nextSettings;
    telegramAccount = {
      chatId:data.telegramChatId||null,
      pendingExpiresAt:Number(data.telegramPendingLinkExpiresAt)||null
    };
    applyUserSettings();
    if(settingsChanged) renderSettingsForm();
    settingsFormUserUid=user.uid;
    renderTelegramAccount();
    renderCalendar();
  }, err => showToast("Không tải được cài đặt: " + err.message));
  activitiesUnsubscribe = subscribeActivities(user.uid, data => {
    if(currentUser?.uid!==user.uid) return;
    activities = data;
    renderActivityLog();
  }, err => showToast("Không tải được nhật ký hoạt động: " + err.message));
  notificationLogsUnsubscribe = subscribeNotificationLogs(user.uid, data => {
    if(currentUser?.uid!==user.uid) return;
    notificationLogs=data;
    renderNotificationLog();
  }, err => showToast("Không tải được lịch sử gửi thông báo: " + err.message));
  groupsUnsubscribe = subscribeGroups(user.uid, data => {
    if(currentUser?.uid!==user.uid) return;
    groups = data;
    renderGroups();
    renderAll();
  }, err => showToast("Không tải được nhóm công việc: " + err.message));
  tasksUnsubscribe = subscribeTasks(user.uid, data => {
    if(currentUser?.uid!==user.uid) return;
    ownedTasks = data;
    mergeTaskCollections(true);
  }, err => showToast("Không tải được công việc: " + err.message));
  assignedTasksUnsubscribe = subscribeAssignedTasks(user.uid, data => {
    if(currentUser?.uid!==user.uid) return;
    assignedTasks = data;
    mergeTaskCollections(false);
  }, err => showToast("Không tải được công việc được giao: " + err.message));
}

function mergeTaskCollections(checkDue) {
  const unique = new Map();
  for (const task of [...ownedTasks, ...assignedTasks]) {
    unique.set(`${task.ownerUid || currentUser.uid}:${task.id}`, task);
  }
  tasks = [...unique.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  renderAll();
  if (checkDue && currentUser) {
    checkDueNotifications(dueNotificationUid !== currentUser.uid);
    dueNotificationUid = currentUser.uid;
  }
}

$("closeCollaborationDialog").addEventListener("click", () => {
  $("collaborationDialog").close();
});
$("collaborationDialog").addEventListener("close", () => {
  collaborationTask = null;
});
$("memberProgressRange").addEventListener("input", () => {
  $("memberProgressValue").textContent = `${$("memberProgressRange").value}%`;
});
$("collaborationMemberForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!collaborationTask) return;
  const button = $("collaborationMemberForm").querySelector("button");
  button.disabled = true;
  try {
    await callAuthenticatedApi("/api/task-collaboration", {
      action: "addMember",
      ownerUid: collaborationTask.ownerUid,
      taskId: collaborationTask.id,
      email: $("collaborationMemberEmail").value.trim()
    });
    $("collaborationMemberEmail").value = "";
    showToast("Đã giao công việc cho thành viên.");
    await loadCollaboration();
  } catch (error) {
    showToast("Không giao được công việc: " + error.message);
  } finally {
    button.disabled = false;
  }
});
$("saveMemberProgressBtn").addEventListener("click", async () => {
  if (!collaborationTask) return;
  const button = $("saveMemberProgressBtn");
  button.disabled = true;
  try {
    await callAuthenticatedApi("/api/task-collaboration", {
      action: "progress",
      ownerUid: collaborationTask.ownerUid,
      taskId: collaborationTask.id,
      percent: Number($("memberProgressRange").value),
      note: $("memberProgressNote").value.trim()
    });
    showToast("Đã cập nhật tiến độ cá nhân.");
    await loadCollaboration();
  } catch (error) {
    showToast("Không cập nhật được tiến độ: " + error.message);
  } finally {
    button.disabled = false;
  }
});
$("collaborationCommentForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!collaborationTask) return;
  const button = $("collaborationCommentForm").querySelector("button");
  button.disabled = true;
  try {
    await callAuthenticatedApi("/api/task-collaboration", {
      action: "comment",
      ownerUid: collaborationTask.ownerUid,
      taskId: collaborationTask.id,
      text: $("collaborationCommentText").value.trim()
    });
    $("collaborationCommentText").value = "";
    await loadCollaboration();
  } catch (error) {
    showToast("Không gửi được bình luận: " + error.message);
  } finally {
    button.disabled = false;
  }
});

$("profileForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!auth.currentUser) return;
  const displayName = $("profileDisplayName").value.trim();
  if (!displayName || displayName.length > 80) {
    showToast("Tên hiển thị phải có từ 1 đến 80 ký tự.");
    return;
  }
  const button = $("saveProfileBtn");
  button.disabled = true;
  try {
    await updateProfile(auth.currentUser, { displayName });
    await updateDoc(doc(db, "users", auth.currentUser.uid), {
      displayName,
      email: auth.currentUser.email || null,
      photoURL: auth.currentUser.photoURL || null,
      updatedAt: serverTimestamp()
    });
    renderProfileForm(auth.currentUser, { displayName });
    showToast("Đã cập nhật hồ sơ cá nhân.");
  } catch (error) {
    showToast("Không cập nhật được hồ sơ: " + error.message);
  } finally {
    button.disabled = false;
  }
});

$("adminUserSearchForm").addEventListener("submit", async event => {
  event.preventDefault();
  const resultElement = $("adminUserResult");
  resultElement.replaceChildren();
  try {
    adminTargetUser = await callAuthenticatedApi("/api/admin-users", {
      action: "lookup",
      email: $("adminUserEmail").value.trim()
    });
    const userLabel = document.createElement("p");
    userLabel.textContent = `${adminTargetUser.displayName || adminTargetUser.email} · ${adminTargetUser.email}`;
    const controls = document.createElement("div");
    controls.className = "admin-role-controls";
    const role = document.createElement("select");
    role.id = "adminUserRole";
    role.setAttribute("aria-label", "Vai trò người dùng");
    [["user", "User"], ["admin", "Admin"]].forEach(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      role.append(option);
    });
    role.value = adminTargetUser.role;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn secondary";
    save.textContent = "Lưu vai trò";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const updated = await callAuthenticatedApi("/api/admin-users", {
          action: "setRole",
          uid: adminTargetUser.uid,
          role: role.value
        });
        adminTargetUser.role = updated.role;
        if (adminTargetUser.uid === currentUser.uid) {
          await currentUser.getIdToken(true);
          userRole = updated.role;
          renderUserRole();
        }
        showToast(`Đã cập nhật vai trò thành ${updated.role === "admin" ? "Admin" : "User"}.`);
      } catch (error) {
        showToast("Không cập nhật được vai trò: " + error.message);
      } finally {
        save.disabled = false;
      }
    });
    controls.append(role, save);
    resultElement.append(userLabel, controls);
  } catch (error) {
    const message = document.createElement("p");
    message.className = "form-message";
    message.textContent = error.message;
    resultElement.append(message);
  }
});

$("chartWeekBtn").addEventListener("click", () => {
  progressChartMode = "week";
  $("chartWeekBtn").classList.add("active");
  $("chartMonthBtn").classList.remove("active");
  renderProgressChart(tasks.filter(task => !task.deletedAt), new Date());
});
$("chartMonthBtn").addEventListener("click", () => {
  progressChartMode = "month";
  $("chartMonthBtn").classList.add("active");
  $("chartWeekBtn").classList.remove("active");
  renderProgressChart(tasks.filter(task => !task.deletedAt), new Date());
});
$("reportFilterForm").addEventListener("submit", event => {
  event.preventDefault();
  const start = $("reportStartDate").value;
  const end = $("reportEndDate").value;
  if (!start || !end || start > end) {
    renderDateRangeReport(tasks);
    showToast("Khoảng thời gian không hợp lệ.");
    return;
  }
  renderDateRangeReport(tasks);
});
$("exportExcelBtn").addEventListener("click", exportExcelReport);
$("exportPdfBtn").addEventListener("click", () => {
  if (!currentReport) {
    showToast("Hãy chọn khoảng ngày hợp lệ trước khi xuất báo cáo.");
    return;
  }
  window.print();
});

function renderAll() {
  const now = new Date();
  const start = new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const end = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  const dateOf = t => t.dueAt?.toDate ? t.dueAt.toDate() : (t.dueAt ? new Date(t.dueAt) : null);
  const activeTasks = tasks.filter(t => !t.deletedAt);
  const trashedTasks = tasks.filter(t => t.deletedAt);
  const pending = activeTasks.filter(t => t.status !== "completed");
  const dueToday = pending.filter(t => { const d=dateOf(t); return d && d>=start && d<end; });
  renderDashboardAnalytics(activeTasks, now);

  const handlers = {
    toggle: async (t, checked) => {
      if (t.sharedReadOnly) return;
      try {
        await setTaskStatus(t.ownerUid || currentUser.uid,t.id,checked?"completed":"pending");
        if(checked&&["daily","weekly","monthly","yearly"].includes(t.recurrence)){
          showToast("Đã hoàn thành; công việc cho kỳ tiếp theo đã được tạo.");
        }
        await recordActivity(`${checked?"Hoàn thành":"Mở lại"} công việc: ${t.title}`);
      } catch(e){showToast(e.message);}
    },
    edit: t => t.sharedReadOnly ? openCollaboration(t) : openEditTask(t),
    collaborate: openCollaboration,
    remove: async t => {
      if (t.sharedReadOnly) return;
      if(confirm(`Chuyển "${t.title}" vào thùng rác?`)){
        try {
          await removeTask(t.ownerUid || currentUser.uid,t.id);
          showToast("Đã chuyển vào thùng rác.");
          await recordActivity(`Chuyển vào thùng rác: ${t.title}`);
        } catch(e){showToast(e.message);}
      }
    },
    favorite: async t => {
      if (t.sharedReadOnly) return;
      try {
        await setTaskFavorite(t.ownerUid || currentUser.uid,t.id,!t.favorite);
        await recordActivity(`${t.favorite?"Bỏ yêu thích":"Đánh dấu yêu thích"}: ${t.title}`);
      } catch(e){showToast(e.message);}
    },
    duplicate: t => openDuplicateTask(t),
    restore: async t => {
      try {
        await restoreTask(currentUser.uid,t.id);
        showToast("Đã khôi phục công việc.");
        await recordActivity(`Khôi phục công việc: ${t.title}`);
      } catch(e){showToast(e.message);}
    },
    deleteForever: async t => {
      if(confirm(`Xóa vĩnh viễn "${t.title}"? Không thể hoàn tác.`)){
        try {
          const cleanupFailures=await permanentlyDeleteTask(currentUser.uid,t.id);
          showToast(cleanupFailures.length
            ? `Chưa xóa được công việc vì không xóa được ${cleanupFailures.length} tệp. Hãy thử lại sau.`
            : "Đã xóa vĩnh viễn.");
          if(!cleanupFailures.length) await recordActivity(`Xóa vĩnh viễn: ${t.title}`);
        }
        catch(e){showToast(e.message);}
      }
    },
    toggleChecklist: async (t,itemId,checked) => {
      if (t.sharedReadOnly) return;
      const checklist=(t.checklist||[]).map(item=>item.id===itemId?{...item,completed:checked}:item);
      try {
        await saveTaskItems(t.ownerUid || currentUser.uid,t,checklist,t.subtasks||[]);
        await recordActivity(`${checked?"Hoàn thành":"Bỏ hoàn thành"} checklist trong: ${t.title}`);
      }
      catch(e){showToast("Không cập nhật được checklist: "+e.message);}
    },
    toggleSubtask: async (t,itemId,checked) => {
      if (t.sharedReadOnly) return;
      const subtasks=(t.subtasks||[]).map(item=>item.id===itemId?{...item,status:checked?"completed":"pending"}:item);
      try {
        await saveTaskItems(t.ownerUid || currentUser.uid,t,t.checklist||[],subtasks);
        await recordActivity(`${checked?"Hoàn thành":"Mở lại"} công việc con trong: ${t.title}`);
      }
      catch(e){showToast("Không cập nhật được công việc con: "+e.message);}
    }
  };
  const groupNames = new Map(groups.map(group => [group.id, group.name]));
  const withGroupNames = taskList => taskList.map(task => ({
    ...task,
    groupName: groupNames.get(task.groupId) || ""
  }));
  renderTaskList($("dashboardTasks"), withGroupNames([...pending].sort((a,b)=>(dateOf(a)||new Date(8640000000000000))-(dateOf(b)||new Date(8640000000000000))).slice(0,6)), handlers);
  let filtered = [...activeTasks];
  if (activeFilter === "pending") filtered = filtered.filter(t=>t.status!=="completed");
  if (activeFilter === "completed") filtered = filtered.filter(t=>t.status==="completed");
  if (activeCategory) filtered = filtered.filter(t=>t.category===activeCategory);
  if (activeGroup) filtered = filtered.filter(t=>t.groupId===activeGroup);
  const search = $("taskSearch").value.trim().toLowerCase();
  if(search) filtered=filtered.filter(t=>[
    t.title,t.description,t.notes,...(t.tags||[]).map(tag=>tag.name||tag.title)
  ].filter(Boolean).join(" ").toLowerCase().includes(search));
  renderTaskList($("allTasks"),withGroupNames(filtered),handlers);
  renderTaskList($("todayTasks"),withGroupNames(dueToday),handlers);
  renderTaskList($("upcomingTasks"),withGroupNames(pending.filter(t=>{const d=dateOf(t);return d&&d>=end;}).sort((a,b)=>dateOf(a)-dateOf(b))),handlers);
  renderTaskList($("favoriteTasks"),withGroupNames(activeTasks.filter(t=>t.favorite)),handlers);
  renderTaskList($("trashTasks"),withGroupNames(trashedTasks),handlers,{trash:true});
  renderCalendar();
}

function formatCalendarDate(date, options) {
  return new Intl.DateTimeFormat("vi-VN",options).format(date);
}

function calendarDays() {
  return getCalendarDays(calendarMode,calendarDate);
}

function renderCalendarTaskCard(task, sourceDate) {
  const card=document.createElement("button");
  card.type="button";
  card.className=`calendar-task priority-${task.priority||"medium"}`;
  if(task.status==="completed")card.classList.add("calendar-task-completed");
  const due=asDate(task.dueAt);
  if(task.status!=="completed"&&due&&due.getTime()<Date.now())card.classList.add("calendar-task-overdue");
  card.draggable=!task.sharedReadOnly;
  card.title=task.sharedReadOnly?"Nhấn để xem tiến độ và bình luận":"Kéo để đổi lịch · Nhấn để chỉnh sửa";
  const title=document.createElement("span");
  title.className="calendar-task-title";
  title.textContent=task.title||"(Không có tiêu đề)";
  const meta=document.createElement("small");
  const priorityLabels={high:"Cao",medium:"TB",low:"Thấp"};
  const time=due?formatCalendarDate(due,{hour:"2-digit",minute:"2-digit"}):"";
  meta.textContent=[time,priorityLabels[task.priority]||"TB"].filter(Boolean).join(" · ");
  card.append(title,meta);
  card.addEventListener("click",()=>task.sharedReadOnly?openCollaboration(task):openEditTask(task));
  card.addEventListener("dragstart",event=>{
    calendarDraggingTaskId=task.id;
    calendarDragSourceDate=sourceDate==="unscheduled"?"unscheduled":dateKey(sourceDate);
    event.dataTransfer.effectAllowed="move";
    event.dataTransfer.setData("text/plain",task.id);
    event.dataTransfer.setData("application/x-task-date",calendarDragSourceDate);
    card.classList.add("calendar-task-dragging");
  });
  card.addEventListener("dragend",()=>{
    calendarDraggingTaskId=null;
    calendarDragSourceDate=null;
    card.classList.remove("calendar-task-dragging");
  });
  return card;
}

async function moveTaskToCalendarDate(taskId, sourceDateKey, targetDate) {
  const task=tasks.find(item=>item.id===taskId);
  if(!task||task.deletedAt||task.sharedReadOnly||!currentUser)return;
  let schedule;
  if(sourceDateKey==="unscheduled"){
    if(asDate(task.startAt)||asDate(task.dueAt))return;
    const [hours,minutes]=userSettings.workEnd.split(":").map(Number);
    const dueAt=new Date(targetDate);
    dueAt.setHours(hours,minutes,0,0);
    schedule={startAt:null,dueAt};
  }else{
    schedule=shiftTaskSchedule(task,sourceDateKey,targetDate);
  }
  if(!schedule)return;
  const {id,ownerUid,sharedReadOnly,memberProgressPercent,...data}=task;
  try {
    await saveTask(task.ownerUid || currentUser.uid,{
      ...data,
      ...schedule,
      remindBeforeMinutes:sourceDateKey==="unscheduled"?userSettings.defaultReminderMinutes:data.remindBeforeMinutes,
      recurrenceAnchorDay:["monthly","yearly"].includes(data.recurrence)&&schedule.dueAt
        ? schedule.dueAt.getDate()
        : data.recurrenceAnchorDay,
      recurrenceAnchorMonth:data.recurrence==="yearly"&&schedule.dueAt
        ? schedule.dueAt.getMonth()
        : data.recurrenceAnchorMonth,
      reminderSentAt:null,
      preReminderSentAt:null
    },id);
    showToast("Đã cập nhật lịch công việc.");
    await recordActivity(`Đổi lịch công việc: ${task.title} → ${formatCalendarDate(targetDate,{day:"numeric",month:"short",year:"numeric"})}`);
  } catch(error) {
    showToast("Không thể đổi lịch: "+error.message);
  }
}

function renderCalendar() {
  const grid=$("calendarGrid");
  const days=calendarDays();
  const statusFilter=$("calendarStatusFilter").value;
  const priorityFilter=$("calendarPriorityFilter").value;
  const filteredTasks=tasks.filter(task=>{
    if(task.deletedAt)return false;
    if(statusFilter==="pending"&&task.status==="completed")return false;
    if(statusFilter==="completed"&&task.status!=="completed")return false;
    return priorityFilter==="all"||task.priority===priorityFilter;
  });
  const visibleTasks=filteredTasks.filter(task=>{
    const range=calendarTaskRange(task);
    return range&&days.some(day=>{
      const ordinal=dayOrdinal(day);
      return dayOrdinal(range.start)<=ordinal&&dayOrdinal(range.end)>=ordinal;
    });
  });
  const visibleIds=new Set(visibleTasks.map(task=>task.id));
  const today=startOfDay(new Date());
  const unscheduled=filteredTasks.filter(task=>!asDate(task.startAt)&&!asDate(task.dueAt));
  const overdue=filteredTasks.filter(task=>{
    const due=asDate(task.dueAt);
    return task.status!=="completed"&&due&&due.getTime()<Date.now();
  });

  if(calendarMode==="day"){
    $("calendarRange").textContent=formatCalendarDate(days[0],{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  }else if(calendarMode==="month"){
    $("calendarRange").textContent=formatCalendarDate(calendarDate,{month:"long",year:"numeric"});
  }else{
    const last=days[days.length-1];
    $("calendarRange").textContent=`${formatCalendarDate(days[0],{day:"numeric",month:"short"})} – ${formatCalendarDate(last,{day:"numeric",month:"short",year:"numeric"})}`;
  }
  $("calendarSummary").textContent=`${visibleIds.size} công việc trong ${calendarMode==="day"?"ngày":calendarMode==="week"?"tuần":"tháng"} này · ${visibleTasks.filter(task=>task.status==="completed").length} hoàn thành · ${overdue.length} quá hạn · Giờ làm ${userSettings.workStart}–${userSettings.workEnd}`;
  $("calendarUnscheduledCount").textContent=String(unscheduled.length);
  $("calendarUnscheduledTasks").replaceChildren();
  if(unscheduled.length){
    unscheduled.forEach(task=>$("calendarUnscheduledTasks").append(renderCalendarTaskCard(task,"unscheduled")));
  }else{
    const empty=document.createElement("p");
    empty.className="empty-state";
    empty.textContent="Không có công việc chưa xếp lịch.";
    $("calendarUnscheduledTasks").append(empty);
  }
  $("calendarOverdueCount").textContent=String(overdue.length);
  $("calendarOverdueTasks").replaceChildren();
  if(overdue.length){
    overdue.sort((a,b)=>(asDate(a.dueAt)||0)-(asDate(b.dueAt)||0))
      .forEach(task=>$("calendarOverdueTasks").append(renderCalendarTaskCard(task,asDate(task.dueAt)||today)));
  }else{
    const empty=document.createElement("p");
    empty.className="empty-state";
    empty.textContent="Không có công việc quá hạn.";
    $("calendarOverdueTasks").append(empty);
  }

  grid.className=`calendar-grid calendar-${calendarMode}`;
  grid.replaceChildren();
  const weekdays=["T2","T3","T4","T5","T6","T7","CN"];
  if(calendarMode!=="day"){
    weekdays.forEach(name=>{
      const heading=document.createElement("div");
      heading.className="calendar-weekday";
      heading.textContent=name;
      grid.append(heading);
    });
  }
  days.forEach(day=>{
    const cell=document.createElement("section");
    cell.className="calendar-day";
    if(day.getTime()===today.getTime())cell.classList.add("calendar-day-today");
    if(calendarMode==="month"&&day.getMonth()!==calendarDate.getMonth())cell.classList.add("calendar-day-outside");
    const isDayOff=userSettings.daysOff.includes(day.getDay())||userSettings.holidays.includes(dateKey(day));
    if(isDayOff)cell.classList.add("calendar-day-off");
    cell.dataset.date=dateKey(day);
    const heading=document.createElement("div");
    heading.className="calendar-day-heading";
    heading.textContent=calendarMode==="day"
      ? formatCalendarDate(day,{weekday:"long",day:"numeric",month:"long"})
      : String(day.getDate());
    cell.append(heading);
    if(isDayOff){
      const dayOffLabel=document.createElement("small");
      dayOffLabel.className="calendar-day-off-label";
      dayOffLabel.textContent=userSettings.holidays.includes(dateKey(day))?"Ngày nghỉ":"Nghỉ hằng tuần";
      cell.append(dayOffLabel);
    }
    filteredTasks.forEach(task=>{
      const range=calendarTaskRange(task);
      const ordinal=dayOrdinal(day);
      if(range&&dayOrdinal(range.start)<=ordinal&&dayOrdinal(range.end)>=ordinal){
        cell.append(renderCalendarTaskCard(task,day));
      }
    });
    cell.addEventListener("dragover",event=>{
      event.preventDefault();
      cell.classList.add("calendar-day-drag-over");
    });
    cell.addEventListener("dragleave",event=>{
      if(!cell.contains(event.relatedTarget))cell.classList.remove("calendar-day-drag-over");
    });
    cell.addEventListener("drop",event=>{
      event.preventDefault();
      cell.classList.remove("calendar-day-drag-over");
      const taskId=event.dataTransfer.getData("text/plain")||calendarDraggingTaskId;
      const source=event.dataTransfer.getData("application/x-task-date")||calendarDragSourceDate;
      if(taskId&&source)moveTaskToCalendarDate(taskId,source,day);
    });
    grid.append(cell);
  });
  document.querySelectorAll("[data-calendar-mode]").forEach(button=>{
    button.classList.toggle("active",button.dataset.calendarMode===calendarMode);
  });
}

function moveCalendarWindow(amount) {
  if(calendarMode==="month"){
    calendarDate=new Date(calendarDate.getFullYear(),calendarDate.getMonth()+amount,1);
  }else{
    calendarDate=new Date(calendarDate);
    calendarDate.setDate(calendarDate.getDate()+amount*(calendarMode==="week"?7:1));
  }
  renderCalendar();
}

function goView(view, preserveCategory = false) {
  activeView=view;
  if (!preserveCategory) {
    activeCategory=null;
    activeGroup=null;
    $("groupFilter").value="";
  }
  views.forEach(v=>$(`${v}View`).classList.toggle("hidden",v!==view));
  $("pageTitle").textContent=titles[view]||"Công việc";
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
}
document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>goView(b.dataset.view)));
document.querySelector("#addChecklistItem").addEventListener("click",()=>addEditorItem($("checklistEditor"),"checklist"));
document.querySelector("#addSubtaskItem").addEventListener("click",()=>addEditorItem($("subtaskEditor"),"subtask"));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>goView(b.dataset.goto)));
document.querySelectorAll(".filter-tab").forEach(b=>b.addEventListener("click",()=>{
  activeFilter=b.dataset.filter;
  document.querySelectorAll(".filter-tab").forEach(x=>x.classList.toggle("active",x===b));
  renderAll();
}));
$("taskSearch").addEventListener("input",renderAll);
$("calendarPrev").addEventListener("click",()=>moveCalendarWindow(-1));
$("calendarNext").addEventListener("click",()=>moveCalendarWindow(1));
$("calendarToday").addEventListener("click",()=>{calendarDate=new Date();renderCalendar();});
document.querySelectorAll("[data-calendar-mode]").forEach(button=>{
  button.addEventListener("click",()=>{
    calendarMode=button.dataset.calendarMode;
    renderCalendar();
  });
});
$("calendarStatusFilter").addEventListener("change",renderCalendar);
$("calendarPriorityFilter").addEventListener("change",renderCalendar);
$("addHolidayBtn").addEventListener("click",()=>{
  const date=$("settingHolidayDate").value;
  if(!date){showToast("Hãy chọn ngày nghỉ cần thêm.");return;}
  if(!settingsHolidayDraft.includes(date)){
    settingsHolidayDraft=[...settingsHolidayDraft,date].sort();
    renderHolidayList();
  }
  $("settingHolidayDate").value="";
});
$("settingsForm").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!currentUser)return;
  const workStart=$("settingWorkStart").value;
  const workEnd=$("settingWorkEnd").value;
  if(workStart>=workEnd){
    showToast("Giờ kết thúc phải sau giờ bắt đầu trong cùng ngày.");
    return;
  }
  const settings=normalizeSettings({
    theme:$("settingTheme").value,
    accentColor:$("settingAccentColor").value,
    workStart,
    workEnd,
    daysOff:[...document.querySelectorAll('input[name="daysOff"]:checked')].map(input=>Number(input.value)),
    holidays:settingsHolidayDraft,
    defaultReminderMinutes:Number($("settingReminderDefault").value)
  });
  const button=$("saveSettingsBtn");
  if(button.disabled)return;
  button.disabled=true;
  try{
    await saveSettings(currentUser.uid,settings);
    userSettings=settings;
    applyUserSettings();
    renderSettingsForm();
    renderCalendar();
    showToast("Đã lưu cài đặt.");
    await recordActivity("Cập nhật cài đặt hệ thống");
  }catch(error){
    showToast("Không thể lưu cài đặt: "+error.message);
  }finally{
    button.disabled=false;
  }
});
$("createTelegramLinkBtn").addEventListener("click",async()=>{
  const button=$("createTelegramLinkBtn");
  if(button.disabled)return;
  button.disabled=true;
  try{
    const result=await requestTelegramLink("create");
    telegramPendingUrl=createTelegramLink(result.code);
    telegramAccount.pendingExpiresAt=Number(result.expiresAt);
    $("telegramLinkAnchor").textContent="Mở bot và nhấn Start để xác nhận ↗";
    renderTelegramAccount();
    showToast("Đã tạo liên kết Telegram, có hiệu lực trong 10 phút.");
  }catch(error){
    showToast("Không tạo được liên kết Telegram: "+error.message);
  }finally{
    button.disabled=false;
  }
});
$("unlinkTelegramBtn").addEventListener("click",async()=>{
  if(!currentUser||!confirm("Ngắt liên kết tài khoản Telegram này?"))return;
  const button=$("unlinkTelegramBtn");
  button.disabled=true;
  try{
    await requestTelegramLink("unlink");
    telegramAccount={chatId:null,pendingExpiresAt:null};
    telegramPendingUrl="";
    renderTelegramAccount();
    showToast("Đã ngắt liên kết Telegram.");
  }catch(error){
    showToast("Không ngắt được Telegram: "+error.message);
  }finally{
    button.disabled=false;
  }
});
$("groupFilter").addEventListener("change",()=>{
  activeGroup=$("groupFilter").value||null;
  activeCategory=null;
  renderAll();
});

const categories=["Cá nhân","Công việc","IT","Gia đình","Khác"];
categories.forEach(category=>{
  const b=document.createElement("button"); b.innerHTML=`<i></i>${category}`;
  b.addEventListener("click",()=>{activeGroup=null;$("groupFilter").value="";activeCategory=category;goView("tasks",true);renderAll();});
  $("categoryList").append(b);
});

function renderGroups() {
  const selectedGroup = activeGroup;
  const selectedTaskGroup = $("taskGroup").value;
  const filter = $("groupFilter");
  filter.replaceChildren(new Option("Tất cả nhóm", ""));
  const taskGroup = $("taskGroup");
  taskGroup.replaceChildren(new Option("Không thuộc nhóm", ""));
  const managerList = $("groupManagerList");
  managerList.replaceChildren();

  groups.forEach(group => {
    filter.add(new Option(group.name, group.id));
    taskGroup.add(new Option(group.name, group.id));

    const row = document.createElement("div");
    row.className = "group-manager-item";
    const name = document.createElement("span");
    name.textContent = group.name;
    const actions = document.createElement("div");
    actions.className = "group-manager-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "text-button";
    edit.textContent = "Sửa";
    edit.addEventListener("click", () => {
      $("groupId").value = group.id;
      $("groupName").value = group.name;
      $("saveGroupBtn").textContent = "Lưu thay đổi";
      $("groupName").focus();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button danger-text";
    remove.textContent = "Xóa";
    remove.addEventListener("click", async () => {
      const message = `Xóa nhóm "${group.name}"? Các công việc đang hoạt động trong nhóm sẽ được chuyển vào Thùng rác.`;
      if (!confirm(message)) return;
      try {
        await deleteGroup(currentUser.uid, group.id, tasks);
        if (activeGroup === group.id) activeGroup = null;
        if ($("groupId").value === group.id) resetGroupForm();
        showToast("Đã xóa nhóm và chuyển công việc vào Thùng rác.");
        await recordActivity(`Xóa nhóm công việc: ${group.name}`);
      } catch (error) {
        showToast("Không thể xóa nhóm: " + error.message);
      }
    });
    actions.append(edit, remove);
    row.append(name, actions);
    managerList.append(row);
  });

  if (groups.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Chưa có nhóm công việc.";
    managerList.append(empty);
  }
  if (selectedTaskGroup && groups.some(group => group.id === selectedTaskGroup)) {
    taskGroup.value = selectedTaskGroup;
  }
  if (selectedGroup && groups.some(group => group.id === selectedGroup)) {
    filter.value = selectedGroup;
  } else {
    activeGroup = null;
    filter.value = "";
  }
}

function resetGroupForm() {
  $("groupId").value = "";
  $("groupName").value = "";
  $("saveGroupBtn").textContent = "Thêm nhóm";
}

function openGroupsDialog() {
  resetGroupForm();
  $("groupsDialog").showModal();
}

$("manageGroupsBtn").addEventListener("click",openGroupsDialog);
$("closeGroupsDialog").addEventListener("click",()=>$("groupsDialog").close());
$("cancelGroupEdit").addEventListener("click",resetGroupForm);
$("groupForm").addEventListener("submit",async event=>{
  event.preventDefault();
  const button=$("saveGroupBtn");
  if(button.disabled)return;
  button.disabled=true;
  const groupId=$("groupId").value||null;
  const groupName=$("groupName").value.trim();
  try {
    await saveGroup(currentUser.uid,groupName,groupId);
    resetGroupForm();
    showToast(groupId?"Đã cập nhật nhóm.":"Đã tạo nhóm.");
    await recordActivity(`${groupId?"Cập nhật":"Tạo"} nhóm công việc: ${groupName}`);
  } catch(error) {
    showToast("Không thể lưu nhóm: "+error.message);
  } finally {
    button.disabled=false;
  }
});

function openTaskEditor(task = null, title = "Tạo công việc") {
  editingTaskOwnerUid = task?.ownerUid || currentUser?.uid || null;
  $("taskForm").reset();
  $("taskId").value=task?.id||"";
  $("taskDialogTitle").textContent=title;
  $("checklistEditor").replaceChildren();
  $("subtaskEditor").replaceChildren();
  $("taskGroup").value=task?.groupId||"";
  $("taskReminderLead").value=String(task?.remindBeforeMinutes??userSettings.defaultReminderMinutes);
  $("taskRecurrence").value=task?.recurrence||"none";
  taskAttachmentDraft=(task?.attachments||[]).map(attachment=>({...attachment}));
  pendingAttachmentFiles=[];
  removedTaskAttachments=[];
  if(task){
    $("taskTitle").value=task.title||"";
    $("taskDescription").value=task.description||"";
    $("taskNotes").value=task.notes||"";
    $("taskTags").value=(task.tags||[]).map(tag=>tag.name||tag.title||"").filter(Boolean).join(", ");
    $("taskColor").value=/^#[0-9a-f]{6}$/i.test(task.color||"")?task.color:"#ffffff";
    $("taskCategory").value=task.category||"Cá nhân";
    $("taskPriority").value=task.priority||"medium";
    $("taskStartDate").value=formatInputDate(task.startAt);
    const due=task.dueAt?.toDate?task.dueAt.toDate():(task.dueAt?new Date(task.dueAt):null);
    if(due){
      $("taskDueDate").value=formatInputDate(due);
      $("taskDueTime").value=`${String(due.getHours()).padStart(2,"0")}:${String(due.getMinutes()).padStart(2,"0")}`;
    }
    renderEditorItems($("checklistEditor"),task.checklist,"checklist");
    renderEditorItems($("subtaskEditor"),task.subtasks,"subtask");
  }
  renderTaskAttachmentDraft();
  $("taskDialog").showModal();
}
function openNewTask() {
  editingTaskOwnerUid = null;
  openTaskEditor();
}
function openDuplicateTask(task) {
  openTaskEditor(duplicateTaskDraft(task),"Tạo công việc");
  if((task.attachments||[]).some(attachment=>attachment.kind==="file")){
    showToast("Liên kết được sao chép; tệp đã tải lên cần được đính kèm lại.");
  }
}

function formatInputDate(value) {
  const date=value?.toDate?value.toDate():(value?new Date(value):null);
  if(!date||Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}

function addEditorItem(container, type, item = {}) {
  const row=document.createElement("div");
  row.className="editor-item";
  row.dataset.id=item.id||crypto.randomUUID();
  const check=document.createElement("input");
  check.type="checkbox";
  check.checked=type==="checklist"?!!item.completed:item.status==="completed";
  check.setAttribute("aria-label","Đánh dấu đầu việc hoàn thành");
  const input=document.createElement("input");
  input.type="text";
  input.maxLength=120;
  input.placeholder=type==="checklist"?"Bước cần thực hiện":"Tên công việc con";
  input.value=item.title||"";
  const remove=document.createElement("button");
  remove.type="button";
  remove.className="icon-button";
  remove.textContent="×";
  remove.title="Xóa mục";
  remove.addEventListener("click",()=>row.remove());
  row.append(check,input,remove);
  container.append(row);
}

function renderEditorItems(container, items, type) {
  container.replaceChildren();
  (items||[]).forEach(item=>addEditorItem(container,type,item));
}

function readEditorItems(container, type) {
  return [...container.querySelectorAll(".editor-item")].map(row=>{
    const title=row.querySelector('input[type="text"]').value.trim();
    if(!title) return null;
    const completed=row.querySelector('input[type="checkbox"]').checked;
    return type==="checklist"
      ? {id:row.dataset.id,title,completed}
      : {id:row.dataset.id,title,status:completed?"completed":"pending"};
  }).filter(Boolean);
}

function renderTaskAttachmentDraft() {
  const list=$("taskAttachmentList");
  list.replaceChildren();
  const addRow=(name,kind,remove,href=null)=>{
    const row=document.createElement("div");
    row.className="attachment-draft-item";
    const label=document.createElement("span");
    label.textContent=(kind==="link"?"↗ ":"📎 ")+name;
    if(href){
      try{
        const url=new URL(href);
        if(url.protocol==="http:"||url.protocol==="https:"){
          const link=document.createElement("a");
          link.href=url.href;
          link.target="_blank";
          link.rel="noopener noreferrer";
          link.textContent=(kind==="link"?"↗ ":"📎 ")+name;
          label.replaceWith(link);
        }
      }catch{}
    }
    const button=document.createElement("button");
    button.type="button";
    button.className="icon-button";
    button.textContent="×";
    button.title="Gỡ tệp đính kèm";
    button.addEventListener("click",remove);
    row.append(label,button);
    list.append(row);
  };
  taskAttachmentDraft.forEach((attachment,index)=>addRow(
    attachment.name||"Tệp đính kèm",attachment.kind||"file",()=>{
      const [removed]=taskAttachmentDraft.splice(index,1);
      if(removed.kind==="file"&&removed.path) removedTaskAttachments.push(removed);
      renderTaskAttachmentDraft();
    },attachment.url
  ));
  pendingAttachmentFiles.forEach((file,index)=>addRow(file.name,"file",()=>{
    pendingAttachmentFiles.splice(index,1);
    renderTaskAttachmentDraft();
  }));
  if(!taskAttachmentDraft.length&&!pendingAttachmentFiles.length){
    const empty=document.createElement("span");
    empty.className="tiny muted";
    empty.textContent="Chưa có tệp hoặc liên kết.";
    list.append(empty);
  }
}

function openEditTask(task) {
  if (task.sharedReadOnly) {
    openCollaboration(task);
    return;
  }
  openTaskEditor(task,"Chỉnh sửa công việc");
}
$("addTaskTop").addEventListener("click",openNewTask);
$("closeTaskDialog").addEventListener("click",()=>$("taskDialog").close());
$("cancelTask").addEventListener("click",()=>$("taskDialog").close());
$("taskAttachmentFiles").addEventListener("change",event=>{
  const selected=[...event.target.files];
  const errors=[];
  for(const file of selected){
    try{
      validateTaskAttachment(file);
      if(taskAttachmentDraft.length+pendingAttachmentFiles.length>=MAX_TASK_ATTACHMENTS){
        throw new Error("Một công việc chỉ được có tối đa 10 tệp hoặc liên kết.");
      }
      pendingAttachmentFiles.push(file);
    }catch(error){errors.push(error.message);}
  }
  event.target.value="";
  renderTaskAttachmentDraft();
  if(errors.length) showToast(errors.join(" "));
});
$("addTaskAttachmentLink").addEventListener("click",()=>{
  const rawUrl=$("taskAttachmentUrl").value.trim();
  if(!rawUrl){showToast("Hãy nhập địa chỉ liên kết.");return;}
  let url;
  try{url=new URL(rawUrl);}catch{showToast("Địa chỉ liên kết không hợp lệ.");return;}
  if(!["http:","https:"].includes(url.protocol)){showToast("Chỉ chấp nhận liên kết HTTP hoặc HTTPS.");return;}
  if(taskAttachmentDraft.length+pendingAttachmentFiles.length>=MAX_TASK_ATTACHMENTS){
    showToast("Một công việc chỉ được có tối đa 10 tệp hoặc liên kết.");return;
  }
  if(taskAttachmentDraft.some(attachment=>attachment.kind==="link"&&attachment.url===url.href)){
    showToast("Liên kết này đã được thêm.");return;
  }
  taskAttachmentDraft.push({
    id:crypto.randomUUID(),kind:"link",name:$("taskAttachmentLinkName").value.trim()||url.hostname,url:url.href
  });
  $("taskAttachmentUrl").value="";
  $("taskAttachmentLinkName").value="";
  renderTaskAttachmentDraft();
});
$("taskForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const submitButton=$("saveTaskBtn");
  if(submitButton.disabled)return;
  const due=toDateTimeLocal($("taskDueDate").value,$("taskDueTime").value);
  const start=toDateTimeLocal($("taskStartDate").value,"00:00");
  if(start&&due&&start>due){showToast("Ngày bắt đầu phải trước ngày đến hạn.");return;}
  const recurrence=$("taskRecurrence").value;
  if(recurrence!=="none"&&!due){showToast("Công việc lặp lại cần có ngày đến hạn.");return;}
  const taskId=$("taskId").value||null;
  const checklist=readEditorItems($("checklistEditor"),"checklist");
  const subtasks=readEditorItems($("subtaskEditor"),"subtask");
  const existing=taskId?tasks.find(task=>
    task.id===taskId&&(task.ownerUid||currentUser.uid)===(editingTaskOwnerUid||currentUser.uid)
  ):null;
  const tagNames=[...new Map($("taskTags").value.split(",").map(tag=>tag.trim()).filter(Boolean)
    .map(name=>[name.toLowerCase(),name])).values()];
  if(tagNames.length>10){showToast("Một công việc chỉ được có tối đa 10 nhãn.");return;}
  const longTag=tagNames.find(name=>name.length>24);
  if(longTag){showToast(`Nhãn "${longTag}" không được dài quá 24 ký tự.`);return;}
  const existingTags=existing?.tags||[];
  const tags=tagNames.map(name=>existingTags.find(tag=>(tag.name||tag.title||"").toLowerCase()===name.toLowerCase())||{
    id:crypto.randomUUID(),name
  });
  const existingDue=existing?.dueAt?.toDate?existing.dueAt.toDate():(existing?.dueAt?new Date(existing.dueAt):null);
  const sameDue=existing&&((existingDue?.getTime()??null)===(due?.getTime()??null));
  const sameRecurrence=sameDue&&existing?.recurrence===recurrence;
  const remindBeforeMinutes=due?Number($("taskReminderLead").value)||0:0;
  const sameReminder=sameDue&&Number(existing?.remindBeforeMinutes||0)===remindBeforeMinutes;
  const hasItems=checklist.length+subtasks.length>0;
  const allComplete=hasItems&&checklist.every(item=>item.completed)&&subtasks.every(item=>item.status==="completed");
  const hasIncomplete=checklist.some(item=>!item.completed)||subtasks.some(item=>item.status!=="completed");
  const status=allComplete?"completed":
    (existing?.status==="completed"&&hasIncomplete?"pending":existing?.status||"pending");
  const recurrenceAnchorDay=["monthly","yearly"].includes(recurrence)
    ? sameRecurrence&&existing?.recurrenceAnchorDay
      ? Number(existing.recurrenceAnchorDay)
      : due.getDate()
    : null;
  const recurrenceAnchorMonth=recurrence==="yearly"
    ? sameRecurrence&&existing?.recurrenceAnchorMonth!=null
      ? Number(existing.recurrenceAnchorMonth)
      : due.getMonth()
    : null;
  const data={
    title:$("taskTitle").value.trim(),description:$("taskDescription").value.trim(),notes:$("taskNotes").value.trim(),
    category:$("taskCategory").value,priority:$("taskPriority").value,
    tags,color:$("taskColor").value,
    groupId:$("taskGroup").value||null,
    startAt:start,
    dueAt:due,
    remindBeforeMinutes,
    recurrence,recurrenceAnchorDay,recurrenceAnchorMonth,
    reminderSentAt:sameDue?existing.reminderSentAt||null:null,
    preReminderSentAt:sameReminder?existing.preReminderSentAt||null:null,
    completedAt:status==="completed"?existing?.completedAt||Date.now():null,
    checklist,subtasks,attachments:taskAttachmentDraft,
    favorite:existing?.favorite||false,status
  };
  submitButton.disabled=true;
  try {
    const savedTaskId=await saveTask(existing?.ownerUid||editingTaskOwnerUid||currentUser.uid,data,taskId);
    $("taskId").value=savedTaskId;
    if(status==="completed") await setTaskStatus(existing?.ownerUid||editingTaskOwnerUid||currentUser.uid,savedTaskId,"completed");
    const uploaded=[],failedUploads=[];
    for(const file of pendingAttachmentFiles){
      try{uploaded.push({file,attachment:await uploadTaskAttachment(existing?.ownerUid||editingTaskOwnerUid||currentUser.uid,savedTaskId,file)});}
      catch(error){failedUploads.push({file,error});}
    }
    const uploadedAttachments=uploaded.map(item=>item.attachment);
    const allAttachments=[...taskAttachmentDraft,...uploadedAttachments];
    if(uploaded.length){
      try{
        await saveTask(currentUser.uid,{...data,attachments:allAttachments},savedTaskId);
        taskAttachmentDraft=allAttachments;
      }catch(error){
        const cleanupFailures=await deleteTaskAttachments(existing?.ownerUid||editingTaskOwnerUid||currentUser.uid,savedTaskId,uploadedAttachments);
        const orphaned=cleanupFailures.map(failure=>failure.attachment);
        taskAttachmentDraft=[...taskAttachmentDraft,...orphaned];
        pendingAttachmentFiles=failedUploads.map(item=>item.file).concat(
          uploaded.filter(item=>!orphaned.some(orphan=>orphan.id===item.attachment.id))
            .map(item=>item.file)
        );
        renderTaskAttachmentDraft();
        const cleanupNote=cleanupFailures.length?` Không dọn được ${cleanupFailures.length} tệp đã tải lên.`:"";
        showToast(`Đã lưu công việc nhưng không lưu được danh sách tệp: ${error.message}.${cleanupNote}`);
        return;
      }
    }
    pendingAttachmentFiles=failedUploads.map(item=>item.file);
    renderTaskAttachmentDraft();
    const deleteFailures=await deleteTaskAttachments(existing?.ownerUid||editingTaskOwnerUid||currentUser.uid,savedTaskId,removedTaskAttachments);
    removedTaskAttachments=deleteFailures.map(failure=>failure.attachment);
    if(deleteFailures.length){
      const restoredById=new Map(taskAttachmentDraft.map(attachment=>[attachment.id,attachment]));
      deleteFailures.forEach(failure=>restoredById.set(failure.attachment.id,failure.attachment));
      const restoredAttachments=[...restoredById.values()];
      try{
        await saveTask(currentUser.uid,{...data,attachments:restoredAttachments},savedTaskId);
        taskAttachmentDraft=restoredAttachments;
        removedTaskAttachments=[];
        renderTaskAttachmentDraft();
      }catch(error){
        showToast(`Không xóa được tệp cũ và cũng không khôi phục được liên kết trong công việc: ${error.message}`);
        return;
      }
    }
    if(failedUploads.length||deleteFailures.length){
      const uploadMessage=failedUploads.map(item=>`${item.file.name}: ${item.error.message}`).join("; ");
      const deleteMessage=deleteFailures.map(item=>`${item.name}: ${item.error.message}`).join("; ");
      showToast(`Đã lưu công việc. ${uploadMessage?`Tải tệp chưa thành công: ${uploadMessage}. `:""}${deleteMessage?`Chưa xóa được tệp cũ nên vẫn giữ trong công việc: ${deleteMessage}.`:""}`);
      return;
    }
    $("taskDialog").close();
    showToast(taskId?"Đã cập nhật công việc.":"Đã thêm công việc.");
    await recordActivity(`${taskId?"Cập nhật":"Tạo"} công việc: ${data.title}`);
  } catch(err){showToast("Không thể lưu: "+err.message);}
  finally{submitButton.disabled=false;}
});
