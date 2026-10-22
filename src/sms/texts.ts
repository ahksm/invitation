import { cyrText, type Locale } from "../i18n.js";

/**
 * Тексты SMS на четырёх языках. Eskiz пропускает только одобренные шаблоны, поэтому каждый
 * текст ниже (12 штук) нужно отправить на модерацию в кабинете Eskiz, а после изменения отправить заново.
 * Кириллица: 70 символов в одном SMS, латиница: 160 (только символы GSM: без ‘ и ’); длиннее делится на части.
 * Тексты uzc получаются из uz через toCyr; подставляемые значения (имя, ссылка, код) не транслитерируются.
 */
type Text<V extends unknown[]> = (...v: V) => string;

/** uzc из uz: шаблон рендерится с метками вместо значений, переводится в кириллицу, затем метки заменяются. */
function cyr<V extends unknown[]>(uz: Text<V>): Text<V> {
  return (...v) => {
    // Пустые значения остаются пустыми: от них зависят условные части шаблона.
    const marks = v.map((x, i) => (typeof x === "string" && x ? `\u0000${i}\u0000` : x)) as V;
    return cyrText(uz(...marks)).replace(/\u0000(\d+)\u0000/g, (_, i: string) => String(v[Number(i)]));
  };
}

/**
 * Код входа. Eskiz отклонил тексты вида «Invito: код для входа 123456» по пункту 2 своей инструкции: текст с кодом
 * должен называть ресурс словом «сайт» и говорить, для чего код. host — домен из APP_URL (invitebloom.tech).
 * Кириллица без «никому не сообщайте», чтобы текст помещался в одно SMS (70 символов).
 */
type OtpVars = [host: string, code: string];
const otpUzShort: Text<OtpVars> = (host, code) => `${host} saytiga kirish uchun tasdiqlash kodi: ${code}`;
const otp: Record<Locale, Text<OtpVars>> = {
  ru: (host, code) => `Код подтверждения для входа на сайт ${host}: ${code}`,
  uz: (host, code) => `${otpUzShort(host, code)}. Kodni hech kimga bermang.`,
  uzc: cyr(otpUzShort),
  en: (host, code) => `Verification code to sign in to the ${host} website: ${code}. Do not share it with anyone.`,
};

/** event: заголовок приглашения (имена) или название события на языке приглашения. */
type InviteVars = [guestName: string, event: string, date: string, link: string];
const inviteUz: Text<InviteVars> = (g, e, d, l) => `${g}, sizni taklif qilamiz: ${e}${d ? `, ${d}` : ""}. Taklifnomangiz: ${l}`;
const invite: Record<Locale, Text<InviteVars>> = {
  ru: (g, e, d, l) => `${g}, приглашаем вас: ${e}${d ? `, ${d}` : ""}. Ваше приглашение: ${l}`,
  uz: inviteUz,
  uzc: cyr(inviteUz),
  en: (g, e, d, l) => `${g}, you are invited: ${e}${d ? `, ${d}` : ""}. Your invitation: ${l}`,
};

/** Напоминание гостю, который ещё не ответил. Короче приглашения: часто это второе SMS тому же человеку. */
type ReminderVars = InviteVars;
const reminderUz: Text<ReminderVars> = (g, e, d, l) => `${g}, eslatma: ${e}${d ? `, ${d}` : ""}. Javobingizni kutamiz: ${l}`;
const reminder: Record<Locale, Text<ReminderVars>> = {
  ru: (g, e, d, l) => `${g}, напоминаем: ${e}${d ? `, ${d}` : ""}. Ждём ваш ответ: ${l}`,
  uz: reminderUz,
  uzc: cyr(reminderUz),
  en: (g, e, d, l) => `${g}, a reminder: ${e}${d ? `, ${d}` : ""}. Please reply: ${l}`,
};

export const otpText = (locale: Locale, host: string, code: string) => otp[locale](host, code);

// Узбекские апострофы (o‘, g‘, ʼ) в именах и названиях событий («To‘y») заменяются на ',
// иначе латинское SMS уходит в UCS-2 и делится на части по 70 символов.
const gsm = (s: string) => s.replace(/[\u2018\u2019\u02bb\u02bc`]/g, "'");

export const inviteText = (locale: Locale, v: { guestName: string; event: string; date?: string | undefined; link: string }) =>
  invite[locale](gsm(v.guestName), gsm(v.event), v.date ?? "", v.link);

export const reminderText = (locale: Locale, v: { guestName: string; event: string; date?: string | undefined; link: string }) =>
  reminder[locale](gsm(v.guestName), gsm(v.event), v.date ?? "", v.link);

export function formatSmsDate(isoDate: string | undefined) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}
