"use strict";
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (v) => "$" + Number(v || 0).toFixed(Number(v || 0) < 1 ? 4 : 2);
  let pollTimer = null;
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
    const tabFor = { chat: "chats", costs: "stats", "ai-settings": "settings", whatsapp: "settings", privacy: "settings" };
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
    if (!o.integrations.whatsapp) warn.push(`<div class="banner danger">WhatsApp не подключён. Откройте Настройки → Подключение WhatsApp.</div>`);
    if (!o.integrations.claude) warn.push(`<div class="banner danger">Ключ Claude API не задан.</div>`);
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
              <div>${c.needs_attention ? '<span class="pill att">Нужен владелец</span>' : ""}${!c.ai_enabled ? '<span class="pill off">AI выкл</span>' : ""}${paused ? '<span class="pill pause">Вы ведёте</span>' : ""}${c.unread ? `<span class="pill unread">${c.unread}</span>` : ""}</div>
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
        <button class="btn danger" data-a="delete">🗑 Удалить данные</button>`;
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
          meta: (r.handoff ? "➡️ передано владельцу: " + r.handoff_reason + " · " : "") + money(r.cost_usd),
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

  // ---------------- Knowledge base ----------------
  async function renderKb() {
    title("База знаний");
    const { items } = await api("GET", "/api/knowledge");
    const total = items.filter((i) => i.enabled).reduce((a, i) => a + Number(i.chars), 0);
    view.innerHTML = `
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
    const kinds = { handoff: "➡️ Передано владельцу", error: "❗ Ошибка", optout: "🚫 Отказ от автоответов", budget: "💸 Лимит расходов", loop_guard: "🔁 Защита от зацикливания" };
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
        <p class="muted small">Средняя стоимость одного ответа AI: ${money(c.avg_per_reply)}. Когда лимит исчерпан, AI перестаёт отвечать и передаёт клиентов вам. Лимит меняется в Настройки → Настройки AI.</p>
        <p class="muted small">Оценка по прайсу Anthropic; точная сумма — в консоли Claude (platform.claude.com → Billing). Рекомендуется также поставить лимит расходов там.</p>
      </div>
      <div class="card"><h3>По дням</h3>${c.byDay.length ? bars(c.byDay.map((d) => ({ ...d, cost_c: Math.round(d.cost * 10000) })), "cost_c", "day") : '<p class="muted">Нет расходов в этом месяце</p>'}</div>
      <div class="card"><h3>По моделям</h3><table><tr><th>Модель</th><th class="num">Вызовов</th><th class="num">Сумма</th></tr>${c.byModel
        .map((m) => `<tr><td>${esc(m.kind === "stt" ? "🎤 " + m.model : m.model)}</td><td class="num">${m.calls}</td><td class="num">${money(m.cost)}</td></tr>`)
        .join("")}</table></div>
      <div class="card"><h3>По месяцам</h3><table>${c.months.map((m) => `<tr><td>${esc(m.month)}</td><td class="num">${money(m.cost)}</td></tr>`).join("")}</table></div>`;
    $("#to-stats").addEventListener("click", () => (location.hash = "#stats"));
    applyBarHeights();
  }

  // ---------------- Settings ----------------
  async function renderSettingsMenu() {
    title("Настройки");
    view.innerHTML = `
      <div class="list menu">
        <a href="#ai-settings"><span>🤖 Настройки AI</span><span>›</span></a>
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
        <label class="field">Месячный лимит расходов, $ (0 = без лимита)</label>
        <input type="number" id="monthly_budget_usd" min="0" step="1" value="${s.monthly_budget_usd}">
        <label class="field">Максимальная длина ответа, символов</label>
        <input type="number" id="max_reply_chars" min="100" max="4000" value="${s.max_reply_chars}">
        <label class="field">Сколько последних сообщений помнит AI в диалоге</label>
        <input type="number" id="history_messages" min="4" max="100" value="${s.history_messages}">
        <label class="field">Часовой пояс</label>
        <input type="text" id="timezone" value="${esc(s.timezone)}">
      </div>
      <div class="card">
        ${chk("disclosure_enabled", "Сообщать, что отвечает AI", "Первое сообщение каждому новому клиенту начинается с этого текста")}
        <textarea id="disclosure_text">${esc(s.disclosure_text)}</textarea>
        ${chk("pause_after_handoff", "Пауза AI после передачи владельцу", "AI замолкает в этом диалоге, пока вы не ответите или не вернёте AI")}
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
    $("#save").addEventListener("click", async () => {
      const num = (id) => Number($("#" + id).value);
      try {
        await api("PUT", "/api/settings", {
          model: $("#model").value,
          effort: $("#effort").value,
          monthly_budget_usd: num("monthly_budget_usd"),
          max_reply_chars: num("max_reply_chars"),
          history_messages: num("history_messages"),
          timezone: $("#timezone").value.trim() || "Asia/Almaty",
          disclosure_enabled: $("#disclosure_enabled").checked,
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

  async function renderWhatsapp() {
    title("Подключение WhatsApp");
    const st = await api("GET", "/api/whatsapp/status");
    const i = st.integrations;
    const ok = (v) => (v ? "✅" : "❌");
    const p = st.phone || {};
    view.innerHTML = `
      <div class="card">
        <h3>Состояние</h3>
        <div class="status-row"><span>Токен WhatsApp и ID номера</span><span>${ok(i.whatsapp)}</span></div>
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
               <div class="status-row"><span>Лимит сообщений</span><span>${esc(p.messaging_limit_tier || "—")}</span></div>`
            : `<div class="banner ${st.phone_error ? "danger" : "warn"}">${esc(st.phone_error || "Номер не подключён")}</div>`
        }
        <div class="status-row"><span>Приложение подписано на события WABA</span><span>${st.subscribed === true ? "✅" : st.subscribed === false ? "❌" : "—"}</span></div>
        ${st.subscribed_error ? `<div class="banner danger small">${esc(st.subscribed_error)}</div>` : ""}
        <button class="btn wide" id="subscribe">Подписать приложение на сообщения</button>
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
