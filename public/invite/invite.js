import { api, h, toast } from "/shared/api.js";
import { formatDay, t } from "/shared/i18n.js";

// Временная страница приглашения. Когда будет готова обложка по дизайну, шаблон invite-cover подменит эту разметку.
const box = document.getElementById("invite");
const [, kind, token] = location.pathname.match(/^\/(i|g)\/([\w-]+)/) ?? [];

function render(v) {
  // Приглашение показывается на языке, который выбрал организатор, а не на языке браузера гостя.
  const L = v.language;
  document.documentElement.lang = L;
  const d = v.data;
  const day = formatDay(d.date, L);
  const when = [day, d.time].filter(Boolean).join(", ");
  const parts = [
    v.guest ? h("p", { class: "who" }, t("dear", { name: v.guest.name }, L)) : null,
    d.hosts ? h("p", { class: "muted" }, d.hosts) : null,
    h("h1", {}, d.event || v.title),
    d.message ? h("p", { class: "msg" }, d.message) : null,
    when ? h("p", {}, h("b", {}, when)) : null,
    d.venue ? h("p", {}, d.venue, d.address ? h("br") : null, d.address ? h("span", { class: "muted" }, d.address) : null) : null,
    d.mapUrl && /^https?:\/\//.test(d.mapUrl) ? h("p", {}, h("a", { href: d.mapUrl, target: "_blank", rel: "noopener" }, t("openMap", {}, L))) : null,
    v.guest ? rsvp(v.guest.rsvp, L) : null,
  ];
  box.replaceChildren(...parts.filter(Boolean));
  document.title = d.event || v.title;
}

function rsvp(current, L) {
  const labels = { yes: "going", maybe: "maybe", no: "notGoing" };
  return h("div", { class: "row", style: "justify-content:center;margin-top:24px" }, Object.entries(labels).map(([value, key]) =>
    h("button", { class: current === value ? "primary" : "", onclick: async () => {
      try { await api(`/api/public/g/${token}/rsvp`, { method: "POST", body: { rsvp: value } }); toast(t("thanks", {}, L)); load(); } catch (err) { toast(err.message, "bad"); }
    } }, t(key, {}, L))));
}

async function load() {
  try { render(await api(`/api/public/${kind}/${token}`)); }
  catch { box.replaceChildren(h("p", {}, t("notFound"))); }
}
if (kind) load();
