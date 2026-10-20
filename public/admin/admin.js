import { api, date, h, money, toast } from "/shared/api.js";
import { setLang } from "/shared/i18n.js";

// Админка только на русском: деньги, даты и ошибки сервера (X-Lang) тоже, независимо от языка браузера.
setLang("ru");

const view = document.getElementById("view");
let currency = "UZS";
const m = (v) => money(v, currency);

const eventNames = {
  login: "вход", telegram_linked: "подключил Telegram", sms_sent: "разослал SMS", bot_start: "запустил бота", invitation_created: "создал приглашение", invitation_updated: "изменил приглашение",
  invitation_published: "опубликовал приглашение", guests_added: "добавил гостей", order_created: "создал заказ", order_paid: "оплатил заказ",
  free_access_granted: "получил бесплатный доступ", free_access_revoked: "лишён бесплатного доступа", user_blocked: "заблокирован", user_unblocked: "разблокирован",
  ai_write: "написал текст с помощником",
};
const smsPurpose = { otp: "код входа", invite: "приглашение", reminder: "напоминание" };
const orderKinds = { template: "шаблон", seats: "места", subscription: "подписка" };
const orderStatus = { pending: ["ожидает", "warn"], paid: ["оплачен", "ok"], failed: ["ошибка", "bad"], cancelled: ["отменён", "bad"] };
const name = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ") || (u.username ? `@${u.username}` : u.phone ? `+${u.phone}` : `id ${u.telegramId}`);
const phone = (p) => (p ? `+${p}` : "—");
const invStatus = { draft: "черновик", active: "опубликовано", archived: "в архиве" };
const smsStatus = { queued: ["в очереди", ""], sent: ["отправлено", "warn"], delivered: ["доставлено", "ok"], failed: ["ошибка", "bad"] };
const statusBadge = (s) => h("span", { class: `badge ${orderStatus[s]?.[1] ?? ""}` }, orderStatus[s]?.[0] ?? s);

function table(headers, rows) {
  return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, headers.map((x) => h("th", {}, x)))), h("tbody", {}, rows)));
}

/** «Назад» и «Дальше» по страницам списка: ссылки на тот же раздел с теми же параметрами. */
function pager(route, params, page, hasNext, info) {
  if (page <= 1 && !hasNext) return null;
  const link = (p, text) => h("a", { class: "btn", href: `#${route}?${new URLSearchParams({ ...params, page: String(p) })}` }, text);
  return h("div", { class: "row", style: "margin-top:12px" }, page > 1 ? link(page - 1, "← Назад") : null, h("span", { class: "muted" }, info), hasNext ? link(page + 1, "Дальше →") : null);
}

/** Без сессии: вход на сайте (по телефону или через Telegram), а команда бота — только если бот работает. */
async function loginCard() {
  const cfg = await api("/api/auth/config").catch(() => ({}));
  return h("div", { class: "card" },
    h("h3", { style: "margin-top:0" }, "Нужно войти"),
    h("p", {}, h("a", { class: "btn primary", href: "/app/" }, "Войти на сайте")),
    h("p", { class: "muted" }, "После входа откройте «Админка» в меню аккаунта.", cfg.telegram ? " Можно и через Telegram-бота: команда /login." : ""));
}

