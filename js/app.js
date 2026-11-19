import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { subscribeTasks, saveTask, setTaskStatus, removeTask } from "./tasks.js";
import { createTelegramLink, subscribeTelegram } from "./telegram.js";
import { TELEGRAM_BOT_USERNAME } from "./config.js";
import { showToast, formatDate, toDateTimeLocal, renderTaskList } from "./ui.js";

const $ = id => document.getElementById(id);
let currentUser = null, tasks = [], telegramUnsubscribe = null, tasksUnsubscribe = null;
let authMode = "login", activeView = "dashboard", activeFilter = "all", activeCategory = null;

const views = ["dashboard","tasks","today","upcoming"];
const titles = {dashboard:"Tổng quan",tasks:"Tất cả công việc",today:"Hôm nay",upcoming:"Sắp tới"};

$("todayLabel").textContent = new Intl.DateTimeFormat("vi-VN",{weekday:"long",day:"numeric",month:"long"}).format(new Date()).toUpperCase();
$("currentDate").textContent = new Intl.DateTimeFormat("vi-VN",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date());

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
      await setDoc(doc(db, "users", credential.user.uid), { email, createdAt: serverTimestamp() });
    } else await signInWithEmailAndPassword(auth, email, password);
  } catch (err) { $("authMessage").textContent = friendlyError(err); }
  finally { $("authSubmit").disabled = false; }
});
$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, user => {
  currentUser = user;
  $("authView").classList.toggle("hidden", !!user);
  $("appView").classList.toggle("hidden", !user);
  if (tasksUnsubscribe) tasksUnsubscribe();
  if (telegramUnsubscribe) telegramUnsubscribe();
  if (!user) return;
  $("userEmail").textContent = user.email || "Tài khoản";
  $("userAvatar").textContent = (user.email || "U").charAt(0).toUpperCase();
  tasksUnsubscribe = subscribeTasks(user.uid, data => { tasks = data; renderAll(); }, err => showToast("Không tải được công việc: " + err.message));
  telegramUnsubscribe = subscribeTelegram(user.uid, data => renderTelegramStatus(data), err => console.error(err));
});

function friendlyError(err) {
  const map = {
    "auth/email-already-in-use":"Email này đã được đăng ký.",
    "auth/invalid-email":"Email không hợp lệ.",
    "auth/weak-password":"Mật khẩu cần ít nhất 6 ký tự.",
    "auth/invalid-credential":"Email hoặc mật khẩu không chính xác.",
    "auth/network-request-failed":"Lỗi kết nối mạng. Vui lòng thử lại."
  };
  return map[err.code] || err.message || "Có lỗi xảy ra.";
}

function renderAll() {
  const now = new Date();
  const start = new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const end = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  const dateOf = t => t.dueAt?.toDate ? t.dueAt.toDate() : (t.dueAt ? new Date(t.dueAt) : null);
  const pending = tasks.filter(t => t.status !== "completed");
  const done = tasks.filter(t => t.status === "completed");
  const dueToday = pending.filter(t => { const d=dateOf(t); return d && d>=start && d<end; });
  const overdue = pending.filter(t => { const d=dateOf(t); return d && d<start; });
  $("statTotal").textContent = tasks.length;
  $("statDone").textContent = done.length;
  $("statToday").textContent = dueToday.length;
  $("statOverdue").textContent = overdue.length;

  const handlers = {
    toggle: async (t, checked) => { try { await setTaskStatus(currentUser.uid,t.id,checked?"completed":"pending"); } catch(e){showToast(e.message);} },
    edit: openEditTask,
    remove: async t => { if(confirm(`Xóa công việc "${t.title}"?`)){try{await removeTask(currentUser.uid,t.id);showToast("Đã xóa công việc.");}catch(e){showToast(e.message);}} }
  };
  renderTaskList($("dashboardTasks"), [...pending].sort((a,b)=>(dateOf(a)||new Date(8640000000000000))-(dateOf(b)||new Date(8640000000000000))).slice(0,6), handlers);
  let filtered = [...tasks];
  if (activeFilter === "pending") filtered = filtered.filter(t=>t.status!=="completed");
  if (activeFilter === "completed") filtered = filtered.filter(t=>t.status==="completed");
  if (activeCategory) filtered = filtered.filter(t=>t.category===activeCategory);
  const search = $("taskSearch").value.trim().toLowerCase();
  if(search) filtered=filtered.filter(t=>(t.title+" "+(t.description||"")).toLowerCase().includes(search));
  renderTaskList($("allTasks"),filtered,handlers);
  renderTaskList($("todayTasks"),dueToday,handlers);
  renderTaskList($("upcomingTasks"),pending.filter(t=>{const d=dateOf(t);return d&&d>=end;}).sort((a,b)=>dateOf(a)-dateOf(b)),handlers);
}

