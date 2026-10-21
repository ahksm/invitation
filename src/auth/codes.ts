import { cacheKeys, type Cache } from "../cache.js";
import { randomToken } from "../services/invitations.js";

const LOGIN_CODE_TTL = 300;

/** Одноразовая ссылка входа, которую выдаёт бот. Живёт 5 минут и срабатывает один раз. */
export async function issueLoginCode(cache: Cache, userId: string): Promise<string> {
  const code = randomToken(24);
  await cache.set(cacheKeys.loginCode(code), userId, LOGIN_CODE_TTL);
  return code;
}

export async function redeemLoginCode(cache: Cache, code: string): Promise<string | undefined> {
  if (!/^[\w-]{20,64}$/.test(code)) return undefined;
  return cache.take<string>(cacheKeys.loginCode(code));
}
