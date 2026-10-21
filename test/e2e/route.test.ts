import { eq } from "drizzle-orm";
import type { Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { invitations } from "../../src/db/schema.js";
import { I18N } from "../../web/invito-data.js";
import { startE2E, type E2E } from "./helpers.js";

/**
 * Программа и маршрут: один редактор в шаге «Место и программа» и в листе «Место» редактора (время, название, место,
 * адрес или ссылка на карту; добавить, удалить, переставить, «По времени», не больше 8), сохранение и перезагрузка;
 * на странице гостя — отметки по числу остановок без наложений и обрезки, у каждой остановки своя ссылка, а в href
 * попадают только https-ссылки картографических сайтов из списка.
 */

type Dict = Record<string, any>;
const ru = I18N.ru as Dict;
const uz = I18N.uz as Dict;
let e: E2E;

beforeAll(async () => {
  e = await startE2E();
});

afterAll(async () => {
  await e?.close();
});

beforeEach(async () => {
  await e.redis.flushdb();
});

async function createInvitation(userId: string, body: Dict) {
  const res = await e.app.inject({
    method: "POST",
    url: "/api/invitations",
    headers: { cookie: `session=${e.app.jwt.sign({ sub: userId })}`, origin: e.base },
    payload: { template: "wedding-classic", mode: "shared", language: "ru", ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Dict;
}

const invById = async (id: string) => (await e.db.select().from(invitations).where(eq(invitations.id, id)))[0]!;
const publish = (id: string) => e.db.update(invitations).set({ status: "active", publishedAt: new Date(), unlocked: true }).where(eq(invitations.id, id));
const editOf = (page: Page, names: string) => page.locator("#my-inv [data-rv]").filter({ hasText: names }).getByRole("button", { name: ru.edit });

const rows = (page: Page) => page.locator("[data-stop]");
const field = (page: Page, i: number, f: string) => page.locator(`[data-stop="${i}"] [data-f="${f}"]`);
const values = (page: Page, f: string) => page.locator(`[data-stop] [data-f="${f}"]`).evaluateAll((els) => els.map((x) => (x as HTMLInputElement).value));
/** Поле с фокусом: «номер пункта:поле». */
const focused = (page: Page) => page.evaluate(() => { const a = document.activeElement!; return a.closest("[data-stop]")?.getAttribute("data-stop") + ":" + a.getAttribute("data-f"); });
const badges = (page: Page) => page.locator("[data-stop] [data-badge]").evaluateAll((els) => els.map((x) => x.getAttribute("data-badge")));

/** Поле времени не уже своего содержимого: «04:00 PM» в 12-часовом формате не обрезается. */
const timeClipped = (page: Page) =>
  page.locator('[data-stop] [data-f="time"]').evaluateAll((els) =>
    els.filter((el) => {
      const c = el.cloneNode() as HTMLInputElement;
      c.style.width = "auto";
      c.style.minWidth = "0";
      c.style.position = "absolute";
      el.parentElement!.appendChild(c);
      const need = c.getBoundingClientRect().width;
      c.remove();
      return el.getBoundingClientRect().width < need - 0.5;
    }).length,
  );

/** Подписи отметок рисованной карты: внутри карты и не наложены друг на друга. */
async function pinLayout(page: Page) {
  // Карта целиком в окне: анимация отметок и линии доходит до конца.
  await page.evaluate(() => { const m = document.querySelector("[data-map]")!; window.scrollTo(0, m.getBoundingClientRect().top + window.scrollY - 60); });
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 1);
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const map = document.querySelector("[data-map]")!.getBoundingClientRect();
    const labels = [...document.querySelectorAll("[data-pinlabel]")].map((el) => el.getBoundingClientRect());
    const outside = labels.filter((r) => r.left < map.left - 0.5 || r.right > map.right + 0.5 || r.top < map.top - 0.5 || r.bottom > map.bottom + 0.5).length;
    let overlaps = 0;
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i]!, b = labels[j]!;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps++;
    }
    const pins = [...document.querySelectorAll("[data-pinmark]")];
    return {
      pins: pins.length,
      main: pins.filter((p) => p.getAttribute("data-main") === "1").map((p) => p.textContent!.trim()),
      opacity: pins.map((p) => +(p as HTMLElement).style.opacity),
      numbers: pins.map((p) => p.querySelector("[data-pinlabel] span")!.textContent),
      outside,
      overlaps,
      // Длинные названия обрезаются многоточием, а не карта.
      truncated: [...document.querySelectorAll("[data-pinlabel] span:last-child")].filter((s) => s.scrollWidth > s.clientWidth + 1).length,
    };
  });
}

