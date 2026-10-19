import { api, date, h, money, toast } from "/shared/api.js";
import { LOCALES, getLang, pick, setLang, t, templateTitle } from "/shared/i18n.js";

const view = document.getElementById("view");
const top = document.getElementById("top");
const tg = window.Telegram?.WebApp;
const inMiniApp = Boolean(tg?.initData);
let me = null;
const m = (v) => money(v, me?.currency);
const origin = location.origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function langSelect(value, onchange) {
  return h("select", { style: "width:auto", "aria-label": t("language"), onchange: (e) => onchange(e.target.value) },
    Object.entries(LOCALES).map(([v, name]) => h("option", { value: v, selected: v === value }, name)));
}

function header() {
  top.replaceChildren(
    ...[h("h1", {}, h("a", { href: "#/", style: "color:inherit;text-decoration:none" }, t("appTitle"))),
    me ? h("nav", { class: "tabs" }, h("a", { href: "#/" }, t("myInvitations")), h("a", { href: "#/new" }, t("create")), h("a", { href: "#/orders" }, t("payments"))) : null,
    h("div", { class: "row", style: "margin-left:auto" },
      langSelect(getLang(), async (l) => {
        setLang(l);
        if (me) await api("/api/auth/me", { method: "PATCH", body: { locale: l } }).catch(() => {});
        header();
        render();
      }),
      me && !inMiniApp ? h("button", { onclick: async () => { await api("/api/auth/logout", { method: "POST" }); me = null; header(); render(); } }, t("logout")) : null)].filter(Boolean));
}

async function loadMe() {
  try {
    me = await api("/api/auth/me");
    // Язык из профиля важнее языка браузера.
    if (me.user.locale && me.user.locale !== getLang()) setLang(me.user.locale);
  } catch (err) {
    if (err.status === 401 || err.status === 428) me = null;
    else throw err;
  }
  header();
}

function accessLine() {
  const a = me.access;
  if (a.free) return h("span", { class: "badge ok" }, t("accessFree"));
  if (a.subscriptionEndsAt) return h("span", { class: "badge ok" }, t("accessSub", { date: date(a.subscriptionEndsAt) }));
  return h("span", { class: "badge" }, t("accessNone"));
}

/** Создаёт заказ и отправляет на оплату, либо сразу применяет, если платить не нужно. */
async function order(body) {
  try {
    const res = await api("/api/orders", { method: "POST", body });
    if (res.status === "fulfilled") { toast(res.message); render(); return; }
    location.href = res.checkoutUrl;
  } catch (err) { toast(err.message, "bad"); }
}

async function finishLogin(res) {
  if (res.redirect === "/admin/" && !inMiniApp) return void (location.href = res.redirect);
  await loadMe();
  render();
}

// Мини-апп: вход по initData. Если номера нет, просим поделиться контактом и ждём, пока бот его привяжет.
async function miniAppLogin() {
  tg.ready();
  tg.expand();
  let res = await api("/api/auth/webapp", { method: "POST", body: { initData: tg.initData } });
  if (res.status === "phone_required") {
    view.replaceChildren(h("div", { class: "card" }, h("p", {}, t("tgPhoneNeeded")),
      h("button", { class: "primary", onclick: () => tg.requestContact(() => {}) }, t("tgSharePhone"))));
    tg.requestContact(() => {});
    for (let i = 0; i < 100 && res.status === "phone_required"; i++) {
      await sleep(2000);
      res = await api("/api/auth/webapp", { method: "POST", body: { initData: tg.initData } });
    }
  }
  if (res.status === "ok") await finishLogin(res);
}