const routes = {
  async "/"() {
    const s = await api("/api/admin/stats");
    const stat = (v, label) => h("div", { class: "card stat" }, h("b", {}, v), h("span", {}, label));
    return h("div", { class: "grid" },
      stat(s.users, "пользователей"), stat(s.activeLast30Days, "активных за 30 дней"), stat(s.freeAccessUsers, "с бесплатным доступом"),
      stat(s.pendingFreeAccess, "доступ выдан заранее, ещё не входили"),
      stat(s.activeSubscriptions, "активных подписок"), stat(s.invitations, "приглашений"), stat(s.paidOrders, "оплаченных заказов"),
      stat(m(s.revenue), "выручка"));
  },

  async "/users"(params) {
    const q = params.get("q") ?? "";
    const filter = params.get("filter") ?? "all";
    const page = Math.max(1, Math.floor(Number(params.get("page"))) || 1);
    const data = await api(`/api/admin/users?${new URLSearchParams({ q, filter, page: String(page) })}`);
    const search = h("input", { placeholder: "Имя, @username, телефон или Telegram ID", value: q });
    const sel = h("select", {}, Object.entries({ all: "Все", free: "Бесплатный доступ", paying: "Платившие", subscribed: "С подпиской", blocked: "Заблокированные" })
      .map(([v, t]) => h("option", { value: v, selected: v === filter }, t)));
    const go = () => (location.hash = `#/users?${new URLSearchParams({ q: search.value, filter: sel.value })}`);
    search.addEventListener("keydown", (e) => e.key === "Enter" && go());
    sel.addEventListener("change", go);

    // Телефон только с +998: девять цифр без него сервер считает Telegram ID.
    const grantId = h("input", { placeholder: "+998 90 123-45-67 или tg:123456789" });
    const grantNote = h("input", { placeholder: "Заметка (кому и почему)" });
    const setFree = async (free) => {
      try {
        await api("/api/admin/users/free-access", { method: "POST", body: { who: grantId.value, note: grantNote.value || undefined, free } });
        toast(free ? "Бесплатный доступ выдан" : "Бесплатный доступ снят");
        render();
      } catch (err) { toast(err.message, "bad"); }
    };
    const grant = h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); setFree(true); } }, grantId, grantNote,
      h("button", { class: "primary" }, "Выдать бесплатный доступ"),
      h("button", { type: "button", onclick: () => setFree(false) }, "Снять"));

    const rows = data.items.map((u) => h("tr", { class: "click", onclick: () => (location.hash = `#/user/${u.id}`) },
      h("td", {}, name(u), u.isAdmin ? h("span", { class: "badge" }, " админ") : null),
      h("td", {}, phone(u.phone)),
      h("td", {}, u.telegramId ?? "—"),
      h("td", {}, u.freeAccess ? h("span", { class: "badge ok" }, "бесплатно") : u.subscriptionEndsAt && new Date(u.subscriptionEndsAt) > new Date() ? h("span", { class: "badge ok" }, "подписка") : "—",
        u.blocked ? h("span", { class: "badge bad" }, "заблокирован") : null),
      h("td", {}, u.invitations), h("td", {}, m(u.paidTotal)), h("td", {}, date(u.lastSeenAt)), h("td", {}, date(u.createdAt))));
    return [
      h("div", { class: "card" }, h("div", { class: "row" }, search, sel, h("button", { onclick: go }, "Найти"))),
      h("div", { class: "card" }, h("h3", {}, "Бесплатный доступ по телефону или Telegram ID"), h("p", { class: "muted" }, "Можно выдать заранее, до того как человек зайдёт в бота. Телефон пишите с +998, Telegram ID — как tg:123456789 (просто цифры тоже считаются Telegram ID)."), grant),
      h("div", { class: "card" }, data.items.length ? table(["Пользователь", "Телефон", "Telegram ID", "Доступ", "Приглашений", "Оплатил", "Был", "Регистрация"], rows) : h("p", { class: "muted" }, "Никого не найдено"),
        pager("/users", { q, filter }, page, page * data.pageSize < data.total, `стр. ${page} из ${Math.max(1, Math.ceil(data.total / data.pageSize))} · всего ${data.total}`)),
    ];
  },

  async "/user"(_p, id) {
    const d = await api(`/api/admin/users/${id}`);
    const u = d.user;
    const patch = async (body, msg) => {
      try { await api(`/api/admin/users/${id}`, { method: "PATCH", body }); toast(msg); render(); } catch (err) { toast(err.message, "bad"); }
    };
    const note = h("input", { value: u.freeAccessNote ?? "", placeholder: "Заметка" });
    const activeSub = d.subscriptions.find((s) => new Date(s.endsAt) > new Date());
    return [
      h("div", { class: "card" },
        h("h2", { style: "margin-top:0" }, name(u)),
        h("p", { class: "muted" }, `Телефон ${phone(u.phone)} · Telegram ID ${u.telegramId ?? "—"}`, u.username ? ` · @${u.username}` : "", ` · язык ${u.locale} · с ${date(u.createdAt)} · был ${date(u.lastSeenAt)}`),
        h("p", {}, "Подписка: ", activeSub ? `до ${date(activeSub.endsAt)}` : "нет"),
        h("div", { class: "row" }, note,
          u.freeAccess
            ? h("button", { onclick: () => patch({ freeAccess: false }, "Бесплатный доступ снят") }, "Снять бесплатный доступ")
            : h("button", { class: "primary", onclick: () => patch({ freeAccess: true, freeAccessNote: note.value || null }, "Бесплатный доступ выдан") }, "Дать бесплатный доступ"),
          u.blocked
            ? h("button", { onclick: () => patch({ blocked: false }, "Разблокирован") }, "Разблокировать")
            : h("button", { class: "danger", onclick: () => confirm("Заблокировать пользователя?") && patch({ blocked: true }, "Заблокирован") }, "Заблокировать"))),
      h("div", { class: "card" }, h("h3", {}, `Приглашения (${d.invitations.length})`),
        d.invitations.length ? table(["Название", "Шаблон", "Тип", "Статус", "Оплачено", "Создано"], d.invitations.map(({ invitation: i, templateTitle }) => h("tr", {},
          h("td", {}, i.title), h("td", {}, templateTitle), h("td", {}, i.mode === "shared" ? "общее" : "персональное"), h("td", {}, invStatus[i.status] ?? i.status),
          h("td", {}, i.mode === "shared" ? (i.unlocked ? "да" : "нет") : `${i.paidSeats} мест`), h("td", {}, date(i.createdAt))))) : h("p", { class: "muted" }, "Нет")),
      h("div", { class: "card" }, h("h3", {}, `Платежи (${d.orders.length})`),
        d.orders.length ? table(["№", "Что", "Кол-во", "Сумма", "Статус", "Создан", "Оплачен"], d.orders.map((o) => h("tr", {},
          h("td", {}, o.number), h("td", {}, orderKinds[o.kind]), h("td", {}, o.quantity), h("td", {}, m(o.amount)), h("td", {}, statusBadge(o.status)),
          h("td", {}, date(o.createdAt)), h("td", {}, date(o.paidAt))))) : h("p", { class: "muted" }, "Нет")),
      h("div", { class: "card" }, h("h3", {}, "Действия"),
        d.events.length ? table(["Когда", "Что"], d.events.map((e) => h("tr", {}, h("td", {}, date(e.createdAt)), h("td", {}, eventNames[e.type] ?? e.type)))) : h("p", { class: "muted" }, "Нет")),
    ];
  },

  async "/orders"(params) {
    const status = params.get("status") ?? "";
    const page = Math.max(1, Math.floor(Number(params.get("page"))) || 1);
    const list = await api(`/api/admin/orders?${new URLSearchParams({ ...(status && { status }), page: String(page) })}`);
    const sel = h("select", { onchange: (e) => (location.hash = `#/orders${e.target.value ? `?status=${e.target.value}` : ""}`) },
      h("option", { value: "" }, "Все"), Object.entries(orderStatus).map(([v, [t]]) => h("option", { value: v, selected: v === status }, t)));
    return [h("div", { class: "card" }, h("div", { class: "row" }, sel)),
      h("div", { class: "card" }, list.length ? table(["№", "Пользователь", "Что", "Кол-во", "Сумма", "Статус", "Провайдер", "Создан"], list.map(({ order: o, ...u }) => h("tr", { class: "click", onclick: () => (location.hash = `#/user/${o.userId}`) },
        h("td", {}, o.number), h("td", {}, name(u)), h("td", {}, orderKinds[o.kind]), h("td", {}, o.quantity), h("td", {}, m(o.amount)),
        h("td", {}, statusBadge(o.status)), h("td", {}, o.provider), h("td", {}, date(o.createdAt))))) : h("p", { class: "muted" }, "Платежей нет"),
      // Сервер отдаёт по 50 заказов: полная страница значит, что могут быть ещё.
      pager("/orders", status ? { status } : {}, page, list.length === 50, `стр. ${page}`))];
  },

  async "/activity"() {
    const list = await api("/api/admin/activity");
    return h("div", { class: "card" }, list.length ? table(["Когда", "Кто", "Что"], list.map(({ event: e, ...u }) => h("tr", { class: e.userId ? "click" : "", onclick: () => e.userId && (location.hash = `#/user/${e.userId}`) },
      h("td", {}, date(e.createdAt)), h("td", {}, e.userId ? name(u) : "—"), h("td", {}, eventNames[e.type] ?? e.type)))) : h("p", { class: "muted" }, "Пока пусто"));
  },

  async "/sms"() {
    const list = await api("/api/admin/sms");
    return h("div", { class: "card" }, list.length ? table(["Когда", "Кому", "Тип", "Статус", "Отправитель", "Текст"], list.map(({ sms: s, ...u }) => h("tr", {},
      h("td", {}, date(s.createdAt)), h("td", {}, phone(s.phone)), h("td", {}, smsPurpose[s.purpose] ?? s.purpose),
      h("td", {}, h("span", { class: `badge ${smsStatus[s.status]?.[1] ?? ""}` }, smsStatus[s.status]?.[0] ?? s.status)),
      h("td", {}, u.userId ? name(u) : "—"), h("td", { style: "white-space:normal;min-width:240px" }, s.text ?? (s.error ? `Ошибка: ${s.error}` : "—"))))) : h("p", { class: "muted" }, "SMS ещё не отправлялись"));
  },

  async "/prices"() {
    let p = await api("/api/admin/prices");
    const labels = {
      sharedTemplate: "Общий шаблон (по умолчанию, если у шаблона нет своей цены)",
      seat: "Одно место в персональном приглашении",
      subscriptionMonth: "Подписка за месяц",
    };
    const field = (key) => {
      const input = h("input", { type: "number", min: "0", step: "1", required: true, value: p[key] / 100, name: key });
      return h("label", {}, h("span", {}, `${labels[key]}, ${currency === "UZS" ? "сум" : currency}`), input);
    };
    const form = h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      // Пустое поле не становится нулём: Number("") — это 0, то есть бесплатно для всех.
      const raw = Object.keys(labels).map((k) => [k, String(fd.get(k) ?? "").trim()]);
      if (raw.some(([, v]) => v === "" || !Number.isFinite(Number(v)) || Number(v) < 0)) return toast("Укажите все цены", "bad");
      const body = Object.fromEntries(raw.map(([k, v]) => [k, Math.round(Number(v) * 100)]));
      const zeroed = Object.keys(labels).filter((k) => body[k] === 0 && p[k] !== 0);
      if (zeroed.length && !confirm(`${zeroed.map((k) => `Цена «${labels[k]}» станет 0`).join(", ")} — это бесплатно для всех. Сохранить?`)) return;
      try { p = await api("/api/admin/prices", { method: "PUT", body }); toast("Цены сохранены"); } catch (err) { toast(err.message, "bad"); }
    } },
      h("p", { class: "muted" }, "Люди с бесплатным доступом ничего не платят. Подписка открывает шаблоны, но места гостей оплачиваются отдельно."),
      field("sharedTemplate"),
      field("seat"),
      field("subscriptionMonth"),
      h("button", { class: "primary" }, "Сохранить"));
    return form;
  },

  // Реквизиты и контакты для страниц /oferta, /privacy и /contacts. Пустые поля на страницах не выводятся.
  async "/legal"() {
    const l = await api("/api/admin/legal");
    const groups = [
      ["Компания", [
        ["companyName", "Название: ООО «…» или ИП …", 200],
        ["inn", "ИНН (СТИР)", 20],
        ["address", "Юридический адрес", 300],
        ["director", "Руководитель", 200],
        ["bankName", "Банк", 200],
        ["bankAccount", "Расчётный счёт", 40],
        ["mfo", "МФО банка", 20],
      ]],
      ["Контакты для клиентов", [
        ["phone", "Телефон", 40, "+998 90 123-45-67"],
        ["email", "Электронная почта", 120, "support@example.uz"],
        ["telegram", "Telegram поддержки", 64, "@username"],
      ]],
    ];
    const keys = groups.flatMap(([, fields]) => fields.map(([k]) => k));
    const field = ([key, label, max, placeholder]) =>
      h("label", {}, h("span", {}, label), h("input", { name: key, value: l[key] ?? "", maxlength: String(max), placeholder, autocomplete: "off" }));
    const page = (path, title) => h("a", { href: path, target: "_blank", rel: "noopener" }, title);
    const form = h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = Object.fromEntries(keys.map((k) => [k, String(fd.get(k) ?? "").trim()]));
      try {
        const saved = await api("/api/admin/legal", { method: "PUT", body });
        // Сервер приводит значения к виду для страниц (например, Telegram без @ и ссылки).
        for (const k of keys) form.elements.namedItem(k).value = saved[k];
        toast("Реквизиты сохранены");
      } catch (err) { toast(err.message, "bad"); }
    } },
      h("p", { class: "muted", style: "margin-top:0" }, "Эти данные выводятся на страницах ", page("/oferta", "Оферта"), ", ", page("/privacy", "Политика конфиденциальности"), " и ", page("/contacts", "Контакты"),
        ". Multicard проверяет их при подключении боевого режима. Пустые поля на страницах не показываются; без названия исполнителем в оферте указана администрация сайта."),
      groups.flatMap(([title, fields]) => [h("h3", {}, title), h("div", { style: "display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))" }, fields.map(field))]),
      h("button", { class: "primary" }, "Сохранить"));
    return form;
  },

  async "/templates"() {
    const list = await api("/api/admin/templates");
    // Таблица не перерисовывается после сохранения: прокрутка и цены, набранные в других строках, остаются.
    const save = async (id, body) => {
      try { const tpl = await api(`/api/admin/templates/${id}`, { method: "PATCH", body }); toast("Сохранено"); return tpl; } catch (err) { toast(err.message, "bad"); return null; }
    };
    // Флажок уже показывает новое значение; если сохранить не вышло, он возвращается назад.
    const toggle = (id, key) => async (e) => {
      const box = e.target;
      if (!(await save(id, { [key]: box.checked }))) box.checked = !box.checked;
    };
    const shown = (v) => (v === null ? "" : v / 100);
    return h("div", { class: "card" }, h("p", { class: "muted" }, "Каталог шаблонов задаёт дизайн. Пустая цена — общая цена шаблона из раздела «Цены»."),
      table(["Шаблон", "Событие · стиль", "Код", "Цена", "Активен", "SMS гостям", ""], list.map((t) => {
      const price = h("input", { type: "number", min: "0", placeholder: "по умолчанию", value: shown(t.price), style: "width:140px" });
      const savePrice = async () => {
        const v = price.value.trim();
        if (v !== "" && !(Number.isFinite(Number(v)) && Number(v) >= 0)) return toast("Цена — число не меньше 0", "bad");
        const tpl = await save(t.id, { price: v === "" ? null : Math.round(Number(v) * 100) });
        if (tpl) price.value = shown(tpl.price);
      };
      return h("tr", {}, h("td", {}, t.title), h("td", {}, t.event ? `${t.event} · ${t.style ?? "—"}` : "—"), h("td", {}, h("code", {}, t.slug)), h("td", {}, price),
        h("td", {}, h("input", { type: "checkbox", checked: t.isActive, style: "width:auto", onchange: toggle(t.id, "isActive") })),
        h("td", {}, h("input", { type: "checkbox", checked: t.smsEnabled, style: "width:auto", onchange: toggle(t.id, "smsEnabled") })),
        h("td", {}, h("button", { onclick: savePrice }, "Сохранить цену")));
    })));
  },
};

