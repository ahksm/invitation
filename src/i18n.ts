import { toCyr } from "./design-data.js";

/**
 * Языки интерфейса и приглашений. Русский — основной, на нём написаны ключи.
 * uz — узбекский латиницей, uzc — узбекский кириллицей: его тексты получаются из uz через toCyr.
 */
export const locales = ["ru", "uz", "uzc", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "ru";

/** Код языка из профиля, заголовка или Telegram: «uzc» и «uz-Cyrl…» дают uzc, остальное по двум буквам. */
export function pickLocale(code: string | null | undefined): Locale {
  const c = (code ?? "").trim().toLowerCase();
  if (c === "uzc" || c.startsWith("uz-cyrl")) return "uzc";
  const two = c.slice(0, 2);
  return two === "ru" || two === "uz" || two === "en" ? two : defaultLocale;
}

/** toCyr, который не трогает подстановки {name}, команды бота (/login) и ссылки. */
export function cyrText(s: string): string {
  return s
    .split(/(\{\w+\}|\/[a-z_]+|https?:\/\/\S+)/)
    .map((part, i) => (i % 2 ? part : toCyr(part)))
    .join("");
}

/**
 * Подставляет значения {name} в текст. Значение, которое само кончается точкой (русская дата
 * «1 июня 2031 г.»), перед точкой текста не даёт двух точек подряд.
 */
export function fillText(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}(\.?)/g, (_, k: string, dot: string) => {
    const v = String(vars[k] ?? "");
    return dot && v.endsWith(".") ? v : v + dot;
  });
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
  "Шаблон оплачивается только у общего приглашения": { uz: "Shablon faqat umumiy taklifnoma uchun to‘lanadi", en: "Templates are paid only for shared invitations" },
  "Шаблон уже оплачен": { uz: "Shablon allaqachon to‘langan", en: "Template is already paid" },
  "Места покупаются только для персональных приглашений": { uz: "Joylar faqat shaxsiy taklifnomalar uchun sotib olinadi", en: "Seats are bought only for personal invitations" },
  "Платёжная система недоступна, попробуйте позже": { uz: "To‘lov tizimi ishlamayapti, keyinroq urinib ko‘ring", en: "Payment system is unavailable, please try later" },
  "Сначала оплатите шаблон или оформите подписку": { uz: "Avval shablon uchun to‘lang yoki obuna bo‘ling", en: "Pay for the template or subscribe first" },
  "Сначала оплатите места для гостей": { uz: "Avval mehmonlar uchun joylarni to‘lang", en: "Pay for guest seats first" },
  "Гости добавляются только в персональное приглашение": { uz: "Mehmonlar faqat shaxsiy taklifnomaga qo'shiladi", en: "Guests can be added only to personal invitations" },
  "SMS отправляются гостям персонального приглашения": { uz: "SMS faqat shaxsiy taklifnoma mehmonlariga yuboriladi", en: "SMS are sent to guests of personal invitations" },
  "Сначала опубликуйте приглашение": { uz: "Avval taklifnomani e’lon qiling", en: "Publish the invitation first" },
  "Для этого шаблона рассылка SMS недоступна": { uz: "Bu shablon uchun SMS yuborish mavjud emas", en: "SMS sending is not available for this template" },
  "Слишком много SMS за час, попробуйте позже": { uz: "Bir soatda juda ko'p SMS, keyinroq urinib ko'ring", en: "Too many SMS this hour, please try later" },
  "Код уже отправлен, повторить можно через минуту": { uz: "Kod yuborildi, bir daqiqadan keyin qayta so'rash mumkin", en: "Code already sent, you can retry in a minute" },
  "Слишком много запросов кода, попробуйте через час": { uz: "Kod juda ko'p so'raldi, bir soatdan keyin urinib ko'ring", en: "Too many code requests, try again in an hour" },
  "Слишком много запросов кода, попробуйте позже": { uz: "Kod juda ko'p so'raldi, keyinroq urinib ko'ring", en: "Too many code requests, please try later" },
  "Не удалось отправить SMS, попробуйте позже": { uz: "SMS yuborib bo'lmadi, keyinroq urinib ko'ring", en: "Could not send SMS, please try later" },
  "Неверный или устаревший код": { uz: "Kod noto'g'ri yoki eskirgan", en: "Wrong or expired code" },
  "Код состоит из 6 цифр": { uz: "Kod 6 ta raqamdan iborat", en: "The code has 6 digits" },
  "Введите имя": { uz: "Ismingizni kiriting", en: "Enter your first name" },
  "Имя и фамилия: до 64 символов, без переносов строк": { uz: "Ism va familiya: 64 belgigacha, qator ko'chirishsiz", en: "First and last name: up to 64 characters, no line breaks" },
  "Введите узбекский номер: +998 XX XXX-XX-XX": { uz: "O'zbekiston raqamini kiriting: +998 XX XXX-XX-XX", en: "Enter an Uzbek number: +998 XX XXX-XX-XX" },
  "Укажите номер телефона или Telegram ID": { uz: "Telefon raqami yoki Telegram ID ni kiriting", en: "Enter a phone number or Telegram ID" },
  "Вход через Telegram не настроен": { uz: "Telegram orqali kirish sozlanmagan", en: "Telegram sign-in is not configured" },
  "Данные Telegram не прошли проверку": { uz: "Telegram ma'lumotlari tekshiruvdan o'tmadi", en: "Telegram data failed verification" },
  "Этот номер уже привязан к другому Telegram-аккаунту": { uz: "Bu raqam boshqa Telegram akkauntiga ulangan", en: "This number is linked to another Telegram account" },
  "Этот Telegram уже привязан к другому аккаунту": { uz: "Bu Telegram boshqa akkauntga ulangan", en: "This Telegram account is linked to another account" },
  "Номер этого Telegram отличается от номера аккаунта: подключите Telegram с тем же номером": {
    uz: "Bu Telegram raqami akkaunt raqamidan farq qiladi: xuddi shu raqamli Telegramni ulang",
    en: "This Telegram has a different phone number than the account: connect a Telegram with the same number",
  },
  "Эта ссылка уже занята": { uz: "Bu havola band", en: "This link is already taken" },
  "Эту ссылку занять нельзя": { uz: "Bu havolani olib bo'lmaydi", en: "This link cannot be used" },
  "Режим можно сменить только у неоплаченного черновика": { uz: "Rejimni faqat to‘lanmagan qoralamada o‘zgartirish mumkin", en: "The mode can be changed only for an unpaid draft" },
  "Этот шаблон дороже оплаченного": { uz: "Bu shablon to‘langanidan qimmatroq", en: "This template costs more than the one you paid for" },
  "Режим можно сменить, только пока в приглашении нет гостей": {
    uz: "Rejimni faqat taklifnomada mehmonlar yo'qligida o'zgartirish mumkin",
    en: "The mode can be changed only while the invitation has no guests",
  },
  "Приглашение в архиве": { uz: "Taklifnoma arxivda", en: "The invitation is archived" },
  "Шаблон больше недоступен, выберите другой": { uz: "Shablon endi mavjud emas, boshqasini tanlang", en: "This template is no longer available, choose another one" },
  "Заказ отменён, оформите оплату заново": { uz: "Buyurtma bekor qilindi, qaytadan to‘lov qiling", en: "The order was cancelled, please pay again" },
  "У вас бесплатный доступ: подписка не нужна": { uz: "Sizda bepul foydalanish huquqi bor: obuna kerak emas", en: "You have free access: no subscription needed" },
  "Такого стола нет": { uz: "Bunday stol yo'q", en: "There is no such table" },
  "За один раз можно добавить не больше 500 гостей": { uz: "Bir martada ko'pi bilan 500 ta mehmon qo'shish mumkin", en: "You can add at most 500 guests at a time" },
  "Приглашение защищено паролем": { uz: "Taklifnoma parol bilan himoyalangan", en: "This invitation is protected by a password" },
  "Неверный пароль": { uz: "Parol noto'g'ri", en: "Wrong password" },
  "Слишком много попыток, попробуйте через минуту": { uz: "Urinishlar juda ko'p, bir daqiqadan keyin urinib ko'ring", en: "Too many attempts, try again in a minute" },
  "Для этого приглашения собрано слишком много ответов": { uz: "Bu taklifnomaga javoblar juda ko'p", en: "This invitation has received too many responses" },
  "Нужна картинка PNG или JPEG": { uz: "PNG yoki JPEG rasm kerak", uzc: "PNG ёки JPEG расм керак", en: "A PNG or JPEG image is required" },
  "Файл слишком большой": { uz: "Fayl juda katta", en: "The file is too large" },
  "Этот тип файла не поддерживается": { uz: "Bu fayl turi qo'llab-quvvatlanmaydi", en: "This file type is not supported" },
  "Закончилось место для файлов": { uz: "Fayllar uchun joy tugadi", en: "You have run out of file storage" },
  "Прикрепите файл в поле file": { uz: "Faylni file maydoniga biriktiring", uzc: "Файлни file майдонига бириктиринг", en: "Attach the file in the “file” field" },
  "Слишком много загрузок, попробуйте через минуту": { uz: "Yuklashlar juda ko'p, bir daqiqadan keyin urinib ko'ring", en: "Too many uploads, try again in a minute" },
  "Файл не найден": { uz: "Fayl topilmadi", en: "File not found" },
  // Сообщения схем zod: обработчик ошибок показывает их вместо общего «Неверные данные».
  "Ссылка: 3–40 символов, латинские буквы, цифры и дефис": {
    uz: "Havola: 3–40 belgi, lotin harflari, raqamlar va chiziqcha",
    en: "Link: 3–40 characters, Latin letters, digits and hyphens",
  },
  "Файл должен быть загружен через /api/media": { uz: "Fayl /api/media orqali yuklanishi kerak", en: "The file must be uploaded via /api/media" },
  "Время в формате ЧЧ:ММ": { uz: "Vaqt SS:DD formatida bo'lishi kerak", en: "Time must be in HH:MM format" },
  "Дата в формате ГГГГ-ММ-ДД": { uz: "Sana YYYY-OO-KK formatida bo'lishi kerak", en: "Date must be in YYYY-MM-DD format" },
  "Такой даты нет": { uz: "Bunday sana yo'q", en: "There is no such date" },
  "Цвет в формате #rrggbb": { uz: "Rang #rrggbb formatida bo'lishi kerak", uzc: "Ранг #rrggbb форматида бўлиши керак", en: "Colour must be in #rrggbb format" },
  "Неизвестное событие": { uz: "Noma'lum tadbir", en: "Unknown event" },
  // Рассылки, бот и помощник с текстом.
  "Рассылка уже идёт, подождите": { uz: "Yuborish davom etmoqda, kuting", en: "Sending is already in progress, please wait" },
  "Подключите Telegram, чтобы получать уведомления": { uz: "Bildirishnomalarni olish uchun Telegramni ulang", en: "Connect Telegram to receive notifications" },
  "Бот сейчас недоступен": { uz: "Bot hozir ishlamayapti", en: "The bot is unavailable right now" },
  "Не удалось отправить сообщение в Telegram": { uz: "Telegramga xabar yuborib bo'lmadi", en: "Could not send the message to Telegram" },
  "Помощник с текстом сейчас недоступен": { uz: "Matn yordamchisi hozir ishlamayapti", en: "The text assistant is unavailable right now" },
  "Слишком много запросов к помощнику, попробуйте через минуту": {
    uz: "Yordamchiga so'rovlar juda ko'p, bir daqiqadan keyin urinib ko'ring",
    en: "Too many requests to the assistant, try again in a minute",
  },
  "Помощник на сегодня исчерпал лимит, попробуйте завтра": { uz: "Yordamchining bugungi limiti tugadi, ertaga urinib ko'ring", en: "The assistant's daily limit is used up, try again tomorrow" },
  "Помощник не смог написать текст, попробуйте ещё раз": { uz: "Yordamchi matn yoza olmadi, qayta urinib ko'ring", en: "The assistant could not write the text, please try again" },
};