function renderTelegramStatus(data) {
  const linked = !!data?.chatId;
  $("telegramStatus").textContent = linked ? "✓ Đã liên kết Telegram" : "Chưa liên kết Telegram";
  $("telegramStatus").classList.toggle("connected",linked);
  $("linkTelegramBtn").textContent = linked ? "Liên kết lại Telegram" : "Liên kết Telegram";
}

function goView(view) {
  activeView=view; activeCategory=null;
  views.forEach(v=>$(`${v}View`).classList.toggle("hidden",v!==view));
  $("pageTitle").textContent=titles[view]||"Công việc";
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
}
document.querySelectorAll("[data-view]").forEach(b=>b.addEventListener("click",()=>goView(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach(b=>b.addEventListener("click",()=>goView(b.dataset.goto)));
document.querySelectorAll(".filter-tab").forEach(b=>b.addEventListener("click",()=>{
  activeFilter=b.dataset.filter;
  document.querySelectorAll(".filter-tab").forEach(x=>x.classList.toggle("active",x===b));
  renderAll();
}));
$("taskSearch").addEventListener("input",renderAll);

const categories=["Cá nhân","Công việc","IT","Gia đình","Khác"];
categories.forEach(category=>{
  const b=document.createElement("button"); b.innerHTML=`<i></i>${category}`;
  b.addEventListener("click",()=>{activeCategory=category;goView("tasks");renderAll();});
  $("categoryList").append(b);
});

function openNewTask() {
  $("taskForm").reset(); $("taskId").value=""; $("taskDialogTitle").textContent="Tạo công việc";
  $("taskDialog").showModal();
}
function openEditTask(task) {
  $("taskForm").reset(); $("taskId").value=task.id;
  $("taskDialogTitle").textContent="Chỉnh sửa công việc";
  $("taskTitle").value=task.title||""; $("taskDescription").value=task.description||"";
  $("taskCategory").value=task.category||"Cá nhân"; $("taskPriority").value=task.priority||"medium";
  const due=task.dueAt?.toDate?task.dueAt.toDate():(task.dueAt?new Date(task.dueAt):null);
  if(due){$("taskDueDate").value=`${due.getFullYear()}-${String(due.getMonth()+1).padStart(2,"0")}-${String(due.getDate()).padStart(2,"0")}`;$("taskDueTime").value=`${String(due.getHours()).padStart(2,"0")}:${String(due.getMinutes()).padStart(2,"0")}`;}
  const reminder=task.reminderAt?.toDate?task.reminderAt.toDate():(task.reminderAt?new Date(task.reminderAt):null);
  $("taskReminder").checked=!!reminder;
  $("taskDialog").showModal();
}
$("addTaskTop").addEventListener("click",openNewTask);
$("closeTaskDialog").addEventListener("click",()=>$("taskDialog").close());
$("cancelTask").addEventListener("click",()=>$("taskDialog").close());
$("taskForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const due=toDateTimeLocal($("taskDueDate").value,$("taskDueTime").value);
  const reminderEnabled=$("taskReminder").checked;
  if(reminderEnabled&&!due){showToast("Vui lòng chọn ngày đến hạn trước khi bật nhắc Telegram.");return;}
  if(reminderEnabled&&due<=new Date()){showToast("Thời điểm nhắc phải nằm trong tương lai.");return;}
  const data={
    title:$("taskTitle").value.trim(),description:$("taskDescription").value.trim(),
    category:$("taskCategory").value,priority:$("taskPriority").value,
    dueAt:due,reminderAt:reminderEnabled?due:null,
    reminderSentAt:null
  };
  try {
    await saveTask(currentUser.uid,data,$("taskId").value||null);
    $("taskDialog").close();showToast("Đã lưu công việc.");
  } catch(err){showToast("Không thể lưu: "+err.message);}
});

$("linkTelegramBtn").addEventListener("click",async()=>{
  if(!TELEGRAM_BOT_USERNAME||TELEGRAM_BOT_USERNAME==="YOUR_TELEGRAM_BOT_USERNAME"){showToast("Hãy cấu hình TELEGRAM_BOT_USERNAME trong js/config.js trước.");return;}
  try{
    const result=await createTelegramLink();
    $("telegramDeepLink").href=result.deepLink;
    $("telegramDialog").showModal();
  }catch(err){showToast("Không tạo được liên kết: "+err.message);}
});
$("closeTelegramDialog").addEventListener("click",()=>$("telegramDialog").close());
