const $ = id => document.getElementById(id);
let toastTimer;

export function showToast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

export function formatDate(value) {
  if (!value) return "Chưa đặt hạn";
  const d = value.toDate ? value.toDate() : new Date(value);
  return new Intl.DateTimeFormat("vi-VN", { day:"2-digit", month:"2-digit", year:"numeric" }).format(d);
}

export function toDateTimeLocal(date, time) {
  if (!date) return null;
  const [y,m,d] = date.split("-").map(Number);
  const [hh,mm] = (time || "23:59").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0);
}

export function renderTask(task, handlers = {}) {
  const row = document.createElement("div");
  row.className = "task-row";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "task-check";
  check.checked = task.status === "completed";
  check.title = "Đánh dấu hoàn thành";
  check.addEventListener("change", () => handlers.toggle?.(task, check.checked));
  const main = document.createElement("div");
  main.className = "task-main";
  const title = document.createElement("div");
  title.className = "task-title" + (check.checked ? " done" : "");
  title.textContent = task.title || "(Không có tiêu đề)";
  main.append(title);
  if (task.description) {
    const desc = document.createElement("div");
    desc.className = "task-description";
    desc.textContent = task.description;
    main.append(desc);
  }
  const meta = document.createElement("div");
  meta.className = "task-meta";
  const category = document.createElement("span");
  category.className = "meta-chip";
  category.textContent = task.category || "Khác";
  const priority = document.createElement("span");
  priority.className = "meta-chip priority-" + (task.priority || "medium");
  priority.textContent = ({high:"Ưu tiên cao",medium:"Trung bình",low:"Ưu tiên thấp"})[task.priority] || "Trung bình";
  const due = document.createElement("span");
  due.className = "meta-chip";
  due.textContent = task.dueAt ? "Hạn: " + formatDate(task.dueAt) : "Không có hạn";
  meta.append(category, priority, due);
  if (task.reminderAt) {
    const reminder = document.createElement("span");
    reminder.className = "meta-chip";
    reminder.textContent = "🔔 Có nhắc Telegram";
    meta.append(reminder);
  }
  main.append(meta);
  const actions = document.createElement("div");
  actions.className = "task-actions";
  const edit = document.createElement("button");
  edit.className = "icon-button"; edit.type = "button"; edit.textContent = "✎"; edit.title = "Sửa";
  edit.addEventListener("click", () => handlers.edit?.(task));
  const del = document.createElement("button");
  del.className = "icon-button"; del.type = "button"; del.textContent = "×"; del.title = "Xóa";
  del.addEventListener("click", () => handlers.remove?.(task));
  actions.append(edit, del);
  row.append(check, main, actions);
  return row;
}

export function renderTaskList(container, tasks, handlers) {
  container.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Chưa có công việc nào ở đây.";
    container.append(empty);
    return;
  }
  tasks.forEach(t => container.append(renderTask(t, handlers)));
}