function loginView(config) {
  const card = h("div", { class: "card", style: "max-width:420px;margin:24px auto" }, h("h2", { style: "margin-top:0" }, t("signIn")), h("p", { class: "muted" }, t("signInHint")));
  const phoneInput = h("input", { type: "tel", inputmode: "tel", autocomplete: "tel", placeholder: "+998 90 123-45-67", value: "+998 " });
  const codeInput = h("input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, placeholder: "123456" });
  const step2 = h("div", { class: "hidden" });

  const phoneForm = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/phone/request", { method: "POST", body: { phone: phoneInput.value } });
      phoneForm.classList.add("hidden");
      step2.classList.remove("hidden");
      step2.querySelector(".sent").textContent = t("codeSent", { phone: phoneInput.value });
      codeInput.focus();
    } catch (err) { toast(err.message, "bad"); }
  } }, h("label", {}, h("span", {}, t("phone")), phoneInput), h("button", { class: "primary" }, t("sendCode")));

  step2.append(h("p", { class: "sent muted" }), h("form", { onsubmit: async (e) => {
    e.preventDefault();
    try { await finishLogin(await api("/api/auth/phone/verify", { method: "POST", body: { phone: phoneInput.value, code: codeInput.value } })); }
    catch (err) { toast(err.message, "bad"); }
  } }, h("label", {}, h("span", {}, t("code")), codeInput), h("div", { class: "row" }, h("button", { class: "primary" }, t("confirm")),
    h("button", { type: "button", onclick: () => { step2.classList.add("hidden"); phoneForm.classList.remove("hidden"); } }, t("changePhone")))));

  card.append(phoneForm, step2);
  if (config.telegram) {
    const status = h("p", { class: "muted" });
    card.append(h("p", { class: "muted", style: "text-align:center" }, t("or")),
      h("button", { style: "width:100%", onclick: async () => {
        try {
          const { nonce, url } = await api("/api/auth/telegram/start", { method: "POST" });
          window.open(url, "_blank");
          status.replaceChildren(t("tgWaiting"), " ", h("a", { href: url, target: "_blank" }, t("tgOpen")));
          for (let i = 0; i < 150; i++) {
            await sleep(2000);
            const r = await api("/api/auth/telegram/poll", { method: "POST", body: { nonce } });
            if (r.status === "ok") return finishLogin(r);
            if (r.status === "expired") return void status.replaceChildren(t("tgExpired"));
          }
          status.replaceChildren(t("tgExpired"));
        } catch (err) { toast(err.message, "bad"); }
      } }, t("viaTelegram")), status);
  }
  return card;
}

const smsLabel = (s) => (s ? `${t({ queued: "smsQueued", sent: "smsSent", delivered: "smsDelivered", failed: "smsFailed" }[s.status])}${s.count > 1 ? ` ×${s.count}` : ""}` : "");

