/** Gera um id de sessão simples, sem dependência externa (não é um UUID formal). */
export function createSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${time}-${rand}`;
}
