// Переводы интерфейса кабинета и страницы приглашения. Ключ — короткий идентификатор.
export const LOCALES = { ru: "Русский", uz: "O'zbekcha", en: "English" };

const dict = {
  ru: {
    appTitle: "Приглашения", myInvitations: "Мои приглашения", create: "Создать", payments: "Платежи", logout: "Выйти",
    loading: "Загрузка…", language: "Язык", invitationLanguage: "Язык приглашения",
    signIn: "Вход", signInHint: "Войдите по номеру телефона или через Telegram.",
    phone: "Номер телефона", sendCode: "Получить код", code: "Код из SMS", confirm: "Войти", changePhone: "Изменить номер",
    codeSent: "Код отправлен на {phone}", or: "или", viaTelegram: "Войти через Telegram",
    tgWaiting: "Подтвердите вход в Telegram. Эта страница обновится сама.", tgExpired: "Запрос входа устарел, попробуйте ещё раз.",
    tgOpen: "Открыть Telegram", tgPhoneNeeded: "Поделитесь номером телефона в Telegram, чтобы продолжить.", tgSharePhone: "Поделиться номером",
    loginExpired: "Ссылка для входа устарела или уже использована. Войдите снова.",
    accessFree: "Бесплатный доступ ко всей платформе", accessSub: "Подписка до {date}", accessNone: "Без подписки",
    pricesLine: "Общий шаблон: {shared}. Персональное приглашение: {seat} за гостя. Подписка открывает любые шаблоны, места гостей оплачиваются отдельно.",
    months: "{n} мес. · {price}", subscribe: "Оформить подписку", extend: "Продлить подписку", noInvitations: "Пока нет приглашений.",
    shared: "Общее", personal: "Персональное", personalStats: "Персональное · гостей {guests}, оплачено {paid}",
    published: "опубликовано", draft: "черновик", noTemplates: "Шаблонов пока нет.",
    newInvitation: "Новое приглашение", titleLabel: "Название (видите только вы)", template: "Шаблон", type: "Тип",
    modeShared: "Одно приглашение для всех ({price} за шаблон)", modePersonal: "Персональное для каждого гостя ({price} за гостя)",
    sharedDesc: "одно приглашение для всех", personalDesc: "персональное для каждого гостя",
    templatePaid: "Шаблон оплачен", unlockFree: "Открыть шаблон (бесплатно)", payTemplate: "Оплатить шаблон · {price}",
    guestLink: "Ссылка для гостей: ", publish: "Опубликовать", publishedToast: "Опубликовано", content: "Содержание", save: "Сохранить", saved: "Сохранено",
    guestsTitle: "Гости ({n}, оплачено мест {paid})", noGuests: "Гостей пока нет.", addGuests: "Добавить гостей",
    guestsPlaceholder: "По одному в строке: Имя, +998 90 123-45-67 (номер нужен для SMS)", add: "Добавить",
    payFree: "Открыть {n} мест (бесплатно)", paySeats: "Оплатить {n} мест · {price}", unpaid: "не оплачено", link: "ссылка",
    waitsPublish: "ждёт публикации", remove: "Удалить", rsvpPending: "—", rsvpYes: "придёт", rsvpNo: "не придёт", rsvpMaybe: "возможно",
    sendSmsAll: "Отправить SMS всем", sendSms: "SMS", smsResult: "Отправлено SMS: {sent}. Пропущено: {skipped}.",
    smsQueued: "в очереди", smsSent: "отправлено", smsDelivered: "доставлено", smsFailed: "ошибка", noPhone: "нет номера",
    orderNo: "Заказ №{n}", orderPending: "Ожидаем подтверждение оплаты. Обновите страницу через минуту.", orderPaid: "Оплата прошла.",
    orderFailed: "Оплата не прошла.", orderCancelled: "Заказ отменён.", amount: "Сумма: {price}", toInvitation: "К приглашению", home: "На главную",
    noPayments: "Платежей нет", kindTemplate: "Шаблон", kindSeats: "Места × {n}", kindSub: "Подписка × {n} мес.",
    stPending: "ожидает", stPaid: "оплачен", stFailed: "ошибка", stCancelled: "отменён",
    mockPay: "Тестовая оплата", mockOrder: "Заказ №{n} на {price}", pay: "Оплатить", decline: "Отклонить",
    currency: "сум",
    // страница приглашения
    dear: "Дорогой(ая) {name}!", openMap: "Открыть карту", going: "Приду", maybe: "Пока не знаю", notGoing: "Не смогу",
    thanks: "Спасибо за ответ!", notFound: "Приглашение не найдено или ещё не опубликовано.",
  },
  uz: {
    appTitle: "Taklifnomalar", myInvitations: "Taklifnomalarim", create: "Yaratish", payments: "To'lovlar", logout: "Chiqish",
    loading: "Yuklanmoqda…", language: "Til", invitationLanguage: "Taklifnoma tili",
    signIn: "Kirish", signInHint: "Telefon raqamingiz yoki Telegram orqali kiring.",
    phone: "Telefon raqami", sendCode: "Kodni olish", code: "SMS dagi kod", confirm: "Kirish", changePhone: "Raqamni o'zgartirish",
    codeSent: "Kod {phone} raqamiga yuborildi", or: "yoki", viaTelegram: "Telegram orqali kirish",
    tgWaiting: "Telegramda kirishni tasdiqlang. Bu sahifa o'zi yangilanadi.", tgExpired: "Kirish so'rovi eskirdi, qayta urinib ko'ring.",
    tgOpen: "Telegramni ochish", tgPhoneNeeded: "Davom etish uchun Telegramda telefon raqamingizni yuboring.", tgSharePhone: "Raqamni yuborish",
    loginExpired: "Kirish havolasi eskirgan yoki ishlatilgan. Qaytadan kiring.",
    accessFree: "Butun platformaga bepul kirish", accessSub: "Obuna {date} gacha", accessNone: "Obuna yo'q",
    pricesLine: "Umumiy shablon: {shared}. Shaxsiy taklifnoma: har bir mehmon uchun {seat}. Obuna barcha shablonlarni ochadi, mehmon joylari alohida to'lanadi.",
    months: "{n} oy · {price}", subscribe: "Obuna bo'lish", extend: "Obunani uzaytirish", noInvitations: "Hali taklifnomalar yo'q.",
    shared: "Umumiy", personal: "Shaxsiy", personalStats: "Shaxsiy · mehmonlar {guests}, to'langan {paid}",
    published: "e'lon qilingan", draft: "qoralama", noTemplates: "Hali shablonlar yo'q.",
    newInvitation: "Yangi taklifnoma", titleLabel: "Nomi (faqat siz ko'rasiz)", template: "Shablon", type: "Turi",
    modeShared: "Hamma uchun bitta taklifnoma (shablon uchun {price})", modePersonal: "Har bir mehmon uchun shaxsiy (mehmon uchun {price})",
    sharedDesc: "hamma uchun bitta taklifnoma", personalDesc: "har bir mehmon uchun shaxsiy",
    templatePaid: "Shablon to'langan", unlockFree: "Shablonni ochish (bepul)", payTemplate: "Shablon uchun to'lash · {price}",
    guestLink: "Mehmonlar uchun havola: ", publish: "E'lon qilish", publishedToast: "E'lon qilindi", content: "Mazmuni", save: "Saqlash", saved: "Saqlandi",
    guestsTitle: "Mehmonlar ({n}, to'langan joylar {paid})", noGuests: "Hali mehmonlar yo'q.", addGuests: "Mehmon qo'shish",
    guestsPlaceholder: "Har qatorda bittadan: Ism, +998 90 123-45-67 (SMS uchun raqam kerak)", add: "Qo'shish",
    payFree: "{n} ta joyni ochish (bepul)", paySeats: "{n} ta joy uchun to'lash · {price}", unpaid: "to'lanmagan", link: "havola",
    waitsPublish: "e'lon kutilmoqda", remove: "O'chirish", rsvpPending: "—", rsvpYes: "keladi", rsvpNo: "kelmaydi", rsvpMaybe: "balki",
    sendSmsAll: "Hammaga SMS yuborish", sendSms: "SMS", smsResult: "Yuborilgan SMS: {sent}. O'tkazib yuborilgan: {skipped}.",
    smsQueued: "navbatda", smsSent: "yuborildi", smsDelivered: "yetkazildi", smsFailed: "xato", noPhone: "raqam yo'q",
    orderNo: "Buyurtma №{n}", orderPending: "To'lov tasdig'ini kutyapmiz. Bir daqiqadan so'ng sahifani yangilang.", orderPaid: "To'lov o'tdi.",
    orderFailed: "To'lov o'tmadi.", orderCancelled: "Buyurtma bekor qilindi.", amount: "Summa: {price}", toInvitation: "Taklifnomaga", home: "Bosh sahifa",
    noPayments: "To'lovlar yo'q", kindTemplate: "Shablon", kindSeats: "Joylar × {n}", kindSub: "Obuna × {n} oy",
    stPending: "kutilmoqda", stPaid: "to'langan", stFailed: "xato", stCancelled: "bekor qilingan",
    mockPay: "Sinov to'lovi", mockOrder: "Buyurtma №{n}, {price}", pay: "To'lash", decline: "Rad etish",
    currency: "so'm",
    dear: "Hurmatli {name}!", openMap: "Xaritani ochish", going: "Boraman", maybe: "Hali bilmayman", notGoing: "Bora olmayman",
    thanks: "Javobingiz uchun rahmat!", notFound: "Taklifnoma topilmadi yoki hali e'lon qilinmagan.",
  },
  en: {
    appTitle: "Invitations", myInvitations: "My invitations", create: "Create", payments: "Payments", logout: "Sign out",
    loading: "Loading…", language: "Language", invitationLanguage: "Invitation language",
    signIn: "Sign in", signInHint: "Sign in with your phone number or with Telegram.",
    phone: "Phone number", sendCode: "Get code", code: "SMS code", confirm: "Sign in", changePhone: "Change number",
    codeSent: "Code sent to {phone}", or: "or", viaTelegram: "Sign in with Telegram",
    tgWaiting: "Confirm sign-in in Telegram. This page will update by itself.", tgExpired: "The sign-in request expired, please try again.",
    tgOpen: "Open Telegram", tgPhoneNeeded: "Share your phone number in Telegram to continue.", tgSharePhone: "Share phone number",
    loginExpired: "The sign-in link has expired or was already used. Please sign in again.",
    accessFree: "Free access to the whole platform", accessSub: "Subscription until {date}", accessNone: "No subscription",
    pricesLine: "Shared template: {shared}. Personal invitation: {seat} per guest. A subscription unlocks all templates; guest seats are paid separately.",
    months: "{n} mo · {price}", subscribe: "Subscribe", extend: "Extend subscription", noInvitations: "No invitations yet.",
    shared: "Shared", personal: "Personal", personalStats: "Personal · {guests} guests, {paid} paid",
    published: "published", draft: "draft", noTemplates: "No templates yet.",
    newInvitation: "New invitation", titleLabel: "Title (only you see it)", template: "Template", type: "Type",
    modeShared: "One invitation for everyone ({price} per template)", modePersonal: "Personal for each guest ({price} per guest)",
    sharedDesc: "one invitation for everyone", personalDesc: "personal for each guest",
    templatePaid: "Template paid", unlockFree: "Unlock template (free)", payTemplate: "Pay for template · {price}",
    guestLink: "Link for guests: ", publish: "Publish", publishedToast: "Published", content: "Content", save: "Save", saved: "Saved",
    guestsTitle: "Guests ({n}, {paid} seats paid)", noGuests: "No guests yet.", addGuests: "Add guests",
    guestsPlaceholder: "One per line: Name, +998 90 123-45-67 (number is needed for SMS)", add: "Add",
    payFree: "Unlock {n} seats (free)", paySeats: "Pay for {n} seats · {price}", unpaid: "unpaid", link: "link",
    waitsPublish: "waiting for publishing", remove: "Remove", rsvpPending: "—", rsvpYes: "coming", rsvpNo: "not coming", rsvpMaybe: "maybe",
    sendSmsAll: "Send SMS to everyone", sendSms: "SMS", smsResult: "SMS sent: {sent}. Skipped: {skipped}.",
    smsQueued: "queued", smsSent: "sent", smsDelivered: "delivered", smsFailed: "failed", noPhone: "no number",
    orderNo: "Order #{n}", orderPending: "Waiting for payment confirmation. Refresh the page in a minute.", orderPaid: "Payment received.",
    orderFailed: "Payment failed.", orderCancelled: "Order cancelled.", amount: "Amount: {price}", toInvitation: "Back to invitation", home: "Home",
    noPayments: "No payments", kindTemplate: "Template", kindSeats: "Seats × {n}", kindSub: "Subscription × {n} mo",
    stPending: "pending", stPaid: "paid", stFailed: "failed", stCancelled: "cancelled",
    mockPay: "Test payment", mockOrder: "Order #{n} for {price}", pay: "Pay", decline: "Decline",
    currency: "UZS",
    dear: "Dear {name}!", openMap: "Open map", going: "I'll come", maybe: "Not sure yet", notGoing: "Can't come",
    thanks: "Thank you for your answer!", notFound: "The invitation was not found or is not published yet.",
  },
};

