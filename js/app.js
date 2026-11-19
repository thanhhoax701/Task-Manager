import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  subscribeTasks, saveTask, setTaskStatus, removeTask, restoreTask,
  permanentlyDeleteTask, setTaskFavorite, saveTaskItems, duplicateTaskDraft,
  ensureTasksMigrated
} from "./tasks.js";
import { createTelegramLink } from "./telegram.js";
import { showToast, formatDate, toDateTimeLocal, renderTaskList } from "./ui.js";

const $ = id => document.getElementById(id);
let currentUser = null, tasks = [], tasksUnsubscribe = null;
let authMode = "login", activeView = "dashboard", activeFilter = "all", activeCategory = null;
let dueNotificationTimer = null, dueNotificationUid = null, notificationAudio = null;
const notifiedDueTasks = new Set();

const views = ["dashboard","tasks","today","upcoming","favorites","trash"];
const titles = {
  dashboard:"Tổng quan",tasks:"Tất cả công việc",today:"Hôm nay",
  upcoming:"Sắp tới",favorites:"Yêu thích",trash:"Thùng rác"
};

$("todayLabel").textContent = new Intl.DateTimeFormat("vi-VN",{weekday:"long",day:"numeric",month:"long"}).format(new Date()).toUpperCase();
$("currentDate").textContent = new Intl.DateTimeFormat("vi-VN",{weekday:"long",day:"numeric",month:"long",year:"numeric"}).format(new Date());
$("linkTelegramBtn").href = createTelegramLink();

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
  if (!user) {
    tasks=[];
    dueNotificationUid=null;
    notifiedDueTasks.clear();
    clearTimeout(dueNotificationTimer);
    return;
  }
  $("userEmail").textContent = user.email || "Tài khoản";
  $("userAvatar").textContent = (user.email || "U").charAt(0).toUpperCase();
  setDoc(doc(db, "users", user.uid), { email: user.email || null }, { merge: true })
    .catch(err => showToast("Không thể cập nhật hồ sơ: " + err.message));
  ensureTasksMigrated(user.uid).then(result => {
    if (result.copied) showToast(`Đã chuyển ${result.copied} công việc cũ sang Realtime Database.`);
  }).catch(err => showToast("Không chuyển được dữ liệu cũ: " + err.message)).finally(() => {
    if(currentUser?.uid!==user.uid) return;
    tasksUnsubscribe = subscribeTasks(user.uid, data => {
      tasks = data;
      renderAll();
      checkDueNotifications(dueNotificationUid!==user.uid);
      dueNotificationUid=user.uid;
    }, err => showToast("Không tải được công việc: " + err.message));
  });
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
  const activeTasks = tasks.filter(t => !t.deletedAt);
  const trashedTasks = tasks.filter(t => t.deletedAt);
  const pending = activeTasks.filter(t => t.status !== "completed");
  const done = activeTasks.filter(t => t.status === "completed");
  const dueToday = pending.filter(t => { const d=dateOf(t); return d && d>=start && d<end; });
  const overdue = pending.filter(t => { const d=dateOf(t); return d && d<start; });
  $("statTotal").textContent = activeTasks.length;
  $("statDone").textContent = done.length;
  $("statToday").textContent = dueToday.length;
  $("statOverdue").textContent = overdue.length;

  const handlers = {
    toggle: async (t, checked) => { try { await setTaskStatus(currentUser.uid,t.id,checked?"completed":"pending"); } catch(e){showToast(e.message);} },
    edit: openEditTask,
    remove: async t => { if(confirm(`Chuyển "${t.title}" vào thùng rác?`)){try{await removeTask(currentUser.uid,t.id);showToast("Đã chuyển vào thùng rác.");}catch(e){showToast(e.message);}} },
    favorite: async t => { try { await setTaskFavorite(currentUser.uid,t.id,!t.favorite); } catch(e){showToast(e.message);} },
    duplicate: t => openDuplicateTask(t),
    restore: async t => { try { await restoreTask(currentUser.uid,t.id); showToast("Đã khôi phục công việc."); } catch(e){showToast(e.message);} },
    deleteForever: async t => {
      if(confirm(`Xóa vĩnh viễn "${t.title}"? Không thể hoàn tác.`)){
        try { await permanentlyDeleteTask(currentUser.uid,t.id); showToast("Đã xóa vĩnh viễn."); }
        catch(e){showToast(e.message);}
      }
    },
    toggleChecklist: async (t,itemId,checked) => {
      const checklist=(t.checklist||[]).map(item=>item.id===itemId?{...item,completed:checked}:item);
      try { await saveTaskItems(currentUser.uid,t,checklist,t.subtasks||[]); }
      catch(e){showToast("Không cập nhật được checklist: "+e.message);}
    },
    toggleSubtask: async (t,itemId,checked) => {
      const subtasks=(t.subtasks||[]).map(item=>item.id===itemId?{...item,status:checked?"completed":"pending"}:item);
      try { await saveTaskItems(currentUser.uid,t,t.checklist||[],subtasks); }
      catch(e){showToast("Không cập nhật được công việc con: "+e.message);}
    }
  };
  renderTaskList($("dashboardTasks"), [...pending].sort((a,b)=>(dateOf(a)||new Date(8640000000000000))-(dateOf(b)||new Date(8640000000000000))).slice(0,6), handlers);
  let filtered = [...activeTasks];
  if (activeFilter === "pending") filtered = filtered.filter(t=>t.status!=="completed");
  if (activeFilter === "completed") filtered = filtered.filter(t=>t.status==="completed");
  if (activeCategory) filtered = filtered.filter(t=>t.category===activeCategory);
  const search = $("taskSearch").value.trim().toLowerCase();
  if(search) filtered=filtered.filter(t=>(t.title+" "+(t.description||"")).toLowerCase().includes(search));
  renderTaskList($("allTasks"),filtered,handlers);
  renderTaskList($("todayTasks"),dueToday,handlers);
  renderTaskList($("upcomingTasks"),pending.filter(t=>{const d=dateOf(t);return d&&d>=end;}).sort((a,b)=>dateOf(a)-dateOf(b)),handlers);
  renderTaskList($("favoriteTasks"),activeTasks.filter(t=>t.favorite),handlers);
  renderTaskList($("trashTasks"),trashedTasks,handlers,{trash:true});
}

