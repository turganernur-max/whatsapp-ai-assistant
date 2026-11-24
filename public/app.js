"use strict";
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (v) => "$" + Number(v || 0).toFixed(Number(v || 0) < 1 ? 4 : 2);
  let pollTimer = null;

  // ---------------- Files ----------------
  const MB = 1024 * 1024;
  // iPhone photos are often HEIC and large: re-encode to JPEG (max 1600 px) so WhatsApp accepts them.
  async function toJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("Не удалось открыть фото"));
        i.src = url;
      });
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
      if (!blob) throw new Error("Не удалось сжать фото");
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  /** Prepares a picked file for upload: {blob, mime, filename, note}. Videos are converted on the server. */
  async function preparePickedFile(file) {
    let blob = file;
    let mime = file.type || "application/octet-stream";
    let filename = file.name || "file";
    let note = "";
    if (mime.startsWith("image/")) {
      if (!["image/jpeg", "image/png"].includes(mime) || file.size > 3 * MB) {
        blob = await toJpeg(file);
        mime = "image/jpeg";
        filename = filename.replace(/\.[^.]+$/, "") + ".jpg";
      }
    } else if (mime.startsWith("video/")) {
      if (file.size > 80 * MB) throw new Error(`Видео ${(file.size / MB).toFixed(0)} МБ — слишком большое. Обрежьте его в «Фото» (Править) до 1–2 минут.`);
      note = "Сервер переделает видео в формат WhatsApp (MP4). Это может занять 1–3 минуты — не закрывайте страницу.";
    } else if (file.size > 16 * MB) {
      throw new Error("Файл больше 16 МБ");
    }
    return { blob, mime, filename, note };
  }
  /** Sends file bytes as-is (no base64), metadata in the query string. */
  async function uploadRaw(url, f, params) {
    const qs = new URLSearchParams({ ...params, mime: f.mime, filename: f.filename });
    const res = await fetch(`${url}?${qs}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Requested-With": "panel", "Content-Type": "application/octet-stream" },
      body: f.blob,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error("Нужно войти");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Ошибка " + res.status);
    return data;
  }
  const kindIcon = (k) => (k === "image" ? "📷" : k === "video" ? "🎬" : "📎");
  let currentRoute = "";

  // ---------------- API ----------------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "X-Requested-With": "panel", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && url !== "/api/login") {
      showLogin();
      throw new Error("Нужно войти");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Ошибка " + res.status);
    return data;
  }

  function toast(text, isErr) {
    const t = $("#toast");
    t.textContent = text;
    t.className = "toast" + (isErr ? " err" : "");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.add("hidden"), isErr ? 5000 : 2500);
  }

  function fmtTime(d) {
    if (!d) return "";
    const dt = new Date(d);
    const now = new Date();
    const same = dt.toDateString() === now.toDateString();
    return same
      ? dt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      : dt.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }) + " " + dt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  const initials = (c) => esc(((c.name || c.wa_id || "?").trim()[0] || "?").toUpperCase());
  const contactTitle = (c) => (c.name ? c.name : "+" + c.wa_id);

  // ---------------- Auth ----------------
  function showLogin() {
    $("#app").classList.add("hidden");
    $("#login").classList.remove("hidden");
    stopPoll();
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#login-error").textContent = "";
    try {
      await api("POST", "/api/login", { password: $("#login-password").value });
      $("#login-password").value = "";
      start();
    } catch (err) {
      $("#login-error").textContent = err.message;
    }
  });

  // ---------------- AI toggle ----------------
  const toggle = $("#ai-toggle");
  function setToggle(on) {
    toggle.checked = !!on;
    const l = $("#ai-label");
    l.textContent = on ? "AI вкл" : "AI выкл";
    l.className = on ? "ai-on" : "ai-off";
  }
  toggle.addEventListener("change", async () => {
    const want = toggle.checked;
    if (want && !confirm("Включить AI? Он начнёт автоматически отвечать клиентам в WhatsApp.")) {
      setToggle(false);
      return;
    }
    try {
      const r = await api("POST", "/api/ai-toggle", { enabled: want });
      setToggle(r.ai_enabled);
      toast(r.ai_enabled ? "AI включён — отвечает клиентам" : "AI выключен");
    } catch (err) {
      setToggle(!want);
      toast(err.message, true);
    }
  });

  async function refreshOverview() {
    const o = await api("GET", "/api/overview");
    setToggle(o.ai_enabled);
    const b = $("#badge");
    if (o.attention > 0) {
      b.textContent = o.attention;
      b.classList.remove("hidden");
    } else b.classList.add("hidden");
    businessMode = o.business_mode || "sales";
    const tabLabel = document.querySelector('.tabbar a[data-tab="orders"] span:nth-child(2)');
    const tabIco = document.querySelector('.tabbar a[data-tab="orders"] .ico');
    if (tabLabel) tabLabel.textContent = businessMode === "recruiting" ? "Собесед." : "Заказы";
    if (tabIco) tabIco.textContent = businessMode === "recruiting" ? "🗓" : "📦";
    const bo = $("#badge-orders");
    if (o.orders_attention > 0) {
      bo.textContent = o.orders_attention;
      bo.classList.remove("hidden");
    } else bo.classList.add("hidden");
    return o;
  }

  // ---------------- Router ----------------
  const routes = {
    chats: renderChats,
    chat: renderChat,
    instructions: renderInstructions,
    kb: renderKb,
    stats: renderStats,
    costs: renderCosts,
    settings: renderSettingsMenu,
    "ai-settings": renderAiSettings,
    whatsapp: renderWhatsapp,
    privacy: renderPrivacy,
    campaigns: renderCampaigns,
    orders: renderOrders,
    catalog: renderCatalog,
  };
  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  function poll(fn, ms) {
    stopPoll();
    pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") fn().catch(() => {});
    }, ms);
  }
  async function route() {
    const hash = location.hash.replace(/^#/, "") || "chats";
    const [name, arg] = hash.split("/");
    currentRoute = hash;
    stopPoll();
    const tabFor = { chat: "chats", costs: "stats", "ai-settings": "settings", whatsapp: "settings", privacy: "settings", campaigns: "settings", catalog: "kb" };
    const tab = tabFor[name] || name;
    document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    const fn = routes[name] || renderChats;
    view.innerHTML = '<p class="muted">Загрузка…</p>';
    try {
      await fn(arg ? decodeURIComponent(arg) : undefined);
    } catch (err) {
      if (err.message !== "Нужно войти") view.innerHTML = `<div class="banner danger">${esc(err.message)}</div>`;
    }
    refreshOverview().catch(() => {});
  }
  window.addEventListener("hashchange", route);
  const title = (t) => ($("#page-title").textContent = t);

  // ---------------- Chats ----------------
  let chatFilter = "all";
  async function renderChats() {
    title("Диалоги");
    const o = await refreshOverview();
    const warn = [];
    if (!o.ai_enabled) warn.push(`<div class="banner warn">AI выключен — клиенты не получают автоответы. Включите переключатель вверху.</div>`);
    if (!o.integrations.whatsapp) warn.push(`<div class="banner danger">${esc(o.integrations.whatsappProblem || "WhatsApp не подключён. Откройте Настройки → Подключение WhatsApp.")}</div>`);
    if (!o.integrations.claude) warn.push(`<div class="banner danger">Ключ Claude API не задан.</div>`);
    if (o.wa_auth_error)
      warn.push(`<div class="banner danger"><b>WhatsApp не работает: токен недействителен или истёк.</b> AI не может отвечать клиентам. Создайте новый токен в Meta и замените WHATSAPP_TOKEN в Render. <a href="#whatsapp">Подробнее</a></div>`);
    if (o.hints && o.hints.vacancies_missing)
      warn.push(`<div class="banner warn small">Режим найма: заполните вакансии и график собеседований — иначе AI не сможет записывать кандидатов. <a href="#ai-settings">Заполнить</a></div>`);
    if (o.hints && o.hints.payment_missing)
      warn.push(`<div class="banner warn small">Не заполнено «Как оплатить» — AI не сможет дать клиенту реквизиты Kaspi. <a href="#ai-settings">Заполнить</a></div>`);
    if (o.monthly_budget > 0 && o.month_spend >= o.monthly_budget)
      warn.push(`<div class="banner danger">Месячный лимит расходов исчерпан (${money(o.month_spend)} из ${money(o.monthly_budget)}). AI не отвечает.</div>`);
    view.innerHTML = `${warn.join("")}
      <div class="seg" id="seg">
        <button data-f="all">Все</button><button data-f="active">Активные</button><button data-f="attention">Внимание${o.attention ? " (" + o.attention + ")" : ""}</button>
      </div>
      <input type="search" id="search" placeholder="Поиск по имени или номеру">
      <div id="list" class="list"></div>`;
    const seg = $("#seg");
    const paint = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.f === chatFilter));
    paint();
    seg.addEventListener("click", (e) => {
      const f = e.target.dataset && e.target.dataset.f;
      if (!f) return;
      chatFilter = f;
      paint();
      loadList();
    });
    let st;
    $("#search").addEventListener("input", () => {
      clearTimeout(st);
      st = setTimeout(loadList, 300);
    });
    async function loadList() {
      const q = $("#search") ? $("#search").value.trim() : "";
      const rows = await api("GET", `/api/contacts?filter=${chatFilter}&q=${encodeURIComponent(q)}`);
      const list = $("#list");
      if (!list) return;
      if (!rows.length) {
        list.innerHTML = `<div class="item"><div class="body muted">${chatFilter === "all" && !q ? "Пока нет диалогов. Когда клиент напишет на ваш номер WhatsApp, переписка появится здесь." : "Ничего не найдено"}</div></div>`;
        return;
      }
      list.innerHTML = rows
        .map((c) => {
          const lm = c.last_message || {};
          const who = lm.sender === "ai" ? "🤖 " : lm.sender === "owner" ? "Вы: " : "";
          const paused = c.paused_until && new Date(c.paused_until) > new Date();
          return `<a class="item" href="#chat/${encodeURIComponent(c.wa_id)}">
            <div class="avatar">${initials(c)}</div>
            <div class="body">
              <div class="top"><span class="name">${esc(contactTitle(c))}</span><span class="time">${fmtTime(c.last_message_at)}</span></div>
              <div class="preview">${esc(who + (lm.text || ""))}</div>
              <div>${c.needs_attention ? '<span class="pill att">Нужен владелец</span>' : ""}${!c.ai_enabled ? '<span class="pill off">AI выкл</span>' : ""}${paused ? '<span class="pill pause">Вы ведёте</span>' : ""}${c.followup_mode === "persistent" ? '<span class="pill pause">🔔 настойчиво</span>' : c.followup_mode === "off" ? '<span class="pill off">🔕</span>' : ""}${c.unread ? `<span class="pill unread">${c.unread}</span>` : ""}</div>
            </div></a>`;
        })
        .join("");
    }
    await loadList();
    poll(loadList, 8000);
  }

  async function renderChat(waId) {
    const load = async () => api("GET", `/api/contacts/${encodeURIComponent(waId)}`);
    let data = await load();
    title(contactTitle(data.contact));
    view.innerHTML = `
      <div class="row"><a href="#chats" class="btn">← Назад</a><span class="grow muted small">+${esc(data.contact.wa_id)}</span></div>
      <div id="chat-state"></div>
      <div class="chat-actions" id="chat-actions"></div>
      <div class="chat" id="chat"></div>
      <div class="composer">
        <div class="row attach-row">
          <label class="btn small-btn">📎 Фото / видео<input type="file" id="attach" accept="image/*,video/*,application/pdf" class="vh"></label>
          <select id="lib-select" class="grow lib-select"><option value="">🖼 Из медиатеки…</option></select>
        </div>
        <div class="row"><textarea id="reply" class="grow" placeholder="Ответить самому (AI встанет на паузу)"></textarea>
        <button class="btn primary" id="send">➤</button></div>
      </div>`;
    function paint() {
      const c = data.contact;
      const paused = c.paused_until && new Date(c.paused_until) > new Date();
      const state = [];
      if (c.needs_attention) state.push(`<div class="banner danger">⚠️ ${esc(c.attention_reason || "Нужен владелец")}</div>`);
      if (c.opted_out) state.push(`<div class="banner warn">Клиент отказался от автоответов.</div>`);
      if (paused) state.push(`<div class="banner warn">Вы ведёте переписку — AI молчит до ${fmtTime(c.paused_until)}.</div>`);
      const windowOpen = c.last_inbound_at && Date.now() - new Date(c.last_inbound_at).getTime() < 24 * 3600 * 1000;
      if (!windowOpen) state.push(`<div class="banner warn small">Окно 24 часа закрыто: по правилам WhatsApp писать первым можно только шаблоном. Ответить можно, когда клиент напишет снова.</div>`);
      $("#chat-state").innerHTML = state.join("");
      $("#chat-actions").innerHTML = `
        <button class="btn" data-a="ai">${c.ai_enabled ? "🤖 Выключить AI для контакта" : "🤖 Включить AI для контакта"}</button>
        ${paused ? '<button class="btn" data-a="resume">▶️ Вернуть AI</button>' : '<button class="btn" data-a="pause">⏸ Пауза AI 12 ч</button>'}
        ${c.needs_attention ? '<button class="btn" data-a="done">✅ Решено</button>' : ""}
        ${windowOpen ? '<button class="btn" data-a="now">⚡ AI ответит сейчас</button>' : ""}
        <button class="btn danger" data-a="delete">🗑 Удалить данные</button>
        <label class="fu-row"><span>🔔 Напоминания:</span>
          <select id="fu-mode" class="lib-select">
            <option value="default" ${c.followup_mode === "default" ? "selected" : ""}>по общей настройке</option>
            <option value="once" ${c.followup_mode === "once" ? "selected" : ""}>1 раз</option>
            <option value="persistent" ${c.followup_mode === "persistent" ? "selected" : ""}>настойчиво — пока не ответит</option>
            <option value="off" ${c.followup_mode === "off" ? "selected" : ""}>выкл</option>
          </select></label>
        ${c.followup_mode === "persistent" ? `<span class="muted small">Отправлено напоминаний: ${Math.min(c.followup_count, 10)}. Только в бесплатные 24 часа после сообщения клиента.</span>` : ""}`;
      $("#chat").innerHTML = data.messages
        .map((m) => {
          const cls = m.direction === "in" ? "in" : m.sender;
          const who = m.direction === "in" ? "" : m.sender === "ai" ? "🤖 AI · " : m.sender === "owner" ? "Вы · " : "Система · ";
          const st = m.direction === "out" ? { sent: " ✓", delivered: " ✓✓", read: " ✓✓ прочитано", failed: " ✗" }[m.status] || "" : "";
          const err = m.error && (m.direction === "out" || m.status === "skipped") ? `<div class="err">${esc(m.error)}</div>` : "";
          return `<div class="msg ${esc(cls)}">${esc(m.text || "[" + m.type + "]")}<div class="meta">${who}${fmtTime(m.created_at)}${st}</div>${err}</div>`;
        })
        .join("");
    }
    paint();
    window.scrollTo(0, document.body.scrollHeight);
    $("#chat-actions").addEventListener("click", async (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (e.target.id === "fu-mode") return;
      if (!a) return;
      try {
        const u = `/api/contacts/${encodeURIComponent(waId)}`;
        if (a === "ai") await api("PATCH", u, { ai_enabled: !data.contact.ai_enabled });
        if (a === "pause") await api("PATCH", u, { pause_hours: 12 });
        if (a === "resume") await api("PATCH", u, { pause_hours: 0 });
        if (a === "done") await api("PATCH", u, { needs_attention: false });
        if (a === "now") {
          await api("POST", u + "/ai-reply-now");
          toast("AI готовит ответ…");
        }
        if (a === "delete") {
          if (!confirm("Удалить всю переписку и данные этого контакта из базы? Это необратимо.")) return;
          await api("DELETE", u);
          location.hash = "#chats";
          return;
        }
        data = await load();
        paint();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#chat-actions").addEventListener("change", async (e) => {
      if (e.target.id !== "fu-mode") return;
      try {
        await api("PATCH", `/api/contacts/${encodeURIComponent(waId)}`, { followup_mode: e.target.value });
        const names = { default: "по общей настройке", once: "1 раз", persistent: "настойчиво, пока не ответит", off: "выключены" };
        toast("Напоминания: " + names[e.target.value] + " ✓");
        data = await load();
        paint();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#send").addEventListener("click", async () => {
      const text = $("#reply").value.trim();
      if (!text) return;
      $("#send").disabled = true;
      try {
        await api("POST", `/api/contacts/${encodeURIComponent(waId)}/send`, { text });
        $("#reply").value = "";
        data = await load();
        paint();
        window.scrollTo(0, document.body.scrollHeight);
        toast("Отправлено. AI на паузе для этого клиента.");
      } catch (err) {
        toast(err.message, true);
      } finally {
        $("#send").disabled = false;
      }
    });
    api("GET", "/api/media")
      .then(({ items }) => {
        const sel = $("#lib-select");
        if (!sel) return;
        items.filter((i) => i.enabled).forEach((i) => {
          const o = document.createElement("option");
          o.value = i.id;
          o.textContent = `${kindIcon(i.kind)} ${i.title}`;
          sel.appendChild(o);
        });
      })
      .catch(() => {});
    const afterFileSent = async () => {
      data = await load();
      paint();
      window.scrollTo(0, document.body.scrollHeight);
      toast("Файл отправлен. AI на паузе для этого клиента.");
    };
    $("#lib-select").addEventListener("change", async (e) => {
      const id = Number(e.target.value);
      if (!id) return;
      const title = e.target.selectedOptions[0].textContent;
      e.target.value = "";
      if (!confirm(`Отправить клиенту ${title}?`)) return;
      try {
        toast("Отправляю…");
        await api("POST", `/api/contacts/${encodeURIComponent(waId)}/send-file`, { library_id: id });
        await afterFileSent();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#attach").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        toast("Готовлю файл…");
        const f = await preparePickedFile(file);
        const caption = $("#reply").value.trim();
        if (!confirm(`Отправить клиенту «${file.name || "файл"}»${caption ? " с подписью из поля ответа" : ""}?${f.note ? "\n\n" + f.note : ""}`)) return;
        toast(f.mime.startsWith("video/") ? "Обрабатываю видео и отправляю… (до 3 минут)" : "Отправляю…");
        const params = caption ? { caption } : {};
        await uploadRaw(`/api/contacts/${encodeURIComponent(waId)}/send-file-raw`, f, params);
        $("#reply").value = "";
        await afterFileSent();
      } catch (err) {
        toast(err.message, true);
      }
    });
    const myRoute = currentRoute;
    poll(async () => {
      if (currentRoute !== myRoute) return;
      const n = await load();
      const changed = n.messages.length !== data.messages.length || JSON.stringify(n.contact) !== JSON.stringify(data.contact) ||
        JSON.stringify(n.messages.slice(-3)) !== JSON.stringify(data.messages.slice(-3));
      data = n;
      if (changed) {
        const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
        paint();
        if (atBottom) window.scrollTo(0, document.body.scrollHeight);
      }
    }, 5000);
  }

  // ---------------- Instructions ----------------
  async function renderInstructions() {
    title("Мои инструкции");
    const { settings: s } = await api("GET", "/api/settings");
    view.innerHTML = `
      <div class="card">
        <label class="field">Название бизнеса</label><input type="text" id="business_name" value="${esc(s.business_name)}">
        <label class="field">Ваше имя (владелец)</label><input type="text" id="owner_name" value="${esc(s.owner_name)}">
        <label class="field">Инструкции для AI — как общаться, что делать, что нельзя</label>
        <textarea id="instructions" class="big">${esc(s.instructions)}</textarea>
        <label class="field">Примеры моего стиля (вставьте свои настоящие ответы клиентам — AI будет писать похоже)</label>
        <textarea id="style_examples" placeholder="Клиент: Сколько стоит доставка?&#10;Я: Доставка по городу 1500 ₸, привезём сегодня 👍">${esc(s.style_examples)}</textarea>
        <button class="btn primary wide" id="save">Сохранить</button>
      </div>
      <div class="card test-chat">
        <h3>🧪 Проверить AI (ничего не отправляется в WhatsApp)</h3>
        <p class="muted small">Напишите сообщение как клиент и посмотрите, что ответит AI. Каждая проверка стоит немного денег Claude API.</p>
        <div class="chat" id="test-chat"></div>
        <textarea id="test-input" placeholder="Например: Сәлеметсіз бе, бағасы қанша?"></textarea>
        <div class="row"><button class="btn primary grow" id="test-send">Отправить как клиент</button><button class="btn" id="test-reset">Сброс</button></div>
      </div>`;
    $("#save").addEventListener("click", async () => {
      try {
        await api("PUT", "/api/settings", {
          business_name: $("#business_name").value,
          owner_name: $("#owner_name").value,
          instructions: $("#instructions").value,
          style_examples: $("#style_examples").value,
        });
        toast("Сохранено ✓");
      } catch (err) {
        toast(err.message, true);
      }
    });
    let convo = [];
    const paintTest = () =>
      ($("#test-chat").innerHTML = convo
        .map((m) => `<div class="msg ${m.from === "client" ? "in" : m.handoff ? "system" : "ai"}">${esc(m.text)}${m.meta ? `<div class="meta">${esc(m.meta)}</div>` : ""}</div>`)
        .join(""));
    $("#test-reset").addEventListener("click", () => {
      convo = [];
      paintTest();
    });
    $("#test-send").addEventListener("click", async () => {
      const t = $("#test-input").value.trim();
      if (!t) return;
      convo.push({ from: "client", text: t });
      $("#test-input").value = "";
      paintTest();
      $("#test-send").disabled = true;
      try {
        const r = await api("POST", "/api/ai/test", { messages: convo.map((m) => ({ from: m.from, text: m.text })) });
        convo.push({
          from: "assistant",
          text: r.reply || "(пусто)",
          handoff: r.handoff,
          meta:
            (r.files && r.files.length ? "📎 отправит: " + r.files.join(", ") + " · " : "") +
            (r.order ? "🛒 заказ: " + r.order.items + (r.order.total ? " — " + r.order.total + " ₸" : "") + " · " : "") +
            (r.payment_claimed ? "💳 сообщил об оплате · " : "") +
            (r.handoff ? "➡️ передано владельцу: " + r.handoff_reason + " · " : "") +
            money(r.cost_usd),
        });
        paintTest();
      } catch (err) {
        toast(err.message, true);
        convo.pop();
        paintTest();
      } finally {
        $("#test-send").disabled = false;
      }
    });
  }

  // ---------------- Orders ----------------
  const SALE_STATUS = {
    new: { t: "🆕 Новый", next: "contacted" },
    contacted: { t: "📞 Связались", next: "payment_check" },
    payment_check: { t: "💳 Проверить оплату", next: "paid" },
    paid: { t: "✅ Оплачен", next: "shipped" },
    shipped: { t: "🚚 Отправлен", next: "done" },
    done: { t: "🏁 Выполнен", next: null },
    cancelled: { t: "✖ Отменён", next: null },
  };
  const INTERVIEW_STATUS = {
    new: { t: "🆕 Записан", next: "contacted" },
    contacted: { t: "📞 Подтвердил", next: "paid" },
    payment_check: { t: "🕒 Ожидает", next: "paid" },
    paid: { t: "✅ Пришёл", next: "shipped" },
    shipped: { t: "🤝 Принят на работу", next: "done" },
    done: { t: "🏁 Закрыто", next: null },
    cancelled: { t: "✖ Отказ / не пришёл", next: null },
  };
  let businessMode = "sales";
  const tenge = (n) => (Number(n) > 0 ? Math.round(Number(n)).toLocaleString("ru-RU") + " ₸" : "—");
  let orderFilter = "open";

  async function renderOrders() {
    const ov = await api("GET", "/api/overview").catch(() => ({ hints: {} }));
    const hr = ov.business_mode === "recruiting";
    const ORDER_STATUS = hr ? INTERVIEW_STATUS : SALE_STATUS;
    if (hr && (orderFilter === "payment_check" || orderFilter === "paid")) orderFilter = "open";
    title(hr ? "Собеседования" : "Заказы");
    const r = await api("GET", `/api/orders?status=${orderFilter}`);
    const sm = r.summary;
    const hint = ov.hints && ov.hints.push_missing
      ? `<div class="banner warn small">Уведомления о новых ${hr ? "записях" : "заказах"} на телефон не подключены. Установите приложение <b>ntfy</b> и добавьте NTFY_TOPIC в Render (инструкция в docs/SETUP_RU.md, шаг 9).</div>`
      : "";
    view.innerHTML = `${hint}
      ${
        hr
          ? `<div class="stats-grid">
        <div class="stat"><div class="v">${sm.open}</div><div class="l">Предстоящих собеседований</div></div>
        <div class="stat"><div class="v">${sm.month_orders}</div><div class="l">Записей за месяц</div></div>
      </div>
      <div class="seg" id="o-seg">
        <button data-f="open">Предстоящие</button><button data-f="shipped">Приняты</button><button data-f="">Все</button>
      </div>`
          : `<div class="stats-grid">
        <div class="stat"><div class="v">${sm.open}</div><div class="l">Открытых заказов</div></div>
        <div class="stat"><div class="v">${sm.payment_check}</div><div class="l">Проверить оплату</div></div>
        <div class="stat"><div class="v">${sm.month_orders}</div><div class="l">Заказов за месяц</div></div>
        <div class="stat"><div class="v">${tenge(sm.month_revenue)}</div><div class="l">Оплачено за месяц (${sm.month_paid})</div></div>
      </div>
      <div class="seg" id="o-seg">
        <button data-f="open">Открытые</button><button data-f="payment_check">Оплата</button><button data-f="paid">Оплачены</button><button data-f="">Все</button>
      </div>`
      }
      <div id="o-list">${
        r.items.length
          ? r.items
              .map((o) => {
                const st = ORDER_STATUS[o.status] || { t: o.status };
                const next = st.next ? ORDER_STATUS[st.next] : null;
                return `<div class="card order">
                  <div class="top row"><b class="grow">#${o.id} · ${esc(o.customer_name || o.contact_name || "+" + o.wa_id)}</b><span class="pill ${o.status === "payment_check" || o.status === "new" ? "att" : "off"}">${st.t}</span></div>
                  ${
                    hr
                      ? `<div class="o-items">💼 ${esc(o.items)}</div>
                  <div class="row"><b>🗓 ${esc(o.address || "время не указано")}</b></div>
                  <div class="small">${o.confirmed_at ? "✅ подтвердил, что придёт" : o.reminder_sent_at ? "🔔 напомнили " + fmtTime(o.reminder_sent_at) + " — ждём ответа" : o.interview_at ? "🔔 напомним заранее" : "⚠️ время не распознано — напомните сами"}</div>
                  ${o.city ? `<div class="small">📍 ${esc(o.city)}</div>` : ""}
                  ${o.delivery ? `<div class="small">🏢 ${esc(o.delivery)}</div>` : ""}
                  <div class="small muted">записан ${fmtTime(o.created_at)}</div>`
                      : `<div class="o-items">${esc(o.items)}</div>
                  <div class="row small"><b>${tenge(o.total)}</b><span class="muted">· ${fmtTime(o.created_at)}</span></div>
                  ${o.city || o.address ? `<div class="small">📍 ${esc([o.city, o.address].filter(Boolean).join(", "))}</div>` : ""}
                  ${o.delivery ? `<div class="small">🚚 ${esc(o.delivery)}</div>` : ""}`
                  }
                  ${o.comment ? `<div class="small muted">💬 ${esc(o.comment)}</div>` : ""}
                  ${o.owner_note ? `<div class="small">📝 ${esc(o.owner_note)}</div>` : ""}
                  <div class="row o-actions">
                    <a class="btn" href="#chat/${encodeURIComponent(o.wa_id)}">💬 Чат</a>
                    <a class="btn" href="tel:+${esc(o.wa_id)}">📞</a>
                    ${next ? `<button class="btn primary" data-o="${o.id}" data-st="${st.next}">→ ${next.t}</button>` : ""}
                    <select class="lib-select" data-o-sel="${o.id}">
                      ${Object.entries(ORDER_STATUS).map(([k, v]) => `<option value="${k}" ${k === o.status ? "selected" : ""}>${v.t}</option>`).join("")}
                    </select>
                    <button class="btn" data-o-note="${o.id}">📝</button>
                  </div>
                </div>`;
              })
              .join("")
          : hr
            ? '<div class="card muted">Записей пока нет. Когда кандидат подтвердит время в переписке, AI создаст запись здесь и пришлёт вам уведомление.</div>'
            : '<div class="card muted">Заказов нет. Когда клиент подтвердит заказ в переписке, AI создаст его здесь и пришлёт вам уведомление.</div>'
      }</div>`;
    const seg = $("#o-seg");
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.f === orderFilter));
    seg.addEventListener("click", (e) => {
      if (e.target.dataset.f === undefined) return;
      orderFilter = e.target.dataset.f;
      renderOrders();
    });
    const setStatus = async (id, status) => {
      if (!hr && status === "paid" && !confirm("Вы проверили поступление денег в Kaspi?")) return;
      if (status === "cancelled" && !confirm(hr ? "Отметить: отказ / не пришёл?" : "Отменить заказ?")) return;
      await api("PATCH", `/api/orders/${id}`, { status });
      toast("Статус: " + ORDER_STATUS[status].t);
      renderOrders();
    };
    $("#o-list").addEventListener("click", async (e) => {
      const t = e.target;
      try {
        if (t.dataset.o) await setStatus(t.dataset.o, t.dataset.st);
        if (t.dataset.oNote) {
          const n = prompt("Заметка к заказу (видна только вам):");
          if (n === null) return;
          await api("PATCH", `/api/orders/${t.dataset.oNote}`, { owner_note: n });
          renderOrders();
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#o-list").addEventListener("change", async (e) => {
      if (!e.target.dataset.oSel) return;
      try {
        await setStatus(e.target.dataset.oSel, e.target.value);
      } catch (err) {
        toast(err.message, true);
        renderOrders();
      }
    });
    poll(async () => {
      if (!location.hash.startsWith("#orders")) return;
      const n = await api("GET", `/api/orders?status=${orderFilter}`);
      if (JSON.stringify(n.items.map((o) => [o.id, o.status, o.updated_at])) !== JSON.stringify(r.items.map((o) => [o.id, o.status, o.updated_at]))) renderOrders();
    }, 15000);
  }

  // ---------------- Catalog ----------------
  async function renderCatalog() {
    title("Каталог");
    const [{ items }, lib] = await Promise.all([api("GET", "/api/catalog"), api("GET", "/api/media")]);
    const mediaById = Object.fromEntries(lib.items.map((m) => [m.id, m]));
    view.innerHTML = `
      <div class="row"><a href="#kb" class="btn">← Знания</a></div>
      <div class="banner ok small">AI предлагает и продаёт только то, что есть в каталоге, по этим ценам. Отметка «нет в наличии» — AI не будет это предлагать.</div>
      <div class="card">
        <h3 id="c-form-title">Добавить товар или услугу</h3>
        <input type="hidden" id="c-id">
        <div class="seg" id="c-kind"><button data-k="product" class="on">Товар</button><button data-k="service">Услуга</button></div>
        <label class="field">Название</label><input type="text" id="c-name" placeholder="Например: Крем для лица 50 мл">
        <label class="field">Категория (необязательно)</label><input type="text" id="c-cat" placeholder="Например: Уход за кожей">
        <label class="field">Цена, ₸</label><input type="text" inputmode="numeric" id="c-price" placeholder="19500">
        <label class="field">Уточнение к цене (необязательно)</label><input type="text" id="c-note" placeholder="от / за 60 мин / за 1 кг">
        <label class="field">Описание: что это, для кого, польза, состав/что входит</label><textarea id="c-desc" class="short"></textarea>
        <label class="check"><span>Есть в наличии / доступно</span><input type="checkbox" id="c-stock" checked></label>
        <label class="field">Фото (необязательно)</label>
        <input type="file" id="c-file" accept="image/*">
        <p class="muted small" id="c-photo-note"></p>
        <div class="row"><button class="btn primary grow" id="c-save">Сохранить</button><button class="btn hidden" id="c-cancel">Отмена</button></div>
      </div>
      <div class="list" id="c-list">${
        items.length
          ? items
              .map((c) => {
                const m = c.media_id ? mediaById[c.media_id] : null;
                return `<div class="item"><div class="thumb">${m && m.kind === "image" ? `<img src="/api/media/${m.id}/file" alt="" loading="lazy">` : `<span>${c.kind === "service" ? "🛎" : "📦"}</span>`}</div>
                  <div class="body">
                    <div class="top"><span class="name">${esc(c.name)}</span><span class="time">${c.price_note ? esc(c.price_note) + " " : ""}${tenge(c.price)}</span></div>
                    <div class="preview">${esc(c.category ? c.category + " · " : "")}${esc(c.description || "")}</div>
                    <div class="row small">
                      <label class="row"><input type="checkbox" data-c-stock="${c.id}" ${c.in_stock ? "checked" : ""}> в наличии</label>
                      <button class="btn" data-c-edit="${c.id}">Изменить</button><button class="btn danger" data-c-del="${c.id}">Удалить</button>
                    </div>
                  </div></div>`;
              })
              .join("")
          : '<div class="item"><div class="body muted">Каталог пуст. Добавьте товары или услуги — AI начнёт их предлагать.</div></div>'
      }</div>`;
    let kind = "product";
    let mediaId = null;
    const setKind = (k) => {
      kind = k;
      $("#c-kind").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
    };
    $("#c-kind").addEventListener("click", (e) => e.target.dataset.k && setKind(e.target.dataset.k));
    const reset = () => {
      $("#c-id").value = "";
      ["#c-name", "#c-cat", "#c-price", "#c-note", "#c-desc"].forEach((s) => ($(s).value = ""));
      $("#c-stock").checked = true;
      $("#c-file").value = "";
      $("#c-photo-note").textContent = "";
      mediaId = null;
      setKind("product");
      $("#c-form-title").textContent = "Добавить товар или услугу";
      $("#c-cancel").classList.add("hidden");
    };
    $("#c-cancel").addEventListener("click", reset);
    $("#c-save").addEventListener("click", async () => {
      const name = $("#c-name").value.trim();
      if (!name) return toast("Напишите название", true);
      const price = Number(String($("#c-price").value).replace(/\s/g, "").replace(",", ".") || 0);
      if (!Number.isFinite(price) || price < 0) return toast("Цена — число", true);
      const btn = $("#c-save");
      btn.disabled = true;
      try {
        const file = $("#c-file").files[0];
        if (file) {
          btn.textContent = "Загружаю фото…";
          const f = await preparePickedFile(file);
          const m = await uploadRaw("/api/media/raw", f, { title: name, description: "фото из каталога: " + name });
          mediaId = m.id;
        }
        const body = {
          kind,
          name,
          category: $("#c-cat").value.trim(),
          price,
          price_note: $("#c-note").value.trim(),
          description: $("#c-desc").value,
          in_stock: $("#c-stock").checked,
          media_id: mediaId,
        };
        const id = $("#c-id").value;
        if (id) await api("PUT", `/api/catalog/${id}`, body);
        else await api("POST", "/api/catalog", body);
        toast("Сохранено ✓");
        renderCatalog();
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = "Сохранить";
      }
    });
    $("#c-list").addEventListener("click", async (e) => {
      const t = e.target;
      try {
        if (t.dataset.cDel) {
          if (!confirm("Удалить из каталога?")) return;
          await api("DELETE", `/api/catalog/${t.dataset.cDel}`);
          renderCatalog();
        } else if (t.dataset.cEdit) {
          const c = items.find((i) => String(i.id) === t.dataset.cEdit);
          $("#c-id").value = c.id;
          $("#c-name").value = c.name;
          $("#c-cat").value = c.category;
          $("#c-price").value = c.price || "";
          $("#c-note").value = c.price_note;
          $("#c-desc").value = c.description;
          $("#c-stock").checked = c.in_stock;
          mediaId = c.media_id;
          $("#c-photo-note").textContent = c.media_id ? "Фото уже есть. Выберите новое, чтобы заменить." : "";
          setKind(c.kind);
          $("#c-form-title").textContent = "Изменить";
          $("#c-cancel").classList.remove("hidden");
          window.scrollTo(0, 0);
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#c-list").addEventListener("change", async (e) => {
      if (!e.target.dataset.cStock) return;
      await api("PUT", `/api/catalog/${e.target.dataset.cStock}`, { in_stock: e.target.checked }).catch((err) => toast(err.message, true));
    });
  }

  // ---------------- Knowledge base ----------------
  async function renderKb() {
    title("База знаний");
    const { items } = await api("GET", "/api/knowledge");
    const total = items.filter((i) => i.enabled).reduce((a, i) => a + Number(i.chars), 0);
    view.innerHTML = `
      <a class="card menu-link" href="#catalog"><span>🛍 Каталог товаров и услуг</span><span>›</span></a>
      <div class="banner ok small">AI берёт факты (цены, адреса, услуги, условия) только отсюда. Всего активного текста: ${total.toLocaleString("ru-RU")} символов${total > 200000 ? " — это много, каждый ответ будет дороже" : ""}.</div>
      <div class="card">
        <h3 id="kb-form-title">Добавить раздел</h3>
        <input type="hidden" id="kb-id">
        <label class="field">Название</label><input type="text" id="kb-title" placeholder="Например: Цены и услуги">
        <label class="field">Текст</label><textarea id="kb-content" class="big" placeholder="Вставьте сюда информацию о бизнесе: услуги, цены, адрес, график, доставка, оплата, частые вопросы…"></textarea>
        <label class="field">…или загрузите файл (.txt, .md, .csv)</label>
        <input type="file" id="kb-file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv">
        <div class="row"><button class="btn primary grow" id="kb-save">Сохранить</button><button class="btn hidden" id="kb-cancel">Отмена</button></div>
      </div>
      <div class="list" id="kb-list">${
        items.length
          ? items
              .map(
                (i) => `<div class="item"><div class="body">
                  <div class="top"><span class="name">${esc(i.title)}</span><span class="time">${Number(i.chars).toLocaleString("ru-RU")} симв.</span></div>
                  <div class="preview">${esc(i.content.slice(0, 120))}</div>
                  <div class="row small">
                    <label class="row"><input type="checkbox" data-en="${i.id}" ${i.enabled ? "checked" : ""}> используется</label>
                    <button class="btn" data-edit="${i.id}">Изменить</button><button class="btn danger" data-del="${i.id}">Удалить</button>
                  </div></div></div>`,
              )
              .join("")
          : '<div class="item"><div class="body muted">База знаний пуста. Добавьте первый раздел.</div></div>'
      }</div>`;
    $("#kb-file").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast("Файл больше 2 МБ", true);
      $("#kb-content").value = await f.text();
      if (!$("#kb-title").value) $("#kb-title").value = f.name.replace(/\.[^.]+$/, "");
    });
    const resetForm = () => {
      $("#kb-id").value = "";
      $("#kb-title").value = "";
      $("#kb-content").value = "";
      $("#kb-form-title").textContent = "Добавить раздел";
      $("#kb-cancel").classList.add("hidden");
    };
    $("#kb-cancel").addEventListener("click", resetForm);
    $("#kb-save").addEventListener("click", async () => {
      const body = { title: $("#kb-title").value.trim(), content: $("#kb-content").value };
      if (!body.title || !body.content.trim()) return toast("Заполните название и текст", true);
      try {
        const id = $("#kb-id").value;
        if (id) await api("PUT", `/api/knowledge/${id}`, body);
        else await api("POST", "/api/knowledge", body);
        toast("Сохранено ✓");
        renderKb();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#kb-list").addEventListener("click", async (e) => {
      const t = e.target;
      if (t.dataset.edit) {
        const it = items.find((i) => String(i.id) === t.dataset.edit);
        $("#kb-id").value = it.id;
        $("#kb-title").value = it.title;
        $("#kb-content").value = it.content;
        $("#kb-form-title").textContent = "Изменить раздел";
        $("#kb-cancel").classList.remove("hidden");
        window.scrollTo(0, 0);
      } else if (t.dataset.del) {
        if (!confirm("Удалить раздел?")) return;
        await api("DELETE", `/api/knowledge/${t.dataset.del}`).catch((err) => toast(err.message, true));
        renderKb();
      }
    });
    $("#kb-list").addEventListener("change", async (e) => {
      const t = e.target;
      if (t.dataset.en) {
        await api("PUT", `/api/knowledge/${t.dataset.en}`, { enabled: t.checked }).catch((err) => toast(err.message, true));
      }
    });
    const mediaBox = document.createElement("div");
    mediaBox.id = "media-box";
    view.appendChild(mediaBox);
    await renderMediaLibrary(mediaBox);
  }

  async function renderMediaLibrary(box) {
    const { items, total_bytes } = await api("GET", "/api/media");
    box.innerHTML = `
      <h2>📷 Фото и видео для клиентов</h2>
      <div class="banner ok small">AI отправляет клиенту эти файлы сам, когда это уместно. В описании напишите, <b>когда</b> отправлять — например: «клиент спрашивает цены», «просит показать зал». Занято ${(total_bytes / MB).toFixed(1)} из 200 МБ.</div>
      <div class="card">
        <h3>Добавить файл</h3>
        <label class="field">Название</label><input type="text" id="m-title" placeholder="Например: Прайс-лист">
        <label class="field">Когда отправлять (для AI)</label><textarea id="m-desc" class="short" placeholder="Например: когда клиент спрашивает цены или услуги"></textarea>
        <label class="field">Фото, видео (до ~2 минут) или PDF</label>
        <input type="file" id="m-file" accept="image/*,video/*,application/pdf">
        <p id="m-note" class="muted small"></p>
        <button class="btn primary wide" id="m-save">Загрузить</button>
      </div>
      <div class="list" id="m-list">${
        items.length
          ? items
              .map(
                (i) => `<div class="item"><div class="thumb">${
                  i.kind === "image" ? `<img src="/api/media/${i.id}/file" alt="" loading="lazy">` : `<span>${kindIcon(i.kind)}</span>`
                }</div><div class="body">
                  <div class="top"><span class="name">${esc(i.title)}</span><span class="time">${(i.size / MB).toFixed(1)} МБ</span></div>
                  <div class="preview">${esc(i.description || "без описания — AI не будет знать, когда отправлять")}</div>
                  <div class="row small">
                    <label class="row"><input type="checkbox" data-men="${i.id}" ${i.enabled ? "checked" : ""}> AI может отправлять</label>
                    <button class="btn" data-medit="${i.id}">Описание</button><button class="btn danger" data-mdel="${i.id}">Удалить</button>
                  </div></div></div>`,
              )
              .join("")
          : '<div class="item"><div class="body muted">Файлов пока нет.</div></div>'
      }</div>`;
    $("#m-file").addEventListener("change", (e) => {
      const f = e.target.files[0];
      $("#m-note").textContent = "";
      if (!f) return;
      const base = (f.name || "").replace(/\.[^.]+$/, "");
      const cameraName = /^(img|vid|mov|dsc|pxl|image|video)[_-]?\d+$/i.test(base) || /^[0-9a-f-]{20,}$/i.test(base);
      if (!$("#m-title").value && !cameraName) $("#m-title").value = base;
      if (cameraName && !$("#m-title").value) $("#m-title").focus();
      if (f.type.startsWith("video/"))
        $("#m-note").textContent = "Видео будет автоматически переделано в формат WhatsApp (MP4, до 16 МБ). Загрузка может занять 1–3 минуты.";
    });
    $("#m-save").addEventListener("click", async () => {
      const file = $("#m-file").files[0];
      const title = $("#m-title").value.trim();
      if (!file) return toast("Выберите файл", true);
      if (!title) return toast("Напишите название", true);
      const btn = $("#m-save");
      btn.disabled = true;
      btn.textContent = "Загружаю…";
      try {
        const f = await preparePickedFile(file);
        if (f.note) btn.textContent = "Обрабатываю видео… (до 3 минут)";
        await uploadRaw("/api/media/raw", f, { title, description: $("#m-desc").value });
        toast("Загружено ✓");
        await renderMediaLibrary(box);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
        btn.textContent = "Загрузить";
      }
    });
    $("#m-list").addEventListener("click", async (e) => {
      const t = e.target;
      try {
        if (t.dataset.mdel) {
          if (!confirm("Удалить файл из медиатеки?")) return;
          await api("DELETE", `/api/media/${t.dataset.mdel}`);
          await renderMediaLibrary(box);
        } else if (t.dataset.medit) {
          const it = items.find((i) => String(i.id) === t.dataset.medit);
          const d = prompt("Когда AI должен отправлять этот файл?", it.description || "");
          if (d === null) return;
          await api("PUT", `/api/media/${it.id}`, { description: d });
          await renderMediaLibrary(box);
        }
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#m-list").addEventListener("change", async (e) => {
      const t = e.target;
      if (t.dataset.men) await api("PUT", `/api/media/${t.dataset.men}`, { enabled: t.checked }).catch((err) => toast(err.message, true));
    });
  }

  // ---------------- Stats & costs ----------------
  function bars(rows, key, labelKey) {
    const max = Math.max(1, ...rows.map((r) => Number(r[key]) || 0));
    return `<div class="bars">${rows
      .map((r) => {
        const v = Number(r[key]) || 0;
        const h = Math.max(1, Math.round((v / max) * 100));
        return `<div class="bar" title="${esc(r[labelKey])}: ${v}"><span class="h${h}"></span><small>${esc(String(r[labelKey]).slice(8, 10))}</small></div>`;
      })
      .join("")}</div>`;
  }
  // CSP forbids inline styles in markup, so bar heights are applied via the CSSOM.
  function applyBarHeights() {
    view.querySelectorAll(".bar span").forEach((s) => {
      const m = /h(\d+)/.exec(s.className);
      if (m) s.style.height = m[1] + "%";
    });
    view.querySelectorAll(".meter span[data-w]").forEach((s) => (s.style.width = s.dataset.w + "%"));
  }

  async function renderStats() {
    title("Статистика");
    const st = await api("GET", "/api/stats");
    const t = st.totals;
    const kinds = { handoff: "➡️ Передано владельцу", error: "❗ Ошибка", optout: "🚫 Отказ от автоответов", budget: "💸 Лимит расходов", loop_guard: "🔁 Защита от зацикливания", followup: "🔔 Напоминание клиенту", broadcast: "📢 Рассылка", order: "🛒 Заказ", payment: "💳 Оплата" };
    view.innerHTML = `
      <div class="seg"><button class="on">Статистика</button><button id="to-costs">Расходы API</button></div>
      <div class="stats-grid">
        <div class="stat"><div class="v">${t.contacts}</div><div class="l">Контактов</div></div>
        <div class="stat"><div class="v">${t.inbound}</div><div class="l">Входящих сообщений</div></div>
        <div class="stat"><div class="v">${t.ai}</div><div class="l">Ответов AI</div></div>
        <div class="stat"><div class="v">${t.owner}</div><div class="l">Ваших ответов</div></div>
        <div class="stat"><div class="v">${t.handoffs}</div><div class="l">Передано вам</div></div>
        <div class="stat"><div class="v">${t.failed}</div><div class="l">Не доставлено</div></div>
      </div>
      <div class="card"><h3>Входящие сообщения за 14 дней</h3>${bars(st.days, "inbound", "day")}</div>
      <div class="card"><h3>Ответы AI за 14 дней</h3>${bars(st.days, "ai", "day")}</div>
      <div class="card"><h3>Последние события</h3>${
        st.events.length
          ? st.events
              .map(
                (e) => `<div class="status-row small"><span>${esc(kinds[e.kind] || e.kind)}${e.wa_id ? ` · <a href="#chat/${encodeURIComponent(e.wa_id)}">${esc(e.name || "+" + e.wa_id)}</a>` : ""}<br><span class="muted">${esc(e.detail)}</span></span><span class="muted">${fmtTime(e.created_at)}</span></div>`,
              )
              .join("")
          : '<p class="muted">Событий пока нет</p>'
      }</div>`;
    $("#to-costs").addEventListener("click", () => (location.hash = "#costs"));
    applyBarHeights();
  }

  async function renderCosts() {
    title("Расходы на API");
    const c = await api("GET", "/api/costs");
    const pct = c.monthly_budget > 0 ? Math.min(100, (c.month_spend / c.monthly_budget) * 100) : 0;
    view.innerHTML = `
      <div class="seg"><button id="to-stats">Статистика</button><button class="on">Расходы API</button></div>
      <div class="card">
        <h3>Этот месяц</h3>
        <div class="stat"><div class="v">${money(c.month_spend)}</div><div class="l">из лимита ${c.monthly_budget > 0 ? money(c.monthly_budget) : "(лимит не задан)"}</div></div>
        <div class="meter"><span data-w="${pct.toFixed(1)}" class="${pct >= 90 ? "hot" : ""}"></span></div>
        <p class="muted small">Средняя стоимость одного ответа AI: ${money(c.avg_per_reply)}. Когда лимит исчерпан, AI перестаёт отвечать и передаёт клиентов вам.</p>
        <label class="field">Месячный лимит, $ (0 = без лимита)</label>
        <div class="row"><input type="text" id="budget" class="grow" inputmode="decimal" autocomplete="off" value="${c.monthly_budget}"><button class="btn primary" id="budget-save">Сохранить</button></div>
        <p class="muted small">Оценка по прайсу Anthropic; точная сумма — в консоли Claude (platform.claude.com → Billing). Рекомендуется также поставить лимит расходов там.</p>
      </div>
      <div class="card"><h3>По дням</h3>${c.byDay.length ? bars(c.byDay.map((d) => ({ ...d, cost_c: Math.round(d.cost * 10000) })), "cost_c", "day") : '<p class="muted">Нет расходов в этом месяце</p>'}</div>
      <div class="card"><h3>По моделям</h3><table><tr><th>Модель</th><th class="num">Вызовов</th><th class="num">Сумма</th></tr>${c.byModel
        .map((m) => `<tr><td>${esc(m.kind === "stt" ? "🎤 " + m.model : m.model)}</td><td class="num">${m.calls}</td><td class="num">${money(m.cost)}</td></tr>`)
        .join("")}</table></div>
      <div class="card"><h3>По месяцам</h3><table>${c.months.map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${money(m.cost)}</td></tr>`).join("")}</table></div>`;
    $("#to-stats").addEventListener("click", () => (location.hash = "#stats"));
    $("#budget-save").addEventListener("click", async () => {
      const v = Number(String($("#budget").value).replace(/\s/g, "").replace(",", "."));
      if (!Number.isFinite(v) || v < 0) return toast("Введите число, например 10", true);
      try {
        await api("PUT", "/api/settings", { monthly_budget_usd: v });
        toast(v > 0 ? "Лимит: $" + v + " в месяц ✓" : "Лимит отключён");
        renderCosts();
      } catch (err) {
        toast(err.message, true);
      }
    });
    applyBarHeights();
  }

  // ---------------- Settings ----------------
  async function renderSettingsMenu() {
    title("Настройки");
    view.innerHTML = `
      <div class="list menu">
        <a href="#ai-settings"><span>🤖 Настройки AI</span><span>›</span></a>
        <a href="#campaigns"><span>📢 Рассылки и напоминания</span><span>›</span></a>
        <a href="#whatsapp"><span>📱 Подключение WhatsApp</span><span>›</span></a>
        <a href="#costs"><span>💸 Расходы на API</span><span>›</span></a>
        <a href="#privacy"><span>🔒 Данные и безопасность</span><span>›</span></a>
      </div>
      <p></p>
      <button class="btn wide" id="logout">Выйти</button>
      <p class="muted small">Совет: в Safari нажмите «Поделиться» → «На экран Домой», чтобы панель открывалась как приложение.</p>`;
    $("#logout").addEventListener("click", async () => {
      await api("POST", "/api/logout").catch(() => {});
      showLogin();
    });
  }

  async function renderAiSettings() {
    title("Настройки AI");
    const { settings: s, models } = await api("GET", "/api/settings");
    const modelNames = {
      "claude-opus-5-5": "Claude Opus 5.5 — умная (рекомендуется)",
      "claude-sonnet-5-5": "Claude Sonnet 5.5 — в 2 раза дешевле",
      "claude-haiku-5-5": "Claude Haiku 5.5 — самая дешёвая",
      "claude-fable-5-2": "Claude Fable 5.2 — самая мощная, дорогая",
      "claude-opus-5": "Claude Opus 5",
      "claude-sonnet-5": "Claude Sonnet 5",
    };
    const chk = (id, label, hint) =>
      `<label class="check"><span>${label}${hint ? `<br><span class="muted small">${hint}</span>` : ""}</span><input type="checkbox" id="${id}" ${s[id] ? "checked" : ""}></label>`;
    view.innerHTML = `
      <div class="card">
        <label class="field">Модель Claude</label>
        <select id="model">${models.map((m) => `<option value="${m}" ${m === s.model ? "selected" : ""}>${esc(modelNames[m] || m)}</option>`).join("")}</select>
        <label class="field">Глубина размышлений</label>
        <select id="effort">
          <option value="low" ${s.effort === "low" ? "selected" : ""}>Быстро и дёшево (рекомендуется для чата)</option>
          <option value="medium" ${s.effort === "medium" ? "selected" : ""}>Средне</option>
          <option value="high" ${s.effort === "high" ? "selected" : ""}>Тщательно (дороже)</option>
        </select>
        <label class="field">Как часто передавать разговор мне</label>
        <select id="handoff_mode">
          <option value="rare" ${s.handoff_mode === "rare" ? "selected" : ""}>Редко — AI ведёт разговор сам (только жалобы, возвраты, просьба позвать владельца, подтверждение заказа)</option>
          <option value="balanced" ${s.handoff_mode === "balanced" ? "selected" : ""}>Средне — только когда без меня никак (рекомендуется)</option>
          <option value="strict" ${s.handoff_mode === "strict" ? "selected" : ""}>Часто — при любом сомнении</option>
        </select>
        <label class="field">Месячный лимит расходов, $ (0 = без лимита)</label>
        <input type="text" id="monthly_budget_usd" inputmode="decimal" autocomplete="off" value="${s.monthly_budget_usd}">
        <label class="field">Максимальная длина ответа, символов</label>
        <input type="number" id="max_reply_chars" min="100" max="4000" value="${s.max_reply_chars}">
        <label class="field">Сколько последних сообщений помнит AI в диалоге</label>
        <input type="number" id="history_messages" min="4" max="100" value="${s.history_messages}">
        <label class="field">Часовой пояс</label>
        <input type="text" id="timezone" value="${esc(s.timezone)}">
      </div>
      <div class="card">
        <label class="field">Режим работы AI</label>
        <select id="business_mode">
          <option value="sales" ${s.business_mode === "sales" ? "selected" : ""}>🛒 Продажи (каталог, заказы, Kaspi)</option>
          <option value="recruiting" ${s.business_mode === "recruiting" ? "selected" : ""}>💼 Найм сотрудников (вакансии, запись на собеседование)</option>
          <option value="general" ${s.business_mode === "general" ? "selected" : ""}>💬 Просто консультации</option>
        </select>
        <div id="hr-box" class="${s.business_mode === "recruiting" ? "" : "hidden"}">
          <label class="field">Вакансии: должность, обязанности, зарплата, график, требования, адрес</label>
          <textarea id="vacancies" class="big" placeholder="Продавец-консультант. Алматы, ТРЦ ... График 2/2 с 10:00 до 22:00. Зарплата 250 000 ₸ + бонусы. Требования: опыт продаж желателен, грамотная речь.">${esc(s.vacancies)}</textarea>
          <label class="field">Вопросы кандидату (AI задаст их по одному)</label>
          <textarea id="screening_questions" placeholder="Как вас зовут? В каком городе живёте? Есть ли опыт работы продавцом? Когда готовы выйти на работу?">${esc(s.screening_questions)}</textarea>
          <label class="field">График собеседований: дни, часы, длительность, адрес или формат</label>
          <textarea id="interview_schedule" placeholder="Пн–Пт с 11:00 до 17:00, каждые 30 минут. Адрес: Алматы, ул. Абая 10, офис 5. С собой: удостоверение личности.">${esc(s.interview_schedule)}</textarea>
          ${chk("interview_reminder_enabled", "Напоминать кандидату о собеседовании", "AI сам напишет за N часов и спросит, придёт ли. «Иә, келемін» → отметка ✅ в записи")}
          <label class="field">За сколько часов напоминать</label>
          <input type="text" inputmode="decimal" id="interview_reminder_hours" value="${s.interview_reminder_hours}">
          <label class="field">Текст напоминания ({name} — имя, {time} — время, {date} — дата, {place} — адрес)</label>
          <textarea id="interview_reminder_text" class="short">${esc(s.interview_reminder_text)}</textarea>
          <label class="field">Шаблон Meta, если с последнего сообщения кандидата прошло больше 24 ч (необязательно, платно). Переменные шаблона: {{1}} — имя, {{2}} — время</label>
          <input type="text" id="interview_template_name" placeholder="napominanie_sobes" value="${esc(s.interview_template_name)}">
          <p class="muted small">Без шаблона: если прошло больше 24 часов, AI написать не сможет (правило WhatsApp) — вам придёт уведомление напомнить вручную.</p>
        </div>
        <div id="sales-box" class="${s.business_mode === "sales" ? "" : "hidden"}">
        ${chk("sales_mode", "Режим продаж", "AI выясняет потребность, предлагает из каталога, отвечает на возражения, оформляет заказ и даёт реквизиты для оплаты")}
        <label class="field">Как оплатить (AI отправит это клиенту после подтверждения заказа)</label>
        <textarea id="payment_instructions" placeholder="Оплата через Kaspi: переведите на номер +7 7XX XXX XX XX (Имя Ф.) или по ссылке Kaspi Pay: ... После оплаты пришлите, пожалуйста, чек.">${esc(s.payment_instructions)}</textarea>
        <label class="field">Доставка и получение</label>
        <textarea id="delivery_info" placeholder="Доставка по всему Казахстану: по городу — 1000 ₸, 1 день; в другие города — Kazpost/СДЭК 1500–2500 ₸, 2–5 дней. Самовывоз: адрес...">${esc(s.delivery_info)}</textarea>
        </div>
      </div>
      <div class="card">
        ${chk("human_style", "Писать как живой человек", "Коротко, без шаблонных фраз робота, от лица бизнеса; длинный ответ — 2–3 сообщениями. Если клиент прямо спросит «вы бот?», AI честно ответит.")}
        ${chk("human_delay", "Пауза «печатает…» перед ответом", "2–9 секунд в зависимости от длины, как у человека")}
        ${chk("disclosure_enabled", "Сообщать, что отвечает AI", "Первое сообщение каждому новому клиенту начинается с этого текста")}
        <textarea id="disclosure_text">${esc(s.disclosure_text)}</textarea>
        ${chk("pause_after_handoff", "Замолкать после передачи владельцу", "Выключено (рекомендуется): AI сообщает вам и продолжает разговор, пока вы сами не напишете клиенту. Включено: AI молчит в этом диалоге до вашего ответа.")}
        <label class="field">Сообщение клиенту при передаче владельцу</label>
        <textarea id="handoff_message">${esc(s.handoff_message)}</textarea>
        <label class="field">Когда вы отвечаете сами, AI молчит в этом диалоге (часов)</label>
        <input type="number" id="owner_takeover_hours" min="0" max="720" value="${s.owner_takeover_hours}">
        ${chk("auto_learn_style", "Учиться на моих ответах", "AI смотрит на ваши последние ручные ответы и подражает стилю")}
        ${chk("send_read_receipts", "Отмечать прочитанным и показывать «печатает…»")}
      </div>
      <div class="card">
        <label class="field">Стоп-слова (клиент пишет одно из них — автоответы для него отключаются), через запятую</label>
        <input type="text" id="opt_out_words" value="${esc(s.opt_out_words)}">
        <label class="field">Ответ на стоп-слово</label>
        <textarea id="opt_out_reply">${esc(s.opt_out_reply)}</textarea>
        <label class="field">Максимум ответов AI одному клиенту в час (защита от зацикливания с другими ботами)</label>
        <input type="number" id="max_ai_replies_per_hour" min="1" max="500" value="${s.max_ai_replies_per_hour}">
      </div>
      <button class="btn primary wide" id="save">Сохранить</button>`;
    $("#business_mode").addEventListener("change", (e) => {
      $("#hr-box").classList.toggle("hidden", e.target.value !== "recruiting");
      $("#sales-box").classList.toggle("hidden", e.target.value !== "sales");
    });
    $("#save").addEventListener("click", async () => {
      const num = (id) => Number(String($("#" + id).value).replace(/\s/g, "").replace(",", "."));
      try {
        await api("PUT", "/api/settings", {
          model: $("#model").value,
          handoff_mode: $("#handoff_mode").value,
          effort: $("#effort").value,
          monthly_budget_usd: num("monthly_budget_usd"),
          max_reply_chars: num("max_reply_chars"),
          history_messages: num("history_messages"),
          timezone: $("#timezone").value.trim() || "Asia/Almaty",
          disclosure_enabled: $("#disclosure_enabled").checked,
          human_style: $("#human_style").checked,
          human_delay: $("#human_delay").checked,
          sales_mode: $("#sales_mode").checked,
          business_mode: $("#business_mode").value,
          vacancies: $("#vacancies").value,
          screening_questions: $("#screening_questions").value,
          interview_schedule: $("#interview_schedule").value,
          interview_reminder_enabled: $("#interview_reminder_enabled").checked,
          interview_reminder_hours: Math.min(23, Math.max(1, Number(String($("#interview_reminder_hours").value).replace(",", ".")) || 5)),
          interview_reminder_text: $("#interview_reminder_text").value,
          interview_template_name: $("#interview_template_name").value.trim(),
          payment_instructions: $("#payment_instructions").value,
          delivery_info: $("#delivery_info").value,
          disclosure_text: $("#disclosure_text").value,
          pause_after_handoff: $("#pause_after_handoff").checked,
          handoff_message: $("#handoff_message").value,
          owner_takeover_hours: num("owner_takeover_hours"),
          auto_learn_style: $("#auto_learn_style").checked,
          send_read_receipts: $("#send_read_receipts").checked,
          opt_out_words: $("#opt_out_words").value,
          opt_out_reply: $("#opt_out_reply").value,
          max_ai_replies_per_hour: num("max_ai_replies_per_hour"),
        });
        toast("Сохранено ✓");
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ---------------- Embedded Signup (own number, coexistence) ----------------
  function loadFacebookSdk(appId, version) {
    if (window.FB) return Promise.resolve(window.FB);
    return new Promise((resolve, reject) => {
      window.fbAsyncInit = () => {
        window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
        resolve(window.FB);
      };
      const sc = document.createElement("script");
      sc.src = "https://connect.facebook.net/en_US/sdk.js";
      sc.async = true;
      sc.crossOrigin = "anonymous";
      sc.onerror = () => reject(new Error("Не удалось загрузить окно Meta. Проверьте интернет и попробуйте снова."));
      document.body.appendChild(sc);
    });
  }

  // Must run synchronously inside the tap, otherwise Safari blocks the Meta popup.
  function startEmbeddedSignup(su) {
    const status = (t) => ($("#own-status") ? ($("#own-status").textContent = t) : null);
    const FB = window.FB;
    if (!FB) {
      status("Окно Meta ещё загружается — нажмите кнопку ещё раз через пару секунд.");
      loadFacebookSdk(su.app_id, su.graph_version).catch((err) => status(err.message));
      return;
    }
    status("Открываю окно Meta…");
    let ids = {};
    let code = null;
    let finished = false;
    const onMessage = (event) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
      let data;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (!data || data.type !== "WA_EMBEDDED_SIGNUP") return;
      const ev = String(data.event || "");
      const d = data.data || {};
      if (ev.startsWith("FINISH")) {
        ids = { phone_number_id: d.phone_number_id ? String(d.phone_number_id) : undefined, waba_id: d.waba_id ? String(d.waba_id) : undefined };
        status("Meta подтвердила номер…");
      } else if (ev === "CANCEL") {
        status(d.current_step ? `Окно закрыто на шаге: ${d.current_step}` : "Окно закрыто");
      } else if (ev === "ERROR") {
        status("Ошибка Meta: " + (d.error_message || "неизвестно"));
      }
    };
    window.addEventListener("message", onMessage);
    const send = async () => {
      if (finished || !code) return;
      finished = true;
      window.removeEventListener("message", onMessage);
      status("Подключаю номер к серверу…");
      try {
        const r = await api("POST", "/api/whatsapp/signup", { code, ...ids });
        toast("Номер подключён: " + (r.phone || "") + " ✓");
        renderWhatsapp();
      } catch (err) {
        status("");
        toast(err.message, true);
      }
    };
    FB.login(
      (response) => {
        if (response && response.authResponse && response.authResponse.code) {
          code = response.authResponse.code;
          // give the FINISH message a moment to arrive (it carries the number id)
          setTimeout(send, 1500);
        } else {
          window.removeEventListener("message", onMessage);
          status("Подключение не завершено. Можно попробовать ещё раз.");
        }
      },
      {
        config_id: su.config_id,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: su.session_info_version },
      },
    );
  }

  async function renderWhatsapp() {
    title("Подключение WhatsApp");
    const st = await api("GET", "/api/whatsapp/status");
    const i = st.integrations;
    const ok = (v) => (v ? "✅" : "❌");
    const p = st.phone || {};
    const su = st.signup || {};
    const conn = st.connection || {};
    view.innerHTML = `
      <div class="card">
        <h3>📲 Мой номер WhatsApp Business</h3>
        ${
          conn.source === "own"
            ? `<div class="banner ok">Подключён ваш номер <b>${esc(conn.phone || "")}</b>${conn.name ? " (" + esc(conn.name) + ")" : ""}. Приложение WhatsApp Business на телефоне продолжает работать.</div>
               <button class="btn danger wide" id="own-disconnect">Вернуться на тестовый номер</button>`
            : su.ready
              ? `<p class="small">Подключите номер, который уже работает в приложении <b>WhatsApp Business</b> на вашем телефоне. Приложение продолжит работать, а AI будет отвечать клиентам. Понадобится телефон с этим номером — нужно будет отсканировать QR-код в приложении.</p>
                 <button class="btn primary wide" id="own-connect">Подключить мой номер</button>
                 <p class="muted small" id="own-status"></p>`
              : `<div class="banner warn small">Чтобы подключить свой номер, добавьте в Render переменные: <b>${esc((su.missing || []).join(", "))}</b> (инструкция в docs/SETUP_RU.md, раздел «Свой номер»).</div>`
        }
      </div>
      <div class="card">
        <h3>Состояние</h3>
        <div class="status-row"><span>Токен WhatsApp и ID номера</span><span>${ok(i.whatsapp)}</span></div>
        ${i.whatsappProblem ? `<div class="banner danger small">${esc(i.whatsappProblem)}</div>` : ""}
        <div class="status-row"><span>Секрет приложения (проверка подписи webhook)</span><span>${ok(i.webhookSignature)}</span></div>
        <div class="status-row"><span>Verify token для webhook</span><span>${ok(i.webhookVerifyToken)}</span></div>
        <div class="status-row"><span>Ключ Claude API</span><span>${ok(i.claude)}</span></div>
        <div class="status-row"><span>Распознавание голосовых</span><span>${i.speechToText ? "✅" : "— не подключено"}</span></div>
        <div class="status-row"><span>Push-уведомления (ntfy)</span><span>${i.notifications ? "✅" : "— не подключено"}</span></div>
        <div class="status-row"><span>База данных</span><span>${i.database === "postgres" ? "Postgres ✅" : "встроенная"}</span></div>
      </div>
      <div class="card">
        <h3>Номер</h3>
        ${
          st.phone
            ? `<div class="status-row"><span>Номер</span><b>${esc(p.display_phone_number)}</b></div>
               <div class="status-row"><span>Имя</span><span>${esc(p.verified_name)}</span></div>
               <div class="status-row"><span>Качество</span><span>${esc(p.quality_rating || "—")}</span></div>
               <div class="status-row"><span>Платформа</span><span>${esc(p.platform_type || "—")}</span></div>
               <div class="status-row"><span>Лимит сообщений</span><span>${esc(p.messaging_limit_tier || "—")}</span></div>
               ${
                 p.platform_type && p.platform_type !== "CLOUD_API"
                   ? `<div class="banner warn small">Номер ещё не зарегистрирован в WhatsApp Cloud API — клиенты не смогут писать. Придумайте 6-значный PIN (запомните его: это PIN двухшаговой проверки номера) и нажмите «Зарегистрировать».</div>
                      <input type="text" inputmode="numeric" maxlength="6" id="reg-pin" placeholder="6 цифр, например 482915">
                      <button class="btn primary wide" id="reg-btn">Зарегистрировать номер</button>`
                   : ""
               }`
            : `<div class="banner ${st.phone_error ? "danger" : "warn"}">${esc(st.phone_error || "Номер не подключён")}</div>`
        }
        <div class="status-row"><span>Приложение подписано на события WABA</span><span>${st.subscribed === true ? "✅" : st.subscribed === false ? "❌" : "—"}</span></div>
        ${st.subscribed_error ? `<div class="banner danger small">${esc(st.subscribed_error)}</div>` : ""}
        <button class="btn wide" id="subscribe">Подписать приложение на сообщения</button>
      </div>
      <div class="card">
        <h3>Входящие от Meta (с момента запуска сервера ${fmtTime(st.webhook.since)})</h3>
        <div class="status-row"><span>Принято запросов</span><span>${st.webhook.okCount}${st.webhook.lastOkAt ? " · последний " + fmtTime(st.webhook.lastOkAt) : ""}</span></div>
        <div class="status-row"><span>Отклонено: неверная подпись</span><span>${st.webhook.badSignatureCount}${st.webhook.lastBadSignatureAt ? " · " + fmtTime(st.webhook.lastBadSignatureAt) : ""}</span></div>
        ${st.webhook.badSignatureCount ? '<div class="banner danger small">Meta присылает сообщения, но подпись не совпадает: значение META_APP_SECRET в Render неверное. Скопируйте «Секрет приложения» из Meta (Настройки приложения → Основное) заново и замените его в Render.</div>' : ""}
        ${st.webhook.notConfiguredCount ? '<div class="banner danger small">Сообщения приходят, но META_APP_SECRET не задан в Render.</div>' : ""}
        ${!st.webhook.okCount && !st.webhook.badSignatureCount && !st.webhook.notConfiguredCount ? '<p class="muted small">Пока ничего не приходило. Напишите на номер WhatsApp и обновите страницу через минуту.</p>' : ""}
      </div>
      <div class="card">
        <h3>Webhook для Meta</h3>
        <p class="small">Callback URL:<br><span class="code">${esc(st.webhook_url)}</span></p>
        <p class="small muted">Verify token — значение переменной WEBHOOK_VERIFY_TOKEN на сервере. Поля подписки: <span class="code">messages</span> (и <span class="code">smb_message_echoes</span>, если номер работает и в приложении WhatsApp Business).</p>
      </div>
      <div class="card">
        <h3>Проверка отправки</h3>
        <p class="small muted">Отправит шаблон <b>hello_world</b> на указанный номер. Для тестового номера Meta получатель должен быть добавлен в список разрешённых.</p>
        <input type="tel" id="test-to" placeholder="77011234567">
        <button class="btn primary wide" id="test-send">Отправить тестовое сообщение</button>
      </div>`;
    if ($("#own-disconnect"))
      $("#own-disconnect").addEventListener("click", async () => {
        if (!confirm("Отключить ваш номер от AI и вернуться на номер из настроек Render? Приложение WhatsApp Business на телефоне продолжит работать.")) return;
        try {
          await api("POST", "/api/whatsapp/disconnect-own");
          toast("Готово");
          renderWhatsapp();
        } catch (err) {
          toast(err.message, true);
        }
      });
    if ($("#own-connect")) {
      loadFacebookSdk(su.app_id, su.graph_version).catch((err) => ($("#own-status").textContent = err.message));
      $("#own-connect").addEventListener("click", () => {
        try {
          startEmbeddedSignup(su);
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
    if ($("#reg-btn"))
      $("#reg-btn").addEventListener("click", async () => {
        const pin = $("#reg-pin").value.trim();
        if (!/^\d{6}$/.test(pin)) return toast("PIN — ровно 6 цифр", true);
        try {
          await api("POST", "/api/whatsapp/register", { pin });
          toast("Номер зарегистрирован ✓ Сохраните PIN в «Заметках».");
          renderWhatsapp();
        } catch (err) {
          toast(err.message, true);
        }
      });
    $("#subscribe").addEventListener("click", async () => {
      try {
        await api("POST", "/api/whatsapp/subscribe");
        toast("Готово ✓");
        renderWhatsapp();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#test-send").addEventListener("click", async () => {
      const to = $("#test-to").value.replace(/[^\d]/g, "");
      if (!to) return toast("Введите номер в международном формате", true);
      if (!confirm(`Отправить реальное тестовое сообщение WhatsApp на +${to}?`)) return;
      try {
        const r = await api("POST", "/api/whatsapp/test-message", { to, confirm: true });
        toast("Отправлено ✓ ID: " + (r.message_id || "").slice(0, 16) + "…");
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  async function renderCampaigns() {
    title("Рассылки и напоминания");
    const [{ settings: s }, bc] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/broadcasts")]);
    let templates = [];
    let tplError = "";
    try {
      templates = (await api("GET", "/api/templates")).items;
    } catch (err) {
      tplError = err.message;
    }
    const approved = templates.filter((t) => t.status === "APPROVED");
    const statusName = { APPROVED: "✅ одобрен", PENDING: "⏳ на проверке", REJECTED: "❌ отклонён", PAUSED: "⏸ приостановлен", DISABLED: "⛔ отключён" };
    const catName = { MARKETING: "реклама", UTILITY: "сервисное", AUTHENTICATION: "код" };
    const bStatus = { scheduled: "🕒 запланирована", running: "📤 отправляется", done: "✅ завершена", cancelled: "✖ отменена" };
    view.innerHTML = `
      <h2>🔔 Напоминание клиенту</h2>
      <div class="card">
        <label class="check"><span>Напоминать, если клиент замолчал<br><span class="muted small">AI один раз напишет короткое сообщение по теме разговора. Бесплатно: только в течение 24 часов после сообщения клиента.</span></span><input type="checkbox" id="fu-on" ${s.followup_enabled ? "checked" : ""}></label>
        <label class="check"><span>Настойчиво для всех клиентов<br><span class="muted small">AI пишет повторно каждые N часов, пока человек не ответит (последний раз ~через 21 час, пока WhatsApp бесплатно). Для отдельных клиентов можно изменить в диалоге.</span></span><input type="checkbox" id="fu-all" ${s.followup_persistent_all ? "checked" : ""}></label>
        <label class="field">Через сколько часов после последнего ответа AI</label>
        <input type="text" inputmode="decimal" id="fu-hours" value="${s.followup_hours}">
        <label class="field">Режим «настойчиво»: максимум напоминаний одному клиенту</label>
        <input type="text" inputmode="numeric" id="fu-max" value="${s.followup_max}">
        <p class="muted small">«Настойчиво» включается в диалоге конкретного клиента (🔔 Напоминания). AI пишет каждые N часов, пока клиент не ответит, и последнее — примерно через 21 час после сообщения клиента, пока окно WhatsApp ещё бесплатное. После 23 часов ничего не отправляется.</p>
        <button class="btn primary wide" id="fu-save">Сохранить</button>
        <p class="muted small">Не отправляется, если разговор передан вам, вы ведёте переписку сами, клиент отписался или AI выключен.</p>
      </div>

      <h2>📢 Рассылка</h2>
      <div class="banner warn small">Рассылка — это <b>платные</b> сообщения по шаблонам, одобренным Meta (≈ $${s.template_price_usd} за сообщение — оценка, точная цена в Meta). Отправляйте только клиентам, которые согласны получать от вас сообщения, иначе Meta может ограничить номер. Получатели — только те, кто уже писал вам; отписавшиеся пропускаются.</div>
      <div class="card">
        <h3>Новая рассылка</h3>
        ${tplError ? `<div class="banner danger small">${esc(tplError)}</div>` : ""}
        <label class="field">Шаблон (только одобренные Meta)</label>
        <select id="bc-tpl">${approved.length ? approved.map((t, i) => `<option value="${i}">${esc(t.name)} · ${esc(t.language)} · ${esc(catName[t.category] || t.category)}</option>`).join("") : '<option value="">Нет одобренных шаблонов — создайте ниже</option>'}</select>
        <p class="muted small" id="bc-body"></p>
        <label class="field">Кому</label>
        <select id="bc-days">
          <option value="7">Писали за последние 7 дней</option>
          <option value="30" selected>Писали за последние 30 дней</option>
          <option value="90">Писали за последние 90 дней</option>
          <option value="0">Все, кто когда-либо писал</option>
        </select>
        <label class="field">Когда отправить (пусто — сразу)</label>
        <input type="datetime-local" id="bc-when">
        <p id="bc-preview" class="small"></p>
        <div class="row"><button class="btn grow" id="bc-calc">Посчитать</button><button class="btn primary grow" id="bc-send" ${approved.length ? "" : "disabled"}>Отправить</button></div>
      </div>
      <div class="card">
        <h3>История рассылок</h3>
        ${
          bc.items.length
            ? bc.items
                .map(
                  (b) => `<div class="status-row small"><span><b>${esc(b.template_name)}</b> · ${esc(bStatus[b.status] || b.status)}<br><span class="muted">${fmtTime(b.scheduled_at)} · отправлено ${b.sent} из ${b.total}${b.failed ? ` · ошибок ${b.failed}` : ""}</span></span>${["scheduled", "running"].includes(b.status) ? `<button class="btn danger" data-bc-cancel="${b.id}">Отменить</button>` : ""}</div>`,
                )
                .join("")
            : '<p class="muted small">Рассылок пока не было.</p>'
        }
      </div>

      <h2>📝 Шаблоны сообщений</h2>
      <div class="card">
        <h3>Создать шаблон</h3>
        <p class="muted small">Meta проверяет шаблон от нескольких минут до 24 часов. Вместо имени клиента напишите <b>{{1}}</b>. Не используйте ссылки-сокращатели и агрессивную рекламу — такие шаблоны отклоняют.</p>
        <label class="field">Системное имя (латиница, цифры, _)</label>
        <input type="text" id="tp-name" placeholder="aksiya_noyabr" autocapitalize="off" autocorrect="off">
        <label class="field">Тип</label>
        <select id="tp-cat"><option value="MARKETING">Реклама / акция</option><option value="UTILITY">Сервисное (напоминание о записи, заказе)</option></select>
        <label class="field">Язык</label>
        <select id="tp-lang"><option value="kk">Қазақша</option><option value="ru">Русский</option></select>
        <label class="field">Текст</label>
        <textarea id="tp-body" placeholder="Сәлеметсіз бе, {{1}}! Бұл аптада барлық қызметтерге 20% жеңілдік бар. Жазылғыңыз келсе, осы чатқа жазыңыз."></textarea>
        <button class="btn primary wide" id="tp-save">Отправить на проверку в Meta</button>
      </div>
      <div class="list">${
        templates.length
          ? templates
              .map(
                (t) => `<div class="item"><div class="body"><div class="top"><span class="name">${esc(t.name)} · ${esc(t.language)}</span><span class="time">${esc(statusName[t.status] || t.status)}</span></div><div class="preview">${esc(t.body)}</div>${t.rejected_reason ? `<div class="small error">Причина: ${esc(t.rejected_reason)}</div>` : ""}</div></div>`,
              )
              .join("")
          : '<div class="item"><div class="body muted">Шаблонов пока нет.</div></div>'
      }</div>`;

    const showBody = () => {
      const t = approved[Number($("#bc-tpl").value)];
      $("#bc-body").textContent = t ? "Текст: " + t.body : "";
    };
    showBody();
    $("#bc-tpl").addEventListener("change", showBody);

    $("#fu-save").addEventListener("click", async () => {
      const h = Number(String($("#fu-hours").value).replace(",", "."));
      if (!(h >= 0.5 && h <= 20)) return toast("Часы: от 0.5 до 20", true);
      const mx = Number($("#fu-max").value);
      if (!(Number.isInteger(mx) && mx >= 1 && mx <= 10)) return toast("Максимум: от 1 до 10", true);
      try {
        await api("PUT", "/api/settings", { followup_enabled: $("#fu-on").checked, followup_persistent_all: $("#fu-all").checked, followup_hours: h, followup_max: mx });
        toast("Сохранено ✓");
      } catch (err) {
        toast(err.message, true);
      }
    });

    const preview = async () => {
      const r = await api("POST", "/api/broadcasts/preview", { audience_days: Number($("#bc-days").value) });
      $("#bc-preview").textContent = `Получателей: ${r.count}. Примерная стоимость: ${money(r.est_cost_usd)}.`;
      return r;
    };
    $("#bc-calc").addEventListener("click", () => preview().catch((err) => toast(err.message, true)));
    $("#bc-send").addEventListener("click", async () => {
      const t = approved[Number($("#bc-tpl").value)];
      if (!t) return toast("Выберите шаблон", true);
      try {
        const r = await preview();
        if (!r.count) return toast("Нет получателей", true);
        const whenVal = $("#bc-when").value;
        const when = whenVal ? new Date(whenVal) : null;
        if (when && isNaN(when.getTime())) return toast("Неверная дата", true);
        const whenText = when ? "в " + when.toLocaleString("ru-RU") : "сейчас";
        if (!confirm(`Отправить рассылку «${t.name}» ${r.count} клиентам ${whenText}?\nПримерная стоимость: ${money(r.est_cost_usd)}.\nЭто реальные платные сообщения.`)) return;
        await api("POST", "/api/broadcasts", {
          template_name: t.name,
          language: t.language,
          audience_days: Number($("#bc-days").value),
          scheduled_at: when ? when.toISOString() : null,
          confirm: true,
        });
        toast(when ? "Рассылка запланирована ✓" : "Рассылка запущена ✓");
        renderCampaigns();
      } catch (err) {
        toast(err.message, true);
      }
    });
    view.querySelectorAll("[data-bc-cancel]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm("Отменить рассылку? Уже отправленные сообщения не отзываются.")) return;
        try {
          await api("POST", `/api/broadcasts/${btn.dataset.bcCancel}/cancel`);
          renderCampaigns();
        } catch (err) {
          toast(err.message, true);
        }
      }),
    );
    $("#tp-save").addEventListener("click", async () => {
      const body = $("#tp-body").value.trim();
      const name = $("#tp-name").value.trim().toLowerCase();
      if (!name || !body) return toast("Заполните имя и текст", true);
      try {
        await api("POST", "/api/templates", { name, category: $("#tp-cat").value, language: $("#tp-lang").value, body });
        toast("Шаблон отправлен на проверку ✓");
        renderCampaigns();
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  async function renderPrivacy() {
    title("Данные и безопасность");
    const { settings: s } = await api("GET", "/api/settings");
    view.innerHTML = `
      <div class="card">
        <label class="field">Хранить переписку, дней (старое удаляется автоматически; 0 = хранить всегда)</label>
        <input type="number" id="retention_days" min="0" max="3650" value="${s.retention_days}">
        <button class="btn primary wide" id="save">Сохранить</button>
      </div>
      <div class="card small">
        <h3>Как защищены данные</h3>
        <p>• Ключи API хранятся только в переменных окружения сервера, не в GitHub и не в базе.</p>
        <p>• Каждый запрос от Meta проверяется по цифровой подписи (X-Hub-Signature-256); поддельные отклоняются.</p>
        <p>• Вход в панель — по паролю, с защитой от подбора; сессия в защищённой cookie.</p>
        <p>• Голосовые и фото не сохраняются на сервере — только текст расшифровки.</p>
        <p>• В push-уведомления не попадает текст сообщений клиентов.</p>
        <p>• Данные любого клиента можно удалить кнопкой «Удалить данные» в диалоге.</p>
      </div>`;
    $("#save").addEventListener("click", async () => {
      try {
        await api("PUT", "/api/settings", { retention_days: Number($("#retention_days").value) });
        toast("Сохранено ✓");
      } catch (err) {
        toast(err.message, true);
      }
    });
  }

  // ---------------- Start ----------------
  async function start() {
    try {
      await refreshOverview();
    } catch {
      return showLogin();
    }
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    route();
  }
  start();
})();
