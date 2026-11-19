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

function makeAction(label, title, action) {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", action);
  return button;
}

function renderTaskItem(item, type, task, handlers) {
  const row = document.createElement("label");
  row.className = "child-item";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = type === "checklist" ? !!item.completed : item.status === "completed";
  check.addEventListener("change", () => {
    if (type === "checklist") handlers.toggleChecklist?.(task, item.id, check.checked);
    else handlers.toggleSubtask?.(task, item.id, check.checked);
  });
  const text = document.createElement("span");
  text.textContent = item.title;
  if (check.checked) text.classList.add("child-item-done");
  row.append(check, text);
  return row;
}

export function renderTask(task, handlers = {}, { trash = false } = {}) {
  const row = document.createElement("div");
  row.className = "task-row" + (trash ? " task-row-trash" : "");
  const main = document.createElement("div");
  main.className = "task-main";
  const title = document.createElement("div");
  title.className = "task-title" + (task.status === "completed" ? " done" : "");
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
  meta.append(category, priority);
  if (task.startAt) {
    const start = document.createElement("span");
    start.className = "meta-chip";
    start.textContent = "Bắt đầu: " + formatDate(task.startAt);
    meta.append(start);
  }
  meta.append(due);
  if (task.favorite) {
    const favorite = document.createElement("span");
    favorite.className = "meta-chip favorite-chip";
    favorite.textContent = "★ Yêu thích";
    meta.append(favorite);
  }
  if (trash && task.deletedAt) {
    const deleted = document.createElement("span");
    deleted.className = "meta-chip";
    deleted.textContent = "Đã xóa: " + formatDate(task.deletedAt);
    meta.append(deleted);
  }
  if (task.dueAt) {
    const reminder = document.createElement("span");
    reminder.className = "meta-chip";
    reminder.textContent = "🔔 Báo khi đến hạn";
    meta.append(reminder);
  }
  main.append(meta);

  const checklist = task.checklist || [];
  const subtasks = task.subtasks || [];
  const totalItems = checklist.length + subtasks.length;
  const completedItems = checklist.filter(item => item.completed).length +
    subtasks.filter(item => item.status === "completed").length;
  const progress = totalItems
    ? Math.round(completedItems / totalItems * 100)
    : (task.status === "completed" ? 100 : 0);
  const progressRow = document.createElement("div");
  progressRow.className = "task-progress-row";
  const progressBar = document.createElement("progress");
  progressBar.className = "task-progress";
  progressBar.max = 100;
  progressBar.value = progress;
  progressBar.setAttribute("aria-label", `Tiến độ ${progress}%`);
  const progressLabel = document.createElement("span");
  progressLabel.textContent = `${progress}%`;
  progressRow.append(progressBar, progressLabel);
  main.append(progressRow);

  if (checklist.length) {
    const list = document.createElement("div");
    list.className = "task-child-list";
    const heading = document.createElement("span");
    heading.className = "task-child-heading";
    heading.textContent = "Checklist";
    list.append(heading);
    checklist.forEach(item => list.append(renderTaskItem(item, "checklist", task, handlers)));
    main.append(list);
  }
  if (subtasks.length) {
    const list = document.createElement("div");
    list.className = "task-child-list";
    const heading = document.createElement("span");
    heading.className = "task-child-heading";
    heading.textContent = "Công việc con";
    list.append(heading);
    subtasks.forEach(item => list.append(renderTaskItem(item, "subtask", task, handlers)));
    main.append(list);
  }

  const actions = document.createElement("div");
  actions.className = "task-actions";
  if (trash) {
    actions.append(
      makeAction("↶", "Khôi phục", () => handlers.restore?.(task)),
      makeAction("×", "Xóa vĩnh viễn", () => handlers.deleteForever?.(task))
    );
  } else {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-check";
    check.checked = task.status === "completed";
    check.title = "Đánh dấu hoàn thành";
    check.setAttribute("aria-label", "Đánh dấu hoàn thành");
    check.addEventListener("change", () => handlers.toggle?.(task, check.checked));
    actions.append(
      makeAction(task.favorite ? "★" : "☆", task.favorite ? "Bỏ yêu thích" : "Đánh dấu yêu thích",
        () => handlers.favorite?.(task)),
      makeAction("⧉", "Nhân bản", () => handlers.duplicate?.(task)),
      makeAction("✎", "Sửa", () => handlers.edit?.(task)),
      makeAction("×", "Chuyển vào thùng rác", () => handlers.remove?.(task))
    );
    row.append(check);
  }
  row.append(main, actions);
  return row;
}

export function renderTaskList(container, tasks, handlers, options) {
  container.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Chưa có công việc nào ở đây.";
    container.append(empty);
    return;
  }
  tasks.forEach(t => container.append(renderTask(t, handlers, options)));
}