const routes = {
  async "/"() {
    const list = await api("/api/invitations");
    const p = me.prices;
    const months = h("select", { style: "width:auto" }, [1, 3, 6, 12].map((n) => h("option", { value: n }, t("months", { n, price: m(n * p.subscriptionMonth) }))));
    const subscribe = h("div", { class: "row" }, months,
      h("button", { onclick: () => order({ kind: "subscription", months: Number(months.value) }) }, me.access.subscriptionEndsAt ? t("extend") : t("subscribe")));
    return [
      h("div", { class: "card" }, accessLine(),
        h("p", { class: "muted" }, t("pricesLine", { shared: m(p.sharedTemplate), seat: m(p.seat) })),
        me.access.free ? null : subscribe),
      h("div", { class: "card" }, h("div", { class: "row" }, h("h2", { style: "margin:0;flex:1" }, t("myInvitations")), h("a", { class: "btn primary", href: "#/new" }, t("create"))),
        list.length
          ? h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, list.map(({ invitation: i, templateTitle: title, templateTranslations: translations, guestCount }) => h("tr", { class: "click", onclick: () => (location.hash = `#/inv/${i.id}`) },
              h("td", {}, h("b", {}, i.title), h("div", { class: "muted" }, `${templateTitle({ title, translations })} · ${LOCALES[i.language] ?? i.language}`)),
              h("td", {}, i.mode === "shared" ? t("shared") : t("personalStats", { guests: guestCount, paid: i.paidSeats })),
              h("td", {}, i.status === "active" ? h("span", { class: "badge ok" }, t("published")) : h("span", { class: "badge" }, t("draft"))))))))
          : h("p", { class: "muted" }, t("noInvitations"))),
    ];
  },

  async "/new"() {
    const templates = await api("/api/templates");
    if (!templates.length) return h("div", { class: "card" }, t("noTemplates"));
    const form = h("form", { class: "card" });
    const tplSel = h("select", { name: "templateId" }, templates.map((x) => h("option", { value: x.id }, templateTitle(x))));
    const fieldsBox = h("div");
    const drawFields = () => {
      const tpl = templates.find((x) => x.id === tplSel.value);
      fieldsBox.replaceChildren(...tpl.fields.map((f) => h("label", {}, h("span", {}, pick(f.label) + (f.required ? " *" : "")),
        f.type === "textarea" ? h("textarea", { name: `f.${f.key}`, rows: 3, required: f.required }) : h("input", { name: `f.${f.key}`, type: f.type === "url" ? "url" : f.type, required: f.required }))));
    };
    tplSel.addEventListener("change", drawFields);
    drawFields();
    form.append(
      h("h2", { style: "margin-top:0" }, t("newInvitation")),
      h("label", {}, h("span", {}, t("titleLabel")), h("input", { name: "title", required: true, maxlength: 200 })),
      h("label", {}, h("span", {}, t("template")), tplSel),
      h("label", {}, h("span", {}, t("type")), h("select", { name: "mode" },
        h("option", { value: "shared" }, t("modeShared", { price: m(me.prices.sharedTemplate) })),
        h("option", { value: "personal" }, t("modePersonal", { price: m(me.prices.seat) })))),
      h("label", {}, h("span", {}, t("invitationLanguage")), h("select", { name: "language" }, Object.entries(LOCALES).map(([v, n]) => h("option", { value: v, selected: v === getLang() }, n)))),
      fieldsBox,
      h("button", { class: "primary" }, t("create")));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const data = {};
      for (const [k, v] of fd) if (k.startsWith("f.") && v) data[k.slice(2)] = v;
      try {
        const inv = await api("/api/invitations", { method: "POST", body: { templateId: fd.get("templateId"), mode: fd.get("mode"), language: fd.get("language"), title: fd.get("title"), data } });
        location.hash = `#/inv/${inv.id}`;
      } catch (err) { toast(err.message, "bad"); }
    });
    return form;
  },

  async "/inv"(_q, id) {
    const [inv, templates] = await Promise.all([api(`/api/invitations/${id}`), api("/api/templates")]);
    const tpl = templates.find((x) => x.id === inv.templateId);
    const publish = async () => {
      try { await api(`/api/invitations/${id}/publish`, { method: "POST" }); toast(t("publishedToast")); render(); } catch (err) { toast(err.message, "bad"); }
    };
    const langSel = h("select", { name: "__language" }, Object.entries(LOCALES).map(([v, n]) => h("option", { value: v, selected: v === inv.language }, n)));
    const editForm = h("form", { class: "card" }, h("h3", { style: "margin-top:0" }, t("content")),
      h("label", {}, h("span", {}, t("invitationLanguage")), langSel),
      (tpl?.fields ?? []).map((f) => h("label", {}, h("span", {}, pick(f.label)),
        f.type === "textarea" ? h("textarea", { name: f.key, rows: 3 }, inv.data[f.key] ?? "") : h("input", { name: f.key, type: f.type === "url" ? "url" : f.type, value: inv.data[f.key] ?? "" }))),
      h("button", {}, t("save")));
    editForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = {};
      for (const [k, v] of new FormData(editForm)) if (v && k !== "__language") data[k] = v;
      try { await api(`/api/invitations/${id}`, { method: "PATCH", body: { data, language: langSel.value } }); toast(t("saved")); } catch (err) { toast(err.message, "bad"); }
    });

    const head = h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, inv.title),
      h("p", { class: "muted" }, `${templateTitle(tpl)} · ${inv.mode === "shared" ? t("sharedDesc") : t("personalDesc")} · ${LOCALES[inv.language] ?? inv.language} · ${inv.status === "active" ? t("published") : t("draft")}`));

    if (inv.mode === "shared") {
      const link = `${origin}/i/${inv.slug}`;
      head.append(inv.unlocked
        ? h("p", {}, h("span", { class: "badge ok" }, t("templatePaid")))
        : h("div", { class: "row" }, h("button", { class: "primary", onclick: () => order({ kind: "template", invitationId: id }) },
            me.access.free || me.access.subscriptionEndsAt ? t("unlockFree") : t("payTemplate", { price: m(tpl?.price ?? me.prices.sharedTemplate) }))),
        inv.status === "active" ? h("p", {}, t("guestLink"), h("a", { href: link, target: "_blank" }, link)) : h("button", { onclick: publish, disabled: !inv.unlocked }, t("publish")));
      return [head, editForm];
    }

    const sendSms = async (guestIds) => {
      try {
        const r = await api(`/api/invitations/${id}/sms`, { method: "POST", body: guestIds ? { guestIds } : {} });
        toast(t("smsResult", { sent: r.sent, skipped: r.skipped.length }));
        render();
      } catch (err) { toast(err.message, "bad"); }
    };
    const canSms = tpl?.smsEnabled && inv.status === "active";
    const unpaid = Math.max(0, inv.guests.length - inv.paidSeats);
    const names = h("textarea", { rows: 4, placeholder: t("guestsPlaceholder") });
    const rsvp = { pending: "rsvpPending", yes: "rsvpYes", no: "rsvpNo", maybe: "rsvpMaybe" };
    const guestCard = h("div", { class: "card" }, h("h3", { style: "margin-top:0" }, t("guestsTitle", { n: inv.guests.length, paid: inv.paidSeats })),
      inv.guests.length ? h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, inv.guests.map((g) => {
        const paid = g.seat <= inv.paidSeats;
        const link = `${origin}/g/${g.token}`;
        return h("tr", {}, h("td", {}, g.seat), h("td", {}, g.name, h("div", { class: "muted" }, g.phone ? `+${g.phone}` : t("noPhone"))),
          h("td", {}, paid ? (inv.status === "active" ? h("a", { href: link, target: "_blank" }, t("link")) : t("waitsPublish")) : h("span", { class: "badge warn" }, t("unpaid"))),
          h("td", {}, t(rsvp[g.rsvp])),
          h("td", {}, canSms && paid && g.phone ? h("button", { onclick: () => sendSms([g.id]) }, t("sendSms")) : null, " ", h("span", { class: "muted" }, smsLabel(g.sms))),
          h("td", {}, h("button", { class: "danger", onclick: async () => { await api(`/api/invitations/${id}/guests/${g.id}`, { method: "DELETE" }); render(); } }, t("remove"))));
      })))) : h("p", { class: "muted" }, t("noGuests")),
      h("label", {}, h("span", {}, t("addGuests")), names),
      h("div", { class: "row" },
        h("button", { onclick: async () => {
          const guests = names.value.split("\n").map((s) => s.trim()).filter(Boolean).map((line) => {
            const [name, ...rest] = line.split(",");
            const phone = rest.join(",").trim();
            return { name: name.trim(), ...(phone && { phone }) };
          });
          if (!guests.length) return;
          try { await api(`/api/invitations/${id}/guests`, { method: "POST", body: { guests } }); render(); } catch (err) { toast(err.message, "bad"); }
        } }, t("add")),
        unpaid ? h("button", { class: "primary", onclick: () => order({ kind: "seats", invitationId: id, quantity: unpaid }) },
          me.access.free ? t("payFree", { n: unpaid }) : t("paySeats", { n: unpaid, price: m(unpaid * me.prices.seat) })) : null,
        inv.status !== "active" ? h("button", { onclick: publish, disabled: inv.paidSeats < 1 }, t("publish")) : null,
        canSms ? h("button", { onclick: () => sendSms() }, t("sendSmsAll")) : null));
    return [head, guestCard, editForm];
  },

  async "/orders"(_q, id) {
    const st = { pending: "stPending", paid: "stPaid", failed: "stFailed", cancelled: "stCancelled" };
    if (id) {
      const o = await api(`/api/orders/${id}`);
      const text = { pending: "orderPending", paid: "orderPaid", failed: "orderFailed", cancelled: "orderCancelled" }[o.status];
      return h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, t("orderNo", { n: o.number })), h("p", {}, t(text)), h("p", {}, t("amount", { price: m(o.amount) })),
        o.invitationId ? h("a", { class: "btn", href: `#/inv/${o.invitationId}` }, t("toInvitation")) : h("a", { class: "btn", href: "#/" }, t("home")));
    }
    const list = await api("/api/orders");
    return h("div", { class: "card" }, list.length ? h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, list.map((o) => h("tr", { class: "click", onclick: () => (location.hash = `#/orders/${o.id}`) },
      h("td", {}, `№${o.number}`), h("td", {}, { template: t("kindTemplate"), seats: t("kindSeats", { n: o.quantity }), subscription: t("kindSub", { n: o.quantity }) }[o.kind]),
      h("td", {}, m(o.amount)), h("td", {}, t(st[o.status])), h("td", {}, date(o.createdAt))))))) : h("p", { class: "muted" }, t("noPayments")));
  },

  // Тестовая оплата: работает только с PAYMENT_PROVIDER=mock.
  async "/mock-pay"(_q, id) {
    const o = await api(`/api/orders/${id}`);
    const pay = async (status) => {
      try { await api(`/api/payments/mock/checkout/${id}`, { method: "POST", body: { status } }); location.hash = `#/orders/${id}`; } catch (err) { toast(err.message, "bad"); }
    };
    return h("div", { class: "card" }, h("h2", { style: "margin-top:0" }, t("mockPay")), h("p", {}, t("mockOrder", { n: o.number, price: m(o.amount) })),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => pay("paid") }, t("pay")), h("button", { onclick: () => pay("failed") }, t("decline"))));
  },
};

async function render() {
  const [path, query = ""] = (location.hash.slice(1) || "/").split("?");
  const [, base, id] = path.match(/^(\/[^/]*)(?:\/(.+))?$/) ?? [];
  if (!me) {
    const config = await api("/api/auth/config");
    const content = [loginView(config)];
    if (base === "/login-expired") content.unshift(h("div", { class: "card", style: "max-width:420px;margin:24px auto 0" }, t("loginExpired")));
    return void view.replaceChildren(...content);
  }
  view.replaceChildren(h("p", { class: "muted" }, t("loading")));
  try {
    const content = await (routes[base] ?? routes["/"])(new URLSearchParams(query), id);
    view.replaceChildren(...[content].flat());
  } catch (err) {
    view.replaceChildren(h("div", { class: "card" }, err.message));
  }
}

await loadMe();
if (!me && inMiniApp) await miniAppLogin().catch((err) => toast(err.message, "bad"));
addEventListener("hashchange", render);
render();