const intl = { ru: "ru-RU", uz: "uz-Latn-UZ", en: "en-GB" };

function detect() {
  try {
    const saved = localStorage.getItem("lang");
    if (saved && dict[saved]) return saved;
  } catch {}
  const nav = (navigator.language || "ru").slice(0, 2);
  return dict[nav] ? nav : "ru";
}

let current = detect();
document.documentElement.lang = current;

export const getLang = () => current;
export function setLang(l) {
  if (!dict[l]) return;
  current = l;
  document.documentElement.lang = l;
  try { localStorage.setItem("lang", l); } catch {}
}

/** Перевод с подстановкой {переменных}. lang можно передать явно (для приглашения). */
export function t(key, vars = {}, lang = current) {
  const s = dict[lang]?.[key] ?? dict.ru[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

export const intlLocale = (lang = current) => intl[lang] ?? "ru-RU";

/** Подпись поля или название шаблона на нужном языке. */
export function pick(value, lang = current) {
  if (value && typeof value === "object") return value[lang] ?? value.ru ?? Object.values(value)[0] ?? "";
  return value ?? "";
}
export const templateTitle = (tpl, lang = current) => tpl?.translations?.[lang]?.title ?? tpl?.title ?? "";

// В браузерах часто нет узбекских названий месяцев, поэтому дату собираем сами.
const uzMonths = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];

/** «12 декабря 2026 г.», «12-dekabr, 2026», «12 December 2026» из YYYY-MM-DD. */
export function formatDay(iso, lang = current) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso ?? "";
  const [y, m, d] = iso.split("-").map(Number);
  if (lang === "uz") return `${d}-${uzMonths[m - 1]}, ${y}`;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(intlLocale(lang), { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}
