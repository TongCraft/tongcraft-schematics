const $ = (selector) => document.querySelector(selector);
const grid = $("#itemGrid");
const status = $("#catalogStatus");
const state = {
  member: null,
  page: 1,
  total: 0,
  q: "",
  tag: "",
  loading: false,
};
let toastTimer;
let searchTimer;

function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("show"), 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function show(dialog) {
  if (!dialog.open) dialog.showModal();
}
function date(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(value);
}
function size(value) {
  return value < 1024 * 1024
    ? `${(value / 1024).toFixed(0)} KiB`
    : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function setMember(member) {
  state.member = member;
  $("#memberLabel").hidden = !member;
  $("#memberLabel").textContent = member ? `玩家 · ${member.name}` : "";
  $("#loginButton").textContent = member ? "退出登录" : "玩家登录";
  $("#uploadButton").hidden = !member;
}

function card(entry, index) {
  const article = element("article", "item-card");
  const art = element("div", "card-art");
  art.append(
    element("span", "card-index", `TC / ${String(index + 1).padStart(3, "0")}`),
  );
  const body = element("div", "card-body");
  body.append(element("h3", "card-title", entry.title));
  body.append(
    element(
      "p",
      "card-description",
      entry.description || "一份等待你带进世界的建筑蓝图。",
    ),
  );
  const tags = element("div", "card-tags");
  for (const tag of entry.tags) tags.append(element("span", "card-tag", tag));
  body.append(tags);
  const meta = element("div", "card-meta");
  meta.append(
    element("span", "", `by ${entry.owner.name}`),
    element("span", "", `${entry.blocks.toLocaleString("zh-CN")} 方块`),
  );
  body.append(meta);
  const actions = element("div", "card-action");
  const detail = element("button", "", "查看详情 ↗");
  detail.type = "button";
  detail.addEventListener("click", () => openDetail(entry.id));
  actions.append(detail, element("span", "", size(entry.size)));
  body.append(actions);
  article.append(art, body);
  return article;
}

async function loadItems() {
  if (state.loading) return;
  state.loading = true;
  status.textContent = "正在读取素材目录…";
  const params = new URLSearchParams({ page: String(state.page) });
  if (state.q) params.set("q", state.q);
  if (state.tag) params.set("tag", state.tag);
  try {
    const data = await api(`/api/items?${params}`);
    state.total = data.total;
    grid.replaceChildren();
    data.items.forEach((entry, index) =>
      grid.append(card(entry, (state.page - 1) * data.pageSize + index)),
    );
    if (data.items.length === 0) {
      const empty = element("div", "empty-state");
      empty.append(
        element(
          "strong",
          "",
          state.q || state.tag
            ? "没有找到匹配的蓝图"
            : "素材库正在等待第一份作品",
        ),
      );
      empty.append(
        element(
          "span",
          "",
          state.q || state.tag
            ? "换个关键词或标签试试。"
            : "TongCraft 玩家可以从模组获取上传链接，分享你的蓝图。",
        ),
      );
      grid.append(empty);
    }
    $("#catalogCount").textContent =
      `${data.total.toLocaleString("zh-CN")} 份素材`;
    $("#pageLabel").textContent =
      `${state.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
    $("#prevPage").disabled = state.page <= 1;
    $("#nextPage").disabled = state.page * data.pageSize >= data.total;
    status.textContent =
      state.q || state.tag ? "已按条件筛选" : "按最新上传排序";
  } catch (error) {
    status.textContent = error.message;
    toast(error.message);
  } finally {
    state.loading = false;
  }
}

async function openDetail(id) {
  try {
    const { item: entry } = await api(`/api/items/${id}`);
    const content = $("#detailContent");
    content.replaceChildren();
    content.append(element("h2", "", entry.title));
    content.append(element("p", "", entry.description || "作者尚未填写简介。"));
    const meta = element("div", "detail-meta");
    for (const label of [
      `作者 ${entry.owner.name}`,
      `${entry.blocks.toLocaleString("zh-CN")} 方块`,
      `${entry.regions} 个区域`,
      size(entry.size),
      date(entry.createdAt),
    ])
      meta.append(element("span", "", label));
    content.append(meta);
    const tags = element("div", "card-tags");
    for (const tag of entry.tags) tags.append(element("span", "card-tag", tag));
    content.append(tags);
    content.append(element("p", "detail-hash", `SHA-256  ${entry.sha256}`));
    const actions = element("div", "detail-actions");
    const download = element("a", "button button-accent", "下载 .litematic ↓");
    download.href = entry.downloadUrl;
    actions.append(download);
    const share = element("button", "button button-outline", "复制链接");
    share.type = "button";
    share.addEventListener("click", async () => {
      await navigator.clipboard.writeText(
        `${location.origin}/items/${entry.id}`,
      );
      toast("链接已复制");
    });
    actions.append(share);
    if (
      state.member &&
      (state.member.uuid === entry.owner.uuid || state.member.role === "admin")
    ) {
      const remove = element("button", "button button-danger", "删除");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!confirm(`确定删除「${entry.title}」吗？`)) return;
        try {
          await api(`/api/items/${entry.id}`, { method: "DELETE" });
          $("#detailDialog").close();
          toast("蓝图已删除");
          await loadItems();
        } catch (error) {
          toast(error.message);
        }
      });
      actions.append(remove);
    }
    content.append(actions);
    show($("#detailDialog"));
  } catch (error) {
    toast(error.message);
  }
}

async function upload(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = $("#fileInput").files?.[0];
  if (!file) return;
  if (file.size > 16 * 1024 * 1024) {
    $("#uploadStatus").textContent = "文件不能超过 16 MiB";
    return;
  }
  const button = $("#submitUpload");
  const message = $("#uploadStatus");
  button.disabled = true;
  message.textContent = "正在校验并上传，请保持页面打开…";
  try {
    const result = await api("/api/items", {
      method: "POST",
      body: new FormData(form),
    });
    form.reset();
    $("#uploadDialog").close();
    state.page = 1;
    await loadItems();
    toast("发布成功，其他玩家现在可以下载了");
    await openDetail(result.id);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function start() {
  document
    .querySelectorAll("[data-close]")
    .forEach((button) =>
      button.addEventListener("click", () => button.closest("dialog").close()),
    );
  $("#loginButton").addEventListener("click", async () => {
    if (!state.member) return show($("#loginDialog"));
    try {
      await api("/api/session", { method: "DELETE" });
      setMember(null);
      toast("已退出网页登录");
    } catch (error) {
      toast(error.message);
    }
  });
  $("#uploadButton").addEventListener("click", () => show($("#uploadDialog")));
  $("#heroUploadButton").addEventListener("click", () =>
    show($(state.member ? "#uploadDialog" : "#loginDialog")),
  );
  $("#uploadForm").addEventListener("submit", upload);
  $("#searchInput").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = event.target.value.trim();
      state.page = 1;
      loadItems();
    }, 250);
  });
  document.querySelectorAll(".filter").forEach((button) =>
    button.addEventListener("click", () => {
      document
        .querySelectorAll(".filter")
        .forEach((item) => item.classList.toggle("active", item === button));
      state.tag = button.dataset.tag;
      state.page = 1;
      loadItems();
    }),
  );
  $("#prevPage").addEventListener("click", () => {
    state.page--;
    loadItems();
  });
  $("#nextPage").addEventListener("click", () => {
    state.page++;
    loadItems();
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)
    ) {
      event.preventDefault();
      $("#searchInput").focus();
    }
  });

  const ticket = location.hash.match(/^#ticket=([A-Za-z0-9_-]{43})$/)?.[1];
  if (ticket) {
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const data = await api("/api/session/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      setMember(data.member);
      toast(`欢迎回来，${data.member.name}`);
    } catch (error) {
      toast(error.message);
      show($("#loginDialog"));
    }
  } else {
    try {
      setMember((await api("/api/session")).member);
    } catch {
      setMember(null);
    }
  }
  await loadItems();
  const detailId = location.pathname.match(/^\/items\/([a-f0-9-]{36})$/)?.[1];
  if (detailId) await openDetail(detailId);
}

start();
