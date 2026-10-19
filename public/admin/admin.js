import { api, date, h, money, toast } from "/shared/api.js";

const view = document.getElementById("view");
let currency = "UZS";
const m = (v) => money(v, currency);

const eventNames = {
  login: "вход", sms_sent: "разослал SMS", bot_start: "запустил бота", invitation_created: "создал приглашение", invitation_updated: "изменил приглашение",
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

const routes = {
  async "/"() {
    const s = await api("/api/admin/stats");
    const stat = (v, label) => h("div", { class: "card stat" }, h("b", {}, v), h("span", {}, label));
    return h("div", { class: "grid" },
      stat(s.users, "пользователей"), stat(s.activeLast30Days, "активных за 30 дней"), stat(s.freeAccessUsers, "с бесплатным доступом"),
      stat(s.activeSubscriptions, "активных подписок"), stat(s.invitations, "приглашений"), stat(s.paidOrders, "оплаченных заказов"),
      stat(m(s.revenue), "выручка"));
  },

  async "/users"(params) {
    const q = params.get("q") ?? "";
    const filter = params.get("filter") ?? "all";
    const data = await api(`/api/admin/users?${new URLSearchParams({ q, filter })}`);
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
      h("div", { class: "card" }, data.items.length ? table(["Пользователь", "Телефон", "Telegram ID", "Доступ", "Приглашений", "Оплатил", "Был", "Регистрация"], rows) : h("p", { class: "muted" }, "Никого не найдено")),
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
    const list = await api(`/api/admin/orders${status ? `?status=${status}` : ""}`);
    const sel = h("select", { onchange: (e) => (location.hash = `#/orders${e.target.value ? `?status=${e.target.value}` : ""}`) },
      h("option", { value: "" }, "Все"), Object.entries(orderStatus).map(([v, [t]]) => h("option", { value: v, selected: v === status }, t)));
    return [h("div", { class: "card" }, h("div", { class: "row" }, sel)),
      h("div", { class: "card" }, list.length ? table(["№", "Пользователь", "Что", "Кол-во", "Сумма", "Статус", "Провайдер", "Создан"], list.map(({ order: o, ...u }) => h("tr", { class: "click", onclick: () => (location.hash = `#/user/${o.userId}`) },
        h("td", {}, o.number), h("td", {}, name(u)), h("td", {}, orderKinds[o.kind]), h("td", {}, o.quantity), h("td", {}, m(o.amount)),
        h("td", {}, statusBadge(o.status)), h("td", {}, o.provider), h("td", {}, date(o.createdAt))))) : h("p", { class: "muted" }, "Платежей нет"))];
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
    const p = await api("/api/admin/prices");
    const field = (key, label) => {
      const input = h("input", { type: "number", min: "0", step: "1", value: p[key] / 100, name: key });
      return h("label", {}, h("span", {}, `${label}, ${currency === "UZS" ? "сум" : currency}`), input);
    };
    const form = h("form", { class: "card", onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const body = Object.fromEntries(["sharedTemplate", "seat", "subscriptionMonth"].map((k) => [k, Math.round(Number(fd.get(k)) * 100)]));
      try { await api("/api/admin/prices", { method: "PUT", body }); toast("Цены сохранены"); } catch (err) { toast(err.message, "bad"); }
    } },
      h("p", { class: "muted" }, "Люди с бесплатным доступом ничего не платят. Подписка открывает шаблоны, но места гостей оплачиваются отдельно."),
      field("sharedTemplate", "Общий шаблон (по умолчанию, если у шаблона нет своей цены)"),
      field("seat", "Одно место в персональном приглашении"),
      field("subscriptionMonth", "Подписка за месяц"),
      h("button", { class: "primary" }, "Сохранить"));
    return form;
  },

  async "/templates"() {
    const list = await api("/api/admin/templates");
    const save = async (id, body) => {
      try { await api(`/api/admin/templates/${id}`, { method: "PATCH", body }); toast("Сохранено"); render(); } catch (err) { toast(err.message, "bad"); }
    };
    return h("div", { class: "card" }, h("p", { class: "muted" }, "Каталог шаблонов задаёт дизайн. Пустая цена — общая цена шаблона из раздела «Цены»."),
      table(["Шаблон", "Событие · стиль", "Код", "Цена", "Активен", "SMS гостям", ""], list.map((t) => {
      const price = h("input", { type: "number", min: "0", placeholder: "по умолчанию", value: t.price === null ? "" : t.price / 100, style: "width:140px" });
      return h("tr", {}, h("td", {}, t.title), h("td", {}, t.event ? `${t.event} · ${t.style ?? "—"}` : "—"), h("td", {}, h("code", {}, t.slug)), h("td", {}, price),
        h("td", {}, h("input", { type: "checkbox", checked: t.isActive, style: "width:auto", onchange: (e) => save(t.id, { isActive: e.target.checked }) })),
        h("td", {}, h("input", { type: "checkbox", checked: t.smsEnabled, style: "width:auto", onchange: (e) => save(t.id, { smsEnabled: e.target.checked }) })),
        h("td", {}, h("button", { onclick: () => save(t.id, { price: price.value === "" ? null : Math.round(Number(price.value) * 100) }) }, "Сохранить цену")));
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
    if (err.status === 401) return void view.replaceChildren(h("div", { class: "card" }, "Войдите через Telegram-бота командой /login."));
    if (err.status === 403) return void view.replaceChildren(h("div", { class: "card" }, "Эта страница только для администратора."));
    view.replaceChildren(h("div", { class: "card" }, err.message));
  }
}

try {
  const me = await api("/api/auth/me");
  currency = me.currency;
  document.getElementById("who").textContent = me.user.firstName || me.user.username || "";
} catch {}
addEventListener("hashchange", render);
render();
