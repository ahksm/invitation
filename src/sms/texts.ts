import type { Locale } from "../i18n.js";

/**
 * Тексты SMS на трёх языках. Eskiz пропускает только одобренные шаблоны, поэтому каждый
 * текст ниже (6 штук) нужно отправить на модерацию в кабинете Eskiz, а после изменения отправить заново.
 * Кириллица: 70 символов в одном SMS, латиница: 160; длиннее делится на части.
 */
const otp: Record<Locale, (app: string, code: string) => string> = {
  ru: (app, code) => `${app}: код для входа ${code}. Никому не сообщайте этот код.`,
  uz: (app, code) => `${app}: kirish kodi ${code}. Bu kodni hech kimga bermang.`,
  en: (app, code) => `${app}: your sign-in code is ${code}. Do not share it with anyone.`,
};

type InviteVars = { guestName: string; event: string; date?: string | undefined; link: string };
const invite: Record<Locale, (v: InviteVars) => string> = {
  ru: (v) => `${v.guestName}, приглашаем вас на ${v.event}${v.date ? ` ${v.date}` : ""}. Ваше приглашение: ${v.link}`,
  uz: (v) => `${v.guestName}, sizni ${v.event}${v.date ? ` (${v.date})` : ""} ga taklif qilamiz. Taklifnomangiz: ${v.link}`,
  en: (v) => `${v.guestName}, you are invited to ${v.event}${v.date ? ` on ${v.date}` : ""}. Your invitation: ${v.link}`,
};

export const otpText = (locale: Locale, appName: string, code: string) => otp[locale](appName, code);
export const inviteText = (locale: Locale, v: InviteVars) => invite[locale](v);

export function formatSmsDate(isoDate: string | undefined) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}