const stopLinks = (page: Page) => page.locator("[data-stoplink]").evaluateAll((els) => els.map((a) => a.getAttribute("href") || ""));
const allHrefs = (page: Page) => page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || ""));
const yandexSearch = (q: string) => "https://yandex.uz/maps/?text=" + encodeURIComponent(q);

describe("конструктор: программа и маршрут", () => {
  it("шаг «Место и программа»: добавить, переставить, по времени, удалить, не больше 8; сохраняется без пустых пунктов и переживает перезагрузку", async () => {
    const context = await e.newContext({ locale: "en-US" });
    const user = await e.signIn(context);
    const inv = await createInvitation(user.id, {
      data: { names: "Маршрут тест", venue: "Oqsaroy", address: "ул. Навои, 1", time: "18:00", program: [{ time: "15:00", title: "Никах", place: "Мечеть Минор" }, { time: "18:00", title: "Той", place: "" }] },
    });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Маршрут тест" });
    await editOf(page, "Маршрут тест").click();

    // «Текст приглашения» — только текст и тон ассистента: программы там больше нет.
    await page.getByTitle(ru.steps.words).click();
    await page.getByLabel(ru.fMessage).first().waitFor();
    await e.waitText(page, ru.hints.words);
    expect(await rows(page).count()).toBe(0);
    expect(await page.getByRole("button", { name: "+ " + ru.addItem }).count()).toBe(0);

    await page.getByTitle(ru.steps.where).click();
    await e.waitText(page, ru.fStopsHint);
    await expect.poll(() => rows(page).count()).toBe(2);
    expect(await values(page, "title")).toEqual(["Никах", "Той"]);
    expect(await values(page, "time")).toEqual(["15:00", "18:00"]);
    expect(await values(page, "place")).toEqual(["Мечеть Минор", ""]);
    // Номер закрашен у пункта с местом: он появится на карте.
    expect(await badges(page)).toEqual(["stop", "item"]);
    expect(await timeClipped(page)).toBe(0);
    await e.shot(page, "route-where-ru-390x844.png");

    // Новый пункт: через час после последнего времени, пустое название с примером, фокус сразу в названии.
    await page.locator("[data-add-prog]").click();
    await expect.poll(() => rows(page).count()).toBe(3);
    expect(await field(page, 2, "time").inputValue()).toBe("19:00");
    expect(await field(page, 2, "title").inputValue()).toBe("");
    expect(await field(page, 2, "title").getAttribute("placeholder")).toBe(ru.phTitle);
    expect(await values(page, "title")).not.toContain("…");
    await expect.poll(() => focused(page)).toBe("2:title");
    await page.keyboard.type("Танцы");
    await field(page, 2, "place").fill("Oqsaroy");
    await field(page, 2, "address").fill("https://yandex.uz/maps/-/CDabc");
    await page.locator('[data-stop="2"] [data-linknote="ok"]').waitFor();
    // Ссылка, которая у гостей не откроется: подсказка в конструкторе.
    await field(page, 1, "address").fill("javascript:alert(1)");
    expect(await page.locator('[data-stop="1"] [data-linknote="bad"]').innerText()).toBe(ru.linkBad);
    expect(await badges(page)).toEqual(["stop", "item", "stop"]);
    // Адрес без места — тоже остановка, как у гостя (подсказка над списком говорит о месте или адресе).
    await field(page, 1, "address").fill("ул. Бабура, 5");
    expect(await badges(page)).toEqual(["stop", "stop", "stop"]);
    await field(page, 1, "address").fill("javascript:alert(1)");
    expect(await badges(page)).toEqual(["stop", "item", "stop"]);

    // ↑ ↓ и «По времени» (видна, только когда времена не по порядку).
    expect(await page.locator("[data-sort-prog]").count()).toBe(0);
    await page.locator('[data-stop="2"]').getByRole("button", { name: ru.moveUp }).click();
    expect(await values(page, "title")).toEqual(["Никах", "Танцы", "Той"]);
    await page.locator('[data-stop="0"]').getByRole("button", { name: ru.moveDown }).click();
    expect(await values(page, "title")).toEqual(["Танцы", "Никах", "Той"]);
    await page.locator("[data-sort-prog]").click();
    expect(await values(page, "title")).toEqual(["Никах", "Той", "Танцы"]);
    expect(await values(page, "time")).toEqual(["15:00", "18:00", "19:00"]);
    await page.locator("[data-sort-prog]").waitFor({ state: "detached" });

    // Пустой пункт не сохраняется; остальные — с адресом.
    await page.locator("[data-add-prog]").click();
    await expect.poll(() => rows(page).count()).toBe(4);
    await expect.poll(() => focused(page)).toBe("3:title");
    await field(page, 0, "title").fill("Никах в мечети");
    const saved = [
      { time: "15:00", title: "Никах в мечети", place: "Мечеть Минор", address: "" },
      { time: "18:00", title: "Той", place: "", address: "javascript:alert(1)" },
      { time: "19:00", title: "Танцы", place: "Oqsaroy", address: "https://yandex.uz/maps/-/CDabc" },
    ];
    await expect.poll(async () => (await invById(inv.id)).data.program, { timeout: 10_000 }).toEqual(saved);

    // Не больше 8, как на сервере: кнопка говорит об этом, нажатие — тост, пунктов не прибавляется.
    for (let i = 0; i < 4; i++) await page.locator("[data-add-prog]").click();
    await expect.poll(() => rows(page).count()).toBe(8);
    expect(await page.locator("[data-add-prog]").innerText()).toBe(ru.progFull);
    await page.locator("[data-add-prog]").click();
    await e.waitText(page, ru.progFull);
    expect(await rows(page).count()).toBe(8);
    await e.shot(page, "route-where-full-ru-390x844.png");

    // После перезагрузки — то, что сохранено (пустые пункты пропали).
    await page.reload();
    await e.waitText(page, "Маршрут тест");
    await editOf(page, "Маршрут тест").click();
    await page.getByTitle(ru.steps.where).click();
    await expect.poll(() => rows(page).count()).toBe(3);
    expect(await values(page, "title")).toEqual(saved.map((p) => p.title));
    expect(await values(page, "address")).toEqual(saved.map((p) => p.address));
    expect(await values(page, "time")).toEqual(saved.map((p) => p.time));

    // Удаляется и последний пункт: программа пуста, гости её не увидят.
    for (let i = 3; i > 0; i--) {
      await page.locator('[data-stop="0"]').getByRole("button", { name: ru.deleteD }).click();
      await expect.poll(() => rows(page).count()).toBe(i - 1);
    }
    await page.locator("[data-prog-empty]").waitFor();
    expect(await page.locator("[data-prog-empty]").innerText()).toBe(ru.progEmpty);
    await expect.poll(async () => (await invById(inv.id)).data.program, { timeout: 10_000 }).toEqual([]);
    // Первый пункт пустой программы — без времени.
    await page.locator("[data-add-prog]").click();
    expect(await field(page, 0, "time").inputValue()).toBe("");
    await e.expectClean(page, problems);
    await close();
  });

  it("редактор на приглашении: программа открывает лист «Место» с тем же редактором, «Текст» — без программы; пустая программа скрывает раздел", async () => {
    const context = await e.newContext();
    const user = await e.signIn(context);
    await createInvitation(user.id, { data: { names: "Лист тест", message: "Ждём вас на празднике", venue: "Oqsaroy", intro: "none", program: [{ time: "15:00", title: "Никах", place: "Мечеть Минор" }] } });
    const { page, problems, close } = await e.open("/app/", { context, waitText: "Лист тест" });
    await editOf(page, "Лист тест").click();
    await page.getByTitle(ru.stepsX.sections).click();
    await page.getByRole("button", { name: "✎ " + ru.toEditor }).click();
    // На телефоне программа — компактный список (data-prog="list"), а не закреплённый счётчик.
    await page.locator('section[data-prog="list"] [data-prog-row]').first().waitFor();

    // Текст приглашения: лист без программы.
    await page.locator("[data-w]").first().click();
    await page.getByRole("button", { name: ru.done }).waitFor();
    await page.getByLabel(ru.fMessage).first().waitFor();
    expect(await page.locator("[data-route-editor]").count()).toBe(0);
    await page.getByRole("button", { name: ru.done }).click();

    // Программа на приглашении → лист «Место и программа».
    await page.locator('section[data-prog="list"] [data-prog-row]').first().click();
    await page.locator("[data-route-editor]").waitFor();
    expect(await page.getByText(ru.steps.where, { exact: true }).count()).toBeGreaterThan(0);
    await expect.poll(() => rows(page).count()).toBe(1);
    await page.locator("[data-add-prog]").click();
    await expect.poll(() => focused(page)).toBe("1:title");
    await page.keyboard.type("Той");
    await expect.poll(() => page.locator("section[data-prog] [data-prog-row]").count()).toBe(2);
    await e.shot(page, "route-sheet-ru-390x844.png");
    // Удалили всё — раздела программы на приглашении нет.
    for (let i = 2; i > 0; i--) {
      await page.locator('[data-stop="0"]').getByRole("button", { name: ru.deleteD }).click();
      await expect.poll(() => rows(page).count()).toBe(i - 1);
    }
    await page.locator("[data-prog-empty]").waitFor();
    await page.locator("section[data-prog]").waitFor({ state: "detached" });
    await e.expectClean(page, problems);
    await close();
  });
});

