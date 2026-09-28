/**
 * Normalização de rota: troca segmentos dinâmicos (ids) por `[id]` para casar
 * com o campo `route` de `SystemNode` no Integrattion OS.
 *
 * Heurística (decisão documentada, ver README "Normalização de rota"):
 * 1. Conteúdo — pega a esmagadora maioria dos ids reais do ecossistema
 *    (uuid, ObjectId de 24 hex, cuid do Prisma, numérico puro, ou qualquer
 *    alfanumérico misto com dígito e comprimento >= 6).
 * 2. Fallback posicional — segmento curto (<=4 chars), só letras, que não
 *    está na lista de palavras estáticas conhecidas (STATIC_SEGMENT_WORDS ou
 *    a extensão passada em `extraStaticSegments`) também vira `[id]`. Cobre
 *    o caso de ids opacos curtos (ex.: slugs de 3-4 letras) que não têm
 *    dígito. Efeito colateral aceito: uma rota estática nova de <=4 letras
 *    (ex.: "faq") precisa entrar na lista de exceção se não deve virar [id].
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const NUMERIC_RE = /^\d+$/;
// cuid clássico do Prisma: "c" + >=20 chars alfanuméricos minúsculos
const CUID_RE = /^c[a-z0-9]{20,}$/i;
// id opaco genérico: mistura letra+dígito, comprimento >= 6
const MIXED_ALNUM_ID_RE = /^(?=.*[a-z])(?=.*[0-9])[a-z0-9]{6,}$/i;

/** Palavras curtas (<=4 letras) que NUNCA viram `[id]` mesmo sem dígito. */
export const STATIC_SEGMENT_WORDS = new Set([
  "api",
  "app",
  "new",
  "add",
  "edit",
  "home",
  "docs",
  "help",
  "faq",
  "seo",
  "cta",
  "css",
  "js",
  "img",
  "cdn",
  "os",
  "cs",
  "ds",
]);

export interface NormalizeRouteOptions {
  /** Palavras estáticas adicionais (nunca viram `[id]`), específicas da app. */
  extraStaticSegments?: readonly string[];
}

function isDynamicSegment(
  segment: string,
  staticWords: ReadonlySet<string>,
): boolean {
  if (!segment) return false;
  if (NUMERIC_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (OBJECT_ID_RE.test(segment)) return true;
  if (CUID_RE.test(segment)) return true;
  if (MIXED_ALNUM_ID_RE.test(segment)) return true;
  if (
    segment.length <= 4 &&
    /^[a-z]+$/i.test(segment) &&
    !staticWords.has(segment.toLowerCase())
  ) {
    return true;
  }
  return false;
}

/**
 * Troca ids dinâmicos por `[id]` em cada segmento do path.
 * Ex.: `/projetos/abc123/paginas/xyz` -> `/projetos/[id]/paginas/[id]`.
 */
export function normalizeRoute(
  pathname: string,
  options: NormalizeRouteOptions = {},
): string {
  if (!pathname) return "/";

  const staticWords = options.extraStaticSegments
    ? new Set([
        ...STATIC_SEGMENT_WORDS,
        ...options.extraStaticSegments.map((w) => w.toLowerCase()),
      ])
    : STATIC_SEGMENT_WORDS;

  const [pathOnly] = pathname.split(/[?#]/);
  const segments = pathOnly.split("/");
  const normalized = segments.map((segment) =>
    isDynamicSegment(segment, staticWords) ? "[id]" : segment,
  );
  const joined = normalized.join("/");
  return joined === "" ? "/" : joined;
}