async function render() {
  const [path, query = ""] = (location.hash.slice(1) || "/").split("?");
  const [, base, id] = path.match(/^(\/[^/]*)(?:\/(.+))?$/) ?? [];
  const handler = routes[base] ?? routes["/"];
  for (const a of document.querySelectorAll("#tabs a")) {
    const target = a.getAttribute("href").slice(1);
    a.classList.toggle("active", target === base || (base === "/user" && target === "/users"));
  }
  view.replaceChildren(h("p", { class: "muted" }, "Загрузка…"));
  try {
    const content = await handler(new URLSearchParams(query), id);
    view.replaceChildren(...[content].flat());
  } catch (err) {
    // 428: сессия без номера телефона (например, вход в мини-аппе не закончен) — войти на сайте заново.
    if (err.status === 401 || err.status === 428) return void view.replaceChildren(await loginCard());
    if (err.status === 403) return void view.replaceChildren(h("div", { class: "card" }, "Эта страница только для администратора."));
    view.replaceChildren(h("div", { class: "card" }, err.message));
  }
}

// В шапке: кто вошёл, а без сессии — ссылка на вход на сайте (/app/), откуда админ попадает сюда из меню аккаунта.
const who = document.getElementById("who");
try {
  const me = await api("/api/auth/me");
  currency = me.currency;
  who.textContent = me.user.firstName || me.user.username || "";
} catch (err) {
  if (err.status === 401 || err.status === 428) who.replaceChildren(h("a", { href: "/app/" }, "Войти на сайте"));
}
addEventListener("hashchange", render);
render();