describe("страница гостя: маршрут", () => {
  const program = [
    { time: "10:00", title: "Оши нахор", place: "Чайхана «Бахор» на Чиланзаре", address: "Чиланзар, 9-й квартал" },
    { time: "13:00", title: "Никах", place: "Мечеть Минор", address: "https://yandex.uz/maps/-/CDabc" },
    { time: "15:00", title: "ЗАГС", place: "ЗАГС Мирзо-Улугбекского района города Ташкента", address: "javascript:alert(1)" },
    { time: "16:00", title: "Фотосессия", place: "Парк Навруз", address: "http://maps.google.com/?q=Navruz" },
    { time: "17:00", title: "Прогулка", place: "Ташкент-Сити", address: "Карта: https://maps.app.goo.gl/AbCdEf" },
    { time: "17:30", title: "Чай", place: "Кафе", address: "data:text/html,<b>x</b>" },
    { time: "18:00", title: "Той", place: "Ресторан «Oqsaroy»", address: "" },
    { time: "23:30", title: "Трансфер", place: "Гостиница «Узбекистан»", address: "https://evil.example/maps" },
  ];

  it("8 пунктов: отметки по числу мест, главное место одно и отдельно, подписи не наложены и не обрезаны краем; ссылки только из списка", async () => {
    const user = await e.signIn(await e.newContext());
    const inv = await createInvitation(user.id, { data: { names: "Гости маршрут", venue: "Ресторан «Oqsaroy»", address: "ул. Навои, 1", time: "18:00", intro: "none", program } });
    await publish(inv.id);
    for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 900 }]) {
      const { page, problems, close } = await e.open(`/i/${inv.slug}`, { viewport, waitText: "Гости маршрут" });
      const layout = await pinLayout(page);
      // 8 остановок в 8 местах, ресторан — главное место (●), остальные пронумерованы по порядку.
      expect(layout.pins).toBe(8);
      expect(layout.main).toEqual(["●Ресторан «Oqsaroy»"]);
      expect(layout.numbers).toEqual(["1", "2", "3", "4", "5", "6", "●", "7"]);
      expect(layout.opacity.every((o) => o === 1)).toBe(true);
      expect(layout.outside).toBe(0);
      expect(layout.overlaps).toBe(0);
      if (viewport.width === 390) expect(layout.truncated).toBeGreaterThan(0);
      await e.shot(page, `route-guest-8-${viewport.width}.png`);

      // У каждой остановки своя ссылка: разрешённая ссылка как есть, иначе поиск места (и адреса) на Яндекс Картах.
      expect(await stopLinks(page)).toEqual([
        yandexSearch("Чайхана «Бахор» на Чиланзаре, Чиланзар, 9-й квартал"),
        "https://yandex.uz/maps/-/CDabc",
        yandexSearch("ЗАГС Мирзо-Улугбекского района города Ташкента"),
        yandexSearch("Парк Навруз"),
        "https://maps.app.goo.gl/AbCdEf",
        yandexSearch("Кафе"),
        yandexSearch("Ресторан «Oqsaroy», ул. Навои, 1"),
        yandexSearch("Гостиница «Узбекистан»"),
      ]);
      // Чужие и опасные адреса не становятся ссылкой и не показываются гостю.
      const hrefs = await allHrefs(page);
      expect(hrefs.filter((h) => /^\s*(javascript|data|vbscript):/i.test(h) || h.startsWith("http:") || h.includes("evil.example"))).toEqual([]);
      const text = await page.locator("[data-route]").innerText();
      for (const hidden of ["javascript:", "alert(1)", "data:text", "http://", "evil.example", "https://"]) expect(text).not.toContain(hidden);
      expect(text).toContain("Чиланзар, 9-й квартал");
      expect(text).toContain("Карта");
      // Главные кнопки: Google и Яндекс по названию и адресу места; под списком остановок подпись над ними
      // называет главное место, чтобы «Маршрут» не читался как маршрут по всем остановкам.
      expect(await page.locator("[data-map-for]").innerText()).toBe(ru.mapFor.replace("{place}", "Ресторан «Oqsaroy»").toUpperCase());
      expect(await page.getByRole("link", { name: ru.directions + " ↗" }).getAttribute("href")).toBe("https://yandex.uz/maps/?rtext=~" + encodeURIComponent("Ресторан «Oqsaroy», ул. Навои, 1") + "&rtt=auto");
      expect(await page.getByRole("link", { name: ru.openMap + " ↗" }).getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("Ресторан «Oqsaroy», ул. Навои, 1"));
      await e.expectClean(page, problems);
      await close();
    }
  });

  it("число отметок по числу остановок; место по времени начала; без остановок — только место; настоящая карта и узбекский", async () => {
    const user = await e.signIn(await e.newContext());
    const base = { names: "Отметки", venue: "Oqsaroy", address: "ул. Навои, 1", time: "18:00", intro: "none" };
    const cases: [Dict, number, string[], string[]][] = [
      // Без мест у пунктов — только главное место, списка остановок нет.
      [{ program: [{ time: "18:00", title: "Той", place: "" }] }, 1, ["●"], []],
      // Место встаёт по времени начала (18:00) между остановками.
      [{ program: [program[0], program[1], { time: "21:00", title: "Танцы", place: "Lounge" }] }, 4, ["1", "2", "●", "3"], ["1", "2", "●", "3"]],
      // Остановка с названием места — это и есть главное место; повторное место — та же отметка.
      [{ program: [program[1], { time: "18:00", title: "Той", place: "oqsaroy " }, { time: "20:00", title: "Чай", place: "Мечеть Минор" }] }, 2, ["1", "●"], ["1", "●", "1"]],
    ];
    for (const [data, pins, numbers, list] of cases) {
      const inv = await createInvitation(user.id, { data: { ...base, ...data } });
      await publish(inv.id);
      const { page, problems, close } = await e.open(`/i/${inv.slug}`, { waitText: "Отметки" });
      const layout = await pinLayout(page);
      expect(layout.pins).toBe(pins);
      expect(layout.numbers).toEqual(numbers);
      expect(layout.outside).toBe(0);
      expect(layout.overlaps).toBe(0);
      expect(await page.locator("[data-stopn]").evaluateAll((els) => els.map((x) => x.getAttribute("data-stopn")))).toEqual(list);
      // Подпись «● Главное место» над кнопками карты — только когда есть список остановок.
      expect(await page.locator("[data-map-for]").count()).toBe(list.length ? 1 : 0);
      await e.expectClean(page, problems);
      await close();
    }

    // Пункт без места, но со ссылкой на карту или адресом: остановка с его названием (конструктор закрашивает его номер).
    const linked = await createInvitation(user.id, {
      data: {
        ...base,
        names: "Ссылка без места",
        program: [
          { time: "16:00", title: "Церемония", place: "", address: "https://2gis.uz/tashkent/firm/123" },
          { time: "17:00", title: "Фото", place: "", address: "ул. Бабура, 5" },
          { time: "18:00", title: "Той", place: "" },
        ],
      },
    });
    await publish(linked.id);
    {
      const { page, problems, close } = await e.open(`/i/${linked.slug}`, { waitText: "Ссылка без места" });
      const layout = await pinLayout(page);
      expect(layout.numbers).toEqual(["1", "2", "●"]);
      expect(await stopLinks(page)).toEqual(["https://2gis.uz/tashkent/firm/123", yandexSearch("Фото, ул. Бабура, 5"), yandexSearch("Oqsaroy, ул. Навои, 1")]);
      expect(await page.locator("[data-route]").innerText()).toContain("Церемония");
      await e.expectClean(page, problems);
      await close();
    }

    // Настоящая карта: место во встроенной карте, остановки — списком со ссылками.
    const real = await createInvitation(user.id, { language: "uz", data: { ...base, names: "Haqiqiy xarita", mapMode: "real", program: program.slice(0, 3) } });
    await publish(real.id);
    const { page, problems, close } = await e.open(`/i/${real.slug}`, { waitText: "Haqiqiy xarita" });
    expect(await page.locator("[data-pinmark]").count()).toBe(0);
    expect(await page.locator("[data-map] iframe").getAttribute("src")).toBe("https://maps.google.com/maps?q=" + encodeURIComponent("Oqsaroy, ул. Навои, 1") + "&z=15&output=embed");
    expect(await stopLinks(page)).toHaveLength(4);
    expect(await page.locator("[data-stoplink]").first().innerText()).toBe(uz.howToGet + " ↗");
    expect(await page.getByText(uz.mapSchematic).count()).toBe(0);
    await e.expectClean(page, problems);
    await close();
  });
});