// Кириллица (uzc) получается из латиницы, если не задана отдельно.
for (const t of Object.values(errors)) if (t.uz && !t.uzc) t.uzc = cyrText(t.uz);

export function translateError(message: string, locale: Locale): string {
  return locale === "ru" ? message : (errors[message]?.[locale] ?? message);
}

/** Есть ли у сообщения переводы: такие сообщения из схем zod можно показывать пользователю. */
export const isKnownMessage = (message: string) => Object.hasOwn(errors, message);

/** Сообщения API об успехе (например, о бесплатном заказе): клиент получает готовый текст на языке запроса. */
const apiTexts = {
  templateUnlocked: { ru: "Шаблон открыт без оплаты", uz: "Shablon to‘lovsiz ochildi", en: "The template is unlocked free of charge" },
  seatsAdded: { ru: "Добавлено мест: {n}", uz: "Qo‘shilgan joylar: {n}", en: "Seats added: {n}" },
} satisfies Record<string, Record<Exclude<Locale, "uzc">, string>>;

export type ApiTextKey = keyof typeof apiTexts;

export function apiText(locale: Locale, key: ApiTextKey, vars: Record<string, string | number> = {}) {
  const text = locale === "uzc" ? cyrText(apiTexts[key].uz) : apiTexts[key][locale];
  return fillText(text, vars);
}

