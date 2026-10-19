import { cyrText, type Locale } from "../i18n.js";

/**
 * Тексты SMS на четырёх языках. Eskiz пропускает только одобренные шаблоны, поэтому каждый
 * текст ниже (8 штук) нужно отправить на модерацию в кабинете Eskiz, а после изменения отправить заново.
 * Кириллица: 70 символов в одном SMS, латиница: 160; длиннее делится на части.
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

type OtpVars = [app: string, code: string];
const otpUz: Text<OtpVars> = (app, code) => `${app}: kirish kodi ${code}. Bu kodni hech kimga bermang.`;
const otp: Record<Locale, Text<OtpVars>> = {
  ru: (app, code) => `${app}: код для входа ${code}. Никому не сообщайте этот код.`,
  uz: otpUz,
  uzc: cyr(otpUz),
  en: (app, code) => `${app}: your sign-in code is ${code}. Do not share it with anyone.`,
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

export const otpText = (locale: Locale, appName: string, code: string) => otp[locale](appName, code);
export const inviteText = (locale: Locale, v: { guestName: string; event: string; date?: string | undefined; link: string }) =>
  invite[locale](v.guestName, v.event, v.date ?? "", v.link);

export function formatSmsDate(isoDate: string | undefined) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}