function goView(view, preserveCategory = false) {
  activeView=view;
  if (!preserveCategory) activeCategory=null;
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

const categories=["Cá nhân","Công việc","IT","Gia đình","Khác"];
categories.forEach(category=>{
  const b=document.createElement("button"); b.innerHTML=`<i></i>${category}`;
  b.addEventListener("click",()=>{activeCategory=category;goView("tasks",true);renderAll();});
  $("categoryList").append(b);
});

function openTaskEditor(task = null, title = "Tạo công việc") {
  $("taskForm").reset();
  $("taskId").value=task?.id||"";
  $("taskDialogTitle").textContent=title;
  $("checklistEditor").replaceChildren();
  $("subtaskEditor").replaceChildren();
  if(task){
    $("taskTitle").value=task.title||"";
    $("taskDescription").value=task.description||"";
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
  $("taskDialog").showModal();
}
function openNewTask() {
  openTaskEditor();
}
function openDuplicateTask(task) {
  openTaskEditor(duplicateTaskDraft(task),"Tạo công việc");
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

function openEditTask(task) {
  openTaskEditor(task,"Chỉnh sửa công việc");
}
$("addTaskTop").addEventListener("click",openNewTask);
$("closeTaskDialog").addEventListener("click",()=>$("taskDialog").close());
$("cancelTask").addEventListener("click",()=>$("taskDialog").close());
$("taskForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const submitButton=$("saveTaskBtn");
  if(submitButton.disabled)return;
  const due=toDateTimeLocal($("taskDueDate").value,$("taskDueTime").value);
  const start=toDateTimeLocal($("taskStartDate").value,"00:00");
  if(start&&due&&start>due){showToast("Ngày bắt đầu phải trước ngày đến hạn.");return;}
  const taskId=$("taskId").value||null;
  const checklist=readEditorItems($("checklistEditor"),"checklist");
  const subtasks=readEditorItems($("subtaskEditor"),"subtask");
  const existing=taskId?tasks.find(task=>task.id===taskId):null;
  const existingDue=existing?.dueAt?.toDate?existing.dueAt.toDate():(existing?.dueAt?new Date(existing.dueAt):null);
  const sameDue=existing&&((existingDue?.getTime()??null)===(due?.getTime()??null));
  const hasItems=checklist.length+subtasks.length>0;
  const allComplete=hasItems&&checklist.every(item=>item.completed)&&subtasks.every(item=>item.status==="completed");
  const hasIncomplete=checklist.some(item=>!item.completed)||subtasks.some(item=>item.status!=="completed");
  const status=allComplete?"completed":
    (existing?.status==="completed"&&hasIncomplete?"pending":existing?.status||"pending");
  const data={
    title:$("taskTitle").value.trim(),description:$("taskDescription").value.trim(),
    category:$("taskCategory").value,priority:$("taskPriority").value,
    startAt:start,
    dueAt:due,
    reminderSentAt:sameDue?existing.reminderSentAt||null:null,checklist,subtasks,
    favorite:existing?.favorite||false,status
  };
  submitButton.disabled=true;
  try {
    await saveTask(currentUser.uid,data,taskId);
    $("taskDialog").close();
    showToast(taskId?"Đã cập nhật công việc.":"Đã thêm công việc.");
  } catch(err){showToast("Không thể lưu: "+err.message);}
  finally{submitButton.disabled=false;}
});