/** Тексты бота. */
export const botTexts = {
  askPhone: {
    ru: "Чтобы пользоваться платформой, поделитесь номером телефона: нажмите кнопку ниже.",
    uz: "Platformadan foydalanish uchun telefon raqamingizni yuboring: quyidagi tugmani bosing.",
    en: "To use the platform, share your phone number: tap the button below.",
  },
  // «Подключить Telegram» с сайта, а у Telegram ещё нет номера: номер подтверждает, что это владелец аккаунта.
  askPhoneLink: {
    ru: "Чтобы подключить Telegram к аккаунту на сайте, подтвердите номер: нажмите кнопку ниже. Подключить можно только Telegram с тем же номером, что у аккаунта.",
    uz: "Telegramni saytdagi akkauntga ulash uchun raqamingizni tasdiqlang: quyidagi tugmani bosing. Faqat akkaunt raqami bilan bir xil raqamli Telegramni ulash mumkin.",
    en: "To connect Telegram to your account on the website, confirm your number: tap the button below. Only a Telegram with the same number as the account can be connected.",
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
  // «Подключить Telegram» в аккаунте на сайте: номер аккаунта со скрытой серединой.
  confirmLink: {
    ru: "Подключить этот Telegram к аккаунту {phone}? Запрос с устройства: {device}.\nЕсли это не вы, просто проигнорируйте сообщение.",
    uz: "Ushbu Telegramni {phone} akkauntiga ulaysizmi? So'rov qurilmadan: {device}.\nAgar bu siz bo'lmasangiz, xabarni e'tiborsiz qoldiring.",
    en: "Connect this Telegram to the account {phone}? Request from device: {device}.\nIf this wasn't you, just ignore this message.",
  },
  confirmLinkButton: { ru: "✅ Подключить", uz: "✅ Ulash", en: "✅ Connect" },
  linkConfirmed: {
    ru: "✅ Telegram подключён к аккаунту {phone}. Вернитесь в браузер.",
    uz: "✅ Telegram {phone} akkauntiga ulandi. Brauzerga qayting.",
    en: "✅ Telegram is connected to the account {phone}. Go back to your browser.",
  },
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
  menuStart: { ru: "Главное меню", uz: "Asosiy menyu", en: "Main menu" },
  // Карточка приглашения для гостя (/start g_<token>): на языке приглашения.
  guestInvited: { ru: "💌 {name}, вы приглашены!", uz: "💌 {name}, siz taklif qilingansiz!", en: "💌 {name}, you are invited!" },
  guestAnswer: { ru: "Ваш ответ: {answer}", uz: "Javobingiz: {answer}", en: "Your reply: {answer}" },
  guestReminders: { ru: "🔔 Напоминания о событии придут сюда.", uz: "🔔 Tadbir haqidagi eslatmalar shu yerga keladi.", en: "🔔 Event reminders will arrive here." },
  guestNotFound: {
    ru: "Приглашение не найдено или ещё не открыто. Откройте ссылку из приглашения ещё раз.",
    uz: "Taklifnoma topilmadi yoki hali ochilmagan. Taklifnomadagi havolani qayta oching.",
    en: "The invitation was not found or is not open yet. Open the link from your invitation again.",
  },
  openInvitation: { ru: "Открыть приглашение", uz: "Taklifnomani ochish", en: "Open the invitation" },
  rsvpYes: { ru: "✅ Приду", uz: "✅ Kelaman", en: "✅ I'll be there" },
  rsvpMaybe: { ru: "🤔 Возможно", uz: "🤔 Balki", en: "🤔 Maybe" },
  rsvpNo: { ru: "❌ Не приду", uz: "❌ Kela olmayman", en: "❌ Can't make it" },
  rsvpSaved: { ru: "Ответ сохранён", uz: "Javob saqlandi", en: "Reply saved" },
} satisfies Record<string, Record<Exclude<Locale, "uzc">, string>>;

export type BotTextKey = keyof typeof botTexts;

// Тексты бота на кириллице получаются из латиницы.
const botTextsUzc = Object.fromEntries(Object.entries(botTexts).map(([k, v]) => [k, cyrText(v.uz)])) as Record<BotTextKey, string>;

export function bt(locale: Locale, key: BotTextKey, vars: Record<string, string | number> = {}) {
  const text = locale === "uzc" ? botTextsUzc[key] : botTexts[key][locale];
  return fillText(text, vars);
}

export const localeNames: Record<Locale, string> = { ru: "Русский", uz: "O'zbekcha", uzc: "Ўзбекча", en: "English" };
export const dateLocale: Record<Locale, string> = { ru: "ru-RU", uz: "uz-Latn-UZ", uzc: "uz-Cyrl-UZ", en: "en-GB" };
