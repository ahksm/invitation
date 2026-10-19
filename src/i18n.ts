/** Языки интерфейса и приглашений. Русский — основной, на нём написаны ключи. */
export const locales = ["ru", "uz", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "ru";

export function pickLocale(code: string | null | undefined): Locale {
  const c = (code ?? "").toLowerCase().slice(0, 2);
  return (locales as readonly string[]).includes(c) ? (c as Locale) : defaultLocale;
}

/** Язык запроса: заголовок X-Lang от нашего фронтенда, иначе Accept-Language. */
export function requestLocale(headers: Record<string, string | string[] | undefined>): Locale {
  const x = headers["x-lang"];
  if (typeof x === "string") return pickLocale(x);
  const al = headers["accept-language"];
  return pickLocale(typeof al === "string" ? al : undefined);
}

/**
 * Переводы сообщений API. Ключ — русский текст, который бросает HttpError,
 * поэтому новые ошибки работают сразу, а перевод можно добавить позже.
 */
const errors: Record<string, Partial<Record<Locale, string>>> = {
  "Слишком много запросов, попробуйте позже": { uz: "So'rovlar juda ko'p, keyinroq urinib ko'ring", en: "Too many requests, please try later" },
  "Нужно войти": { uz: "Tizimga kiring", en: "Please sign in" },
  "Доступ заблокирован": { uz: "Kirish bloklangan", en: "Access is blocked" },
  "Привяжите номер телефона": { uz: "Telefon raqamingizni ulang", en: "Please link your phone number" },
  "Только для администратора": { uz: "Faqat administrator uchun", en: "Administrators only" },
  "Запрос с чужого сайта отклонён": { uz: "Begona saytdan so'rov rad etildi", en: "Cross-site request rejected" },
  "Неверные данные": { uz: "Noto'g'ri ma'lumotlar", en: "Invalid data" },
  "Внутренняя ошибка сервера": { uz: "Serverda ichki xatolik", en: "Internal server error" },
  "Пользователь не найден": { uz: "Foydalanuvchi topilmadi", en: "User not found" },
  "Приглашение не найдено": { uz: "Taklifnoma topilmadi", en: "Invitation not found" },
  "Шаблон не найден": { uz: "Shablon topilmadi", en: "Template not found" },
  "Гость не найден": { uz: "Mehmon topilmadi", en: "Guest not found" },
  "Заказ не найден": { uz: "Buyurtma topilmadi", en: "Order not found" },
  "Шаблон оплачивается только у общего приглашения": { uz: "Shablon faqat umumiy taklifnoma uchun to'lanadi", en: "Templates are paid only for shared invitations" },
  "Шаблон уже оплачен": { uz: "Shablon allaqachon to'langan", en: "Template is already paid" },
  "Места покупаются только для персональных приглашений": { uz: "Joylar faqat shaxsiy taklifnomalar uchun sotib olinadi", en: "Seats are bought only for personal invitations" },
  "Платёжная система недоступна, попробуйте позже": { uz: "To'lov tizimi ishlamayapti, keyinroq urinib ko'ring", en: "Payment system is unavailable, please try later" },
  "Сначала оплатите шаблон или оформите подписку": { uz: "Avval shablon uchun to'lang yoki obuna bo'ling", en: "Pay for the template or subscribe first" },
  "Сначала оплатите места для гостей": { uz: "Avval mehmonlar uchun joylarni to'lang", en: "Pay for guest seats first" },
  "Гости добавляются только в персональное приглашение": { uz: "Mehmonlar faqat shaxsiy taklifnomaga qo'shiladi", en: "Guests can be added only to personal invitations" },
  "SMS отправляются гостям персонального приглашения": { uz: "SMS faqat shaxsiy taklifnoma mehmonlariga yuboriladi", en: "SMS are sent to guests of personal invitations" },
  "Сначала опубликуйте приглашение": { uz: "Avval taklifnomani e'lon qiling", en: "Publish the invitation first" },
  "Для этого шаблона рассылка SMS недоступна": { uz: "Bu shablon uchun SMS yuborish mavjud emas", en: "SMS sending is not available for this template" },
  "Слишком много SMS за час, попробуйте позже": { uz: "Bir soatda juda ko'p SMS, keyinroq urinib ko'ring", en: "Too many SMS this hour, please try later" },
  "Код уже отправлен, повторить можно через минуту": { uz: "Kod yuborildi, bir daqiqadan keyin qayta so'rash mumkin", en: "Code already sent, you can retry in a minute" },
  "Слишком много запросов кода, попробуйте через час": { uz: "Kod juda ko'p so'raldi, bir soatdan keyin urinib ko'ring", en: "Too many code requests, try again in an hour" },
  "Слишком много запросов кода, попробуйте позже": { uz: "Kod juda ko'p so'raldi, keyinroq urinib ko'ring", en: "Too many code requests, please try later" },
  "Не удалось отправить SMS, попробуйте позже": { uz: "SMS yuborib bo'lmadi, keyinroq urinib ko'ring", en: "Could not send SMS, please try later" },
  "Неверный или устаревший код": { uz: "Kod noto'g'ri yoki eskirgan", en: "Wrong or expired code" },
  "Код состоит из 6 цифр": { uz: "Kod 6 ta raqamdan iborat", en: "The code has 6 digits" },
  "Введите узбекский номер: +998 XX XXX-XX-XX": { uz: "O'zbekiston raqamini kiriting: +998 XX XXX-XX-XX", en: "Enter an Uzbek number: +998 XX XXX-XX-XX" },
  "Укажите номер телефона или Telegram ID": { uz: "Telefon raqami yoki Telegram ID ni kiriting", en: "Enter a phone number or Telegram ID" },
  "Вход через Telegram не настроен": { uz: "Telegram orqali kirish sozlanmagan", en: "Telegram sign-in is not configured" },
  "Данные Telegram не прошли проверку": { uz: "Telegram ma'lumotlari tekshiruvdan o'tmadi", en: "Telegram data failed verification" },
  "Этот номер уже привязан к другому Telegram-аккаунту": { uz: "Bu raqam boshqa Telegram akkauntiga ulangan", en: "This number is linked to another Telegram account" },
};

export function translateError(message: string, locale: Locale): string {
  return locale === "ru" ? message : (errors[message]?.[locale] ?? message);
}

/** Тексты бота. */
export const botTexts = {
  askPhone: {
    ru: "Чтобы пользоваться платформой, поделитесь номером телефона: нажмите кнопку ниже.",
    uz: "Platformadan foydalanish uchun telefon raqamingizni yuboring: quyidagi tugmani bosing.",
    en: "To use the platform, share your phone number: tap the button below.",
  },
  sharePhoneButton: { ru: "📱 Поделиться номером", uz: "📱 Raqamni yuborish", en: "📱 Share phone number" },
  ownPhoneOnly: {
    ru: "Отправьте, пожалуйста, свой номер кнопкой «Поделиться номером».",
    uz: "Iltimos, o'z raqamingizni «Raqamni yuborish» tugmasi orqali yuboring.",
    en: "Please send your own number with the “Share phone number” button.",
  },
  badPhone: { ru: "Не удалось распознать номер.", uz: "Raqamni aniqlab bo'lmadi.", en: "Could not recognise the number." },
  phoneLinked: { ru: "Номер {phone} привязан.", uz: "{phone} raqami ulandi.", en: "Number {phone} is linked." },
  whatNext: { ru: "Что дальше?", uz: "Keyingi qadam?", en: "What next?" },
  welcome: {
    ru: "Здравствуйте! Здесь вы создаёте приглашения по готовым шаблонам: одно общее для всех гостей или персональное для каждого.",
    uz: "Assalomu alaykum! Bu yerda tayyor shablonlar asosida taklifnomalar yaratasiz: barcha mehmonlar uchun bitta umumiy yoki har biri uchun shaxsiy.",
    en: "Hello! Here you create invitations from ready-made templates: one shared invitation for everyone or a personal one for each guest.",
  },
  confirmLogin: {
    ru: "Подтвердите вход на сайт с устройства: {device}.\nЕсли это не вы, просто проигнорируйте сообщение.",
    uz: "Saytga kirishni tasdiqlang, qurilma: {device}.\nAgar bu siz bo'lmasangiz, xabarni e'tiborsiz qoldiring.",
    en: "Confirm sign-in from device: {device}.\nIf this wasn't you, just ignore this message.",
  },
  confirmButton: { ru: "✅ Подтвердить вход", uz: "✅ Kirishni tasdiqlash", en: "✅ Confirm sign-in" },
  loginConfirmed: { ru: "✅ Вход подтверждён. Вернитесь в браузер.", uz: "✅ Kirish tasdiqlandi. Brauzerga qayting.", en: "✅ Sign-in confirmed. Go back to your browser." },
  loginExpired: {
    ru: "Запрос входа устарел. Нажмите «Войти через Telegram» на сайте ещё раз.",
    uz: "Kirish so'rovi eskirgan. Saytda «Telegram orqali kirish» tugmasini qayta bosing.",
    en: "The sign-in request has expired. Tap “Sign in with Telegram” on the site again.",
  },
  loginLink: {
    ru: "Ссылка для входа действует 5 минут и работает один раз.",
    uz: "Kirish havolasi 5 daqiqa amal qiladi va bir marta ishlaydi.",
    en: "The sign-in link is valid for 5 minutes and works once.",
  },
  menuLogin: { ru: "Войти на сайт", uz: "Saytga kirish", en: "Open the website" },
  menuMy: { ru: "Мои приглашения", uz: "Taklifnomalarim", en: "My invitations" },
  menuPrices: { ru: "Тарифы", uz: "Tariflar", en: "Prices" },
  menuLang: { ru: "🌐 Язык", uz: "🌐 Til", en: "🌐 Language" },
  chooseLang: { ru: "Выберите язык", uz: "Tilni tanlang", en: "Choose a language" },
  langSaved: { ru: "Язык: русский", uz: "Til: o'zbekcha", en: "Language: English" },
  noInvitations: {
    ru: "У вас пока нет приглашений. Создайте первое на сайте: /login",
    uz: "Sizda hali taklifnomalar yo'q. Birinchisini saytda yarating: /login",
    en: "You have no invitations yet. Create the first one on the website: /login",
  },
  unknown: {
    ru: "Не понял команду. Доступно: /login, /my, /prices, /lang",
    uz: "Buyruq tushunarsiz. Mavjud: /login, /my, /prices, /lang",
    en: "Unknown command. Available: /login, /my, /prices, /lang",
  },
  priceShared: { ru: "Общий шаблон для всех гостей: {price}", uz: "Barcha mehmonlar uchun umumiy shablon: {price}", en: "Shared template for all guests: {price}" },
  priceSeat: { ru: "Персональное приглашение: {price} за гостя", uz: "Shaxsiy taklifnoma: har bir mehmon uchun {price}", en: "Personal invitation: {price} per guest" },
  priceSub: {
    ru: "Подписка: {price} в месяц, любые шаблоны без оплаты, места гостей оплачиваются отдельно",
    uz: "Obuna: oyiga {price}, barcha shablonlar bepul, mehmon joylari alohida to'lanadi",
    en: "Subscription: {price} per month, all templates included, guest seats are paid separately",
  },
  accessFree: { ru: "У вас бесплатный доступ ко всей платформе.", uz: "Sizda butun platformaga bepul kirish bor.", en: "You have free access to the whole platform." },
  accessSub: { ru: "Ваша подписка активна до {date}.", uz: "Obunangiz {date} gacha faol.", en: "Your subscription is active until {date}." },
  accessNone: { ru: "Подписки нет.", uz: "Obuna yo'q.", en: "No subscription." },
  invShared: { ru: "общее", uz: "umumiy", en: "shared" },
  invPersonal: {
    ru: "персональное, гостей {guests}, оплачено мест {paid}",
    uz: "shaxsiy, mehmonlar {guests}, to'langan joylar {paid}",
    en: "personal, {guests} guests, {paid} seats paid",
  },
  statusDraft: { ru: "черновик", uz: "qoralama", en: "draft" },
  statusActive: { ru: "опубликовано", uz: "e'lon qilingan", en: "published" },
  statusArchived: { ru: "в архиве", uz: "arxivda", en: "archived" },
} satisfies Record<string, Record<Locale, string>>;

export type BotTextKey = keyof typeof botTexts;

export function bt(locale: Locale, key: BotTextKey, vars: Record<string, string | number> = {}) {
  return botTexts[key][locale].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

export const localeNames: Record<Locale, string> = { ru: "Русский", uz: "O'zbekcha", en: "English" };
export const dateLocale: Record<Locale, string> = { ru: "ru-RU", uz: "uz-Latn-UZ", en: "en-GB" };
