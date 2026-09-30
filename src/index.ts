/**
 * @integrattion/telemetria — núcleo de medição de performance percebida.
 *
 * Uso (ver README para o boot completo em Next.js/Vite):
 *   requestIdleCallback(() => import('@integrattion/telemetria').then(t => t.init({ entitySlug, endpoint })));
 *   ...
 *   telemetria.mark('action-ready');
 *
 * Este módulo é o que a app importa dinamicamente DEPOIS de `load` +
 * `requestIdleCallback` — nunca no caminho crítico de renderização. Import
 * estático de web-vitals é evitado (ver vitals.ts) pra manter esse chunk
 * dentro do teto de 3 KB gzip.
 */

import { EventBuffer, type BufferedEvent } from "./buffer.js";
import { normalizeRoute, type NormalizeRouteOptions } from "./route.js";
import { shouldSample } from "./sampling.js";
import { createSessionId } from "./session.js";
import { sendBatch, type VitalsSnapshot } from "./transport.js";
import { observeVitals } from "./vitals.js";

export { normalizeRoute } from "./route.js";
export type { NormalizeRouteOptions } from "./route.js";
export type { BufferedEvent } from "./buffer.js";
export type { VitalsSnapshot, TelemetriaPayload } from "./transport.js";

export interface TelemetriaConfig {
  /** Slug da entity no Integrattion OS (bate com SystemNode). */
  entitySlug: string;
  /** URL completa de `POST /api/telemetria/ingest`. Nunca hardcoded pela lib. */
  endpoint: string;
  /** Fração de sessões amostradas, 0..1. Default 1 (sem amostragem). */
  sampleRate?: number;
  /** Nº de eventos acumulados que dispara flush automático. Default 20. */
  batchSize?: number;
  /** Teto de eventos aceitos por sessão, mesmo em sessão anômala. Default 200. */
  maxEventsPerSession?: number;
  /** Rota já normalizada pela app; se ausente, usa location.pathname. */
  route?: string;
  /** Palavras estáticas extras pra normalizeRoute (ver route.ts). */
  extraStaticSegments?: NormalizeRouteOptions["extraStaticSegments"];
  /** Gerador de sessionId; default cria um id local por sessão de página. */
  sessionId?: string;
}

interface TelemetriaState {
  config: Required<Omit<TelemetriaConfig, "route" | "sessionId" | "extraStaticSegments">> & {
    route: string;
    sessionId: string;
    extraStaticSegments?: NormalizeRouteOptions["extraStaticSegments"];
  };
  buffer: EventBuffer;
  vitals: VitalsSnapshot;
  sampledIn: boolean;
  /**
   * `routeStartTs` é o instante (na mesma escala de `nowMs()`) em que o ciclo
   * de marcos ATUAL começou: `0` no boot (porque `performance.now()`/FCP/
   * `loadEventEnd` já são nativamente relativos ao início da navegação —
   * subtrair 0 não muda nada) e o instante do próprio evento de navegação
   * (`pushState`/`replaceState`/`popstate`) a cada `handleRouteChange` —
   * SEMPRE, sem depender de clique (ver nota de desenho em `handleRouteChange`
   * sobre por que a versão anterior, baseada em clique, foi abandonada).
   * Todo marco que passa por `recordMark` — automáticos (T1/T4) E manuais
   * (T2/T3 via `mark()`) — sai relativo a este valor.
   */
  routeStartTs: number;
  /**
   * INTG-0139 A17 — achado do A16 (F4): comparar a rota NORMALIZADA pra
   * decidir se houve troca de rota fazia duas telas do MESMO MOLDE (ex.:
   * `/card/1` → `/card/2`, ambas `/card/[id]`) nunca abrirem ciclo novo — o
   * defeito do A10 de volta, só que entre telas do mesmo molde (existe de
   * verdade no OS: card a card, projeto a projeto). `rawPath` é o
   * `location.pathname` CRU, usado só pra detectar SE uma navegação
   * aconteceu; a rota normalizada (`config.route`) continua servindo só pra
   * rotular/agregar no consolidado.
   */
  rawPath: string;
}

let state: TelemetriaState | null = null;

/**
 * Fila de marcos chamados ANTES de `init()` rodar (INTG-0139 A05 — achado A04:
 * `mark('action-ready')` chamado antes de `init()` se perdia em silêncio, sem
 * fila e sem erro, derrubando T3 — o marco central do card). `init()` só roda
 * depois de `load` + `requestIdleCallback`; qualquer tela que fique pronta
 * antes disso (comum em SPA com hidratação rápida) chama `mark()` num momento
 * em que `state` ainda é `null`. O timestamp é capturado AQUI, no instante da
 * chamada de `mark()` — nunca no instante em que a fila for drenada, porque
 * `init()` pode rodar segundos depois e o timestamp perderia o sentido.
 */
interface PendingMark {
  name: string;
  timestamp: number;
}

let pendingMarks: PendingMark[] = [];

/** Teto defensivo da fila pré-init — se `init()` nunca rodar (app quebrada
 * antes disso), a fila não cresce sem limite. Bem acima do uso real: `mark()`
 * pré-init serve pra um punhado de marcos (T2/T3), não pra tráfego normal. */
const MAX_PENDING_MARKS = 50;

let navHooksInstalled = false;

/**
 * INTG-0139 A17 — troca de mecanismo (decisão do Fioda, 30/09/2026), não mais
 * um remendo. As versões 0.2.0 a 0.2.3 tentaram adivinhar "qual clique causou
 * esta navegação" com uma heurística implícita (listener de clique global +
 * flag de consumo). Cada rodada de verificação achou um bug novo e distinto
 * no mesmo mecanismo (A10, A12, A14, A16 — 4 reprovações seguidas): o clique
 * herdava tempo da tela anterior, não incluía espera de servidor, um clique
 * órfão contaminava uma navegação não relacionada via `popstate`, e o
 * `replaceState` que o próprio Next App Router dispara durante `popstate`
 * consumia o clique antes do listener da lib rodar. O padrão mostrou que
 * NENHUMA heurística implícita segura contra a variedade de como frameworks
 * de roteamento disparam `history.*` por baixo dos panos — não é mais um bug
 * pontual, é o desenho.
 *
 * A troca: a lib não tenta mais adivinhar nada. `pendingNavStartTs` só existe
 * quando a APP chama `beginNavigation()` explicitamente, no ponto exato onde
 * decide navegar — determinístico, porque é a app controlando a ordem, não a
 * lib torcendo pra um listener rodar antes de outro. É OPCIONAL e afeta só o
 * T0; T1/T3/T4 dependem exclusivamente do instante real do evento de
 * navegação (`pushState`/`replaceState`/`popstate`), nunca de clique.
 */
let pendingNavStartTs: number | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Dois `requestAnimationFrame` encadeados: o 1º roda antes do navegador
 * pintar o frame corrente, o 2º já é depois do paint — técnica padrão pra
 * medir "tempo até resposta visual" sem depender de PerformanceObserver. */
function doubleRaf(cb: () => void): void {
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (fn: () => void) => setTimeout(fn, 16);
  raf(() => raf(cb));
}

function onIdle(cb: () => void): void {
  const ric =
    typeof requestIdleCallback === "function"
      ? requestIdleCallback
      : (fn: () => void) => setTimeout(fn, 50);
  ric(() => cb());
}

function flushNow(): void {
  if (!state) return;
  state.buffer.flush();
}

function handleFlush(events: BufferedEvent[]): void {
  if (!state || events.length === 0) return;
  sendBatch(state.config.endpoint, {
    entitySlug: state.config.entitySlug,
    route: state.config.route,
    marks: events,
    vitals: state.vitals,
    sessionId: state.config.sessionId,
  });
}

function bindLifecycleFlush(): void {
  if (typeof document === "undefined") return;
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        flushNow();
      }
    },
    { passive: true },
  );
}

/**
 * Inicializa a telemetria pra uma sessão de página. Chamar `init()` de novo
 * é um RESET completo (nova config, novo buffer, zera o teto de eventos da
 * sessão) — use só pra um boot novo de verdade, nunca pra troca de rota.
 *
 * Desde a INTG-0139 A09, a app NÃO precisa mais chamar `init()` a cada
 * navegação client-side: `installNavigationHooks()` intercepta
 * `pushState`/`replaceState`/`popstate` e trata a troca de rota sozinha
 * (`handleRouteChange`), preservando sessionId e o teto de eventos por
 * sessão. Chamar `init()` de novo continua funcionando, mas reinicia tudo —
 * é o caminho certo só se a app quiser mesmo começar uma sessão nova.
 */
export function init(config: TelemetriaConfig): void {
  const sampleRate = config.sampleRate ?? 1;
  const sampledIn = shouldSample(sampleRate);

  const rawPath = typeof location !== "undefined" ? location.pathname : "/";
  const route =
    config.route ?? normalizeRoute(rawPath, { extraStaticSegments: config.extraStaticSegments });

  state = {
    config: {
      entitySlug: config.entitySlug,
      endpoint: config.endpoint,
      sampleRate,
      batchSize: config.batchSize ?? 20,
      maxEventsPerSession: config.maxEventsPerSession ?? 200,
      route,
      sessionId: config.sessionId ?? createSessionId(),
      extraStaticSegments: config.extraStaticSegments,
    },
    buffer: new EventBuffer({
      batchSize: config.batchSize ?? 20,
      maxEventsPerSession: config.maxEventsPerSession ?? 200,
      onFlush: handleFlush,
    }),
    vitals: {},
    sampledIn,
    // 0 no boot: performance.now()/FCP/loadEventEnd já são nativamente
    // relativos ao início da navegação, subtrair 0 preserva o valor.
    routeStartTs: 0,
    rawPath,
  };

  if (!sampledIn) {
    pendingMarks = [];
    return;
  }

  bindLifecycleFlush();
  installNavigationHooks();

  // Drena a fila de mark() chamados antes de init() — na ordem em que
  // chegaram, com o timestamp capturado no momento original da chamada.
  if (pendingMarks.length > 0) {
    for (const pending of pendingMarks) {
      state.buffer.push(pending);
    }
    pendingMarks = [];
  }

  recordInitialMarks();

  void observeVitals((partial) => {
    if (!state) return;
    state.vitals = { ...state.vitals, ...partial };
  });
}

/**
 * Marcos da CARGA INICIAL (boot), únicos que têm `performance.getEntriesByType`
 * de verdade pra se apoiar (navigation/paint timing só existem pra navegação
 * de documento, não pra troca de rota via history API). Navegação client-side
 * subsequente usa `recordRouteChangeMarks`, que não tem esses dados e mede
 * via `requestAnimationFrame`/`requestIdleCallback` a partir do instante da
 * troca de rota.
 *
 * T0 (reação ao clique) não é emitido aqui: no boot inicial não existe um
 * clique prévio que motivou a navegação (achado do C01 — o T0 antigo gravava
 * só o instante do primeiro clique da sessão, sem relação com carregamento
 * nenhum, e nenhum campo do manual usava esse valor).
 */
function recordInitialMarks(): void {
  recordInitialT1();

  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    const [navEntry] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    recordMark("T4", navEntry?.loadEventEnd || undefined);
  } else {
    recordMark("T4");
  }
}

/**
 * INTG-0139 A21 — achado B1 do A20: `init()` só roda depois de `load` +
 * `requestIdleCallback`, mas isso NÃO garante que o FCP já tenha acontecido —
 * apps com gate de sessão (ex.: `LoginGate` renderizando `null` até a sessão
 * resolver) atrasam o primeiro paint de verdade pra depois disso, às vezes
 * por segundos. A versão antiga lia `getEntriesByType('paint')` uma única vez
 * e, sem a entrada ainda, gravava `nowMs()` (o instante do `init()`) como se
 * fosse o FCP — errado sistematicamente nesse padrão, que é o padrão real do
 * OS (App Router + `LoginGate`) e do Foccus (gate de auth do Firebase).
 *
 * Corrigido com `PerformanceObserver({type: 'paint', buffered: true})`: pega
 * o FCP na hora se ele já aconteceu (entradas em buffer, entregues assim que
 * o observer é criado) e espera o evento real se ainda não aconteceu — nunca
 * mais aproxima com o instante do `init()`. `bootRawPath` é capturado antes
 * de registrar o observer e conferido quando ele dispara: se uma navegação
 * client-side já tiver acontecido nesse meio-tempo (FCP raro, mas pode
 * demorar), o T1 do boot não vaza pra rota errada (mesmo padrão de guarda já
 * usado pelos callbacks de `handleRouteChange`).
 */
function recordInitialT1(): void {
  const bootRawPath = state?.rawPath;

  const existingFcp = getFcpEntry();
  if (existingFcp) {
    recordMark("T1", existingFcp.startTime);
    return;
  }

  if (typeof PerformanceObserver !== "function") {
    recordMark("T1"); // sem Performance API nenhuma pra se apoiar — aproxima
    return;
  }

  try {
    const observer = new PerformanceObserver((list) => {
      const entry = list.getEntries().find((e) => e.name === "first-contentful-paint");
      if (!entry) return;
      observer.disconnect();
      if (!state || state.rawPath !== bootRawPath) return; // navegou antes do FCP chegar
      recordMark("T1", entry.startTime);
    });
    observer.observe({ type: "paint", buffered: true });
  } catch {
    recordMark("T1"); // navegador sem suporte a 'paint' via PerformanceObserver
  }
}

function getFcpEntry(): PerformanceEntry | undefined {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
    return undefined;
  }
  return performance
    .getEntriesByType("paint")
    .find((entry) => entry.name === "first-contentful-paint");
}

/**
 * Marca explicitamente o INÍCIO de uma navegação — no ponto exato onde a app
 * decide navegar (ex.: dentro do `onClick` do item de menu, antes de chamar
 * `router.push`), nunca genérica pra todo clique da página. INTG-0139 A17:
 * é o que faz T0 (reação → próximo quadro pintado) existir de novo depois da
 * troca de mecanismo — mas é OPCIONAL e afeta só o T0. T1/T3/T4 nunca
 * dependem dela: são medidos sempre a partir do instante REAL do evento de
 * navegação (ver `handleRouteChange`), determinístico, sem depender de a app
 * lembrar de chamar isso.
 *
 * Não espalhe por todo lugar que navega — só nos pontos de navegação
 * principais que valem a pena medir T0 (ex.: item de menu, ação primária).
 * Chamada consumida pela PRÓXIMA troca de rota real, de qualquer tipo
 * (`pushState`/`replaceState`/`popstate`); se nenhuma navegação vier depois,
 * fica inerte até a próxima chamada de `beginNavigation()` sobrescrevê-la —
 * por isso deve ficar restrita a pontos que de fato levam a uma navegação.
 */
export function beginNavigation(): void {
  pendingNavStartTs = nowMs();
}

/**
 * Troca de rota client-side (SPA). Único ponto de entrada do wrapper de
 * `pushState`/`replaceState` e do listener de `popstate`.
 *
 * INTG-0139 A17 — troca de mecanismo: a decisão de abrir um ciclo novo depende
 * SÓ do `location.pathname` CRU ter mudado (nunca de heurística de clique).
 * `routeStartTs` é sempre o instante deste evento de navegação — nunca o de
 * um clique anterior. Isso resolve de uma vez os 3 furos que a heurística de
 * clique (0.2.0-0.2.3) não conseguiu fechar em 4 rodadas de correção:
 * `replaceState` disparado pelo próprio router durante `popstate` (F1),
 * navegação programática depois de um clique órfão (F2), e o listener de
 * `popstate` de um router rodando antes do da lib (F3) — nenhum deles
 * consegue mais "roubar" um clique que não é dele, porque não existe mais
 * clique nenhum sendo rastreado.
 *
 * `pendingNavStartTs` (de `beginNavigation()`) é consumido aqui, sempre que
 * existir, SÓ pra calcular o T0 — nunca influencia `routeStartTs`.
 *
 * Fecha o ciclo da rota anterior (flush do que estiver pendente) ANTES de
 * trocar `state.rawPath`/`state.config.route` — garante que os eventos da
 * rota antiga cheguem com a rota certa, mesmo com o buffer ainda tendo itens
 * não drenados. O buffer em si NÃO é recriado (só flushado): recriar
 * zeraria `totalAccepted` e o teto de eventos por sessão (spec A02) passaria
 * a valer por rota, não por sessão.
 */
function handleRouteChange(): void {
  if (!state) return;

  const rawPath = typeof location !== "undefined" ? location.pathname : "/";
  // A17 (achado F4 do A16): compara o PATHNAME CRU, não a rota normalizada —
  // duas telas do mesmo molde (`/card/1` → `/card/2`, ambas `/card/[id]`)
  // agora abrem ciclo novo; mudança só de query string (pathname igual)
  // continua sendo no-op, como sempre foi.
  if (rawPath === state.rawPath) {
    // A19 — achado R1 do A18: mesmo sem trocar de rota, o evento de
    // pushState/replaceState/popstate ACONTECEU (roteadores disparam isso até
    // pra "navegar" pra própria URL atual) — se não limpar `pendingNavStartTs`
    // aqui, uma `beginNavigation()` que não levou a troca de rota nenhuma
    // ficava pendente e era consumida pela PRÓXIMA navegação de verdade,
    // inventando um T0 sem relação nenhuma com ela (mesma classe do achado do
    // A14, agora restrita ao T0 já que o resto do mecanismo mudou).
    pendingNavStartTs = null;
    return;
  }

  flushNow();

  const navChangeTs = nowMs();
  const usedNavStartTs = pendingNavStartTs;
  pendingNavStartTs = null; // consumo único — não vaza pra próxima navegação

  state.rawPath = rawPath;
  state.config.route = normalizeRoute(rawPath, {
    extraStaticSegments: state.config.extraStaticSegments,
  });
  // routeStartTs é SEMPRE o instante deste evento de navegação — nunca o de
  // beginNavigation()/clique. T1/T3/T4 não incluem, portanto, o tempo entre
  // a intenção de navegar e o pushState de fato disparar (ex.: espera de RSC
  // em SSR) — trade-off aceito conscientemente pela robustez (ver nota da
  // função). Quem precisar medir essa espera de ponta a ponta pode encadear
  // `beginNavigation()` com marcos manuais próprios.
  state.routeStartTs = navChangeTs;

  if (!state.sampledIn) return;

  doubleRaf(() => {
    if (!state || state.rawPath !== rawPath) return; // outra navegação já aconteceu
    // T0 só existe quando a app chamou beginNavigation() antes desta
    // navegação — nunca inventa um valor sem isso.
    if (usedNavStartTs != null) {
      recordDuration("T0", nowMs() - usedNavStartTs);
    }
    recordMark("T1"); // nowMs() (default) - routeStartTs = duração até este paint
  });

  onIdle(() => {
    if (!state || state.rawPath !== rawPath) return;
    recordMark("T4"); // idem: nowMs() (default) - routeStartTs
  });
}

/**
 * Instrumenta `history.pushState`/`replaceState` (o App Router do Next e
 * praticamente toda SPA passam por eles) + `popstate` (botão voltar/avançar).
 * Idempotente: chamado a cada `init()`, mas só instala uma vez por
 * `globalThis` — `__resetForTest` zera a flag pra testes que trocam o
 * `window`/`history` global a cada rodada.
 */
function installNavigationHooks(): void {
  if (navHooksInstalled) return;
  if (typeof window === "undefined" || typeof history === "undefined") return;
  navHooksInstalled = true;

  (["pushState", "replaceState"] as const).forEach((method) => {
    const original = history[method];
    history[method] = function (
      this: History,
      ...args: Parameters<History[typeof method]>
    ): ReturnType<History[typeof method]> {
      const result = original.apply(this, args);
      handleRouteChange();
      return result;
    } as History[typeof method];
  });

  window.addEventListener("popstate", () => handleRouteChange());
}

/**
 * Grava um marco relativo a `state.routeStartTs` (INTG-0139 A11). `timestamp`,
 * quando passado, é um instante ABSOLUTO na mesma escala de `nowMs()` (ex.:
 * `fcp.startTime`) — nunca uma duração já calculada, essa vai por
 * `recordDuration`. No boot, `routeStartTs` é 0 e o valor sai inalterado
 * (mesmo comportamento de sempre); após uma troca de rota, `routeStartTs` é
 * o instante da troca, e o valor gravado passa a ser a duração real desde
 * então — é a correção do achado do A10 (T2/T3 via `mark()` continuavam
 * absolutos mesmo depois do A09 corrigir T0/T1/T4).
 */
function recordMark(name: string, timestamp?: number): void {
  if (!state || !state.sampledIn) return;
  const absolute = timestamp ?? nowMs();
  state.buffer.push({
    name,
    timestamp: absolute - state.routeStartTs,
  });
}

/** Grava uma DURAÇÃO já calculada, sem subtrair `routeStartTs` — usado só
 * pelo T0 (clique→paint), que não é relativo ao início do ciclo da rota. */
function recordDuration(name: string, durationMs: number): void {
  if (!state || !state.sampledIn) return;
  state.buffer.push({ name, timestamp: durationMs });
}

/**
 * Marca manual da app. `action-ready` grava T2 (contexto) e T3 (pronto pra
 * agir) juntos, no mesmo timestamp — spec A02: "T2 e T3 são marcados
 * manualmente ... via uma chamada mark('action-ready')". Se a app quiser
 * granularidade maior, pode chamar `mark('context-ready')` antes: isso
 * sobrescreve T2 com um timestamp mais cedo, e o `action-ready` seguinte
 * grava só T3.
 *
 * Chamada antes de `init()` (state ainda `null`): em vez de descartar em
 * silêncio (achado A04), enfileira em `pendingMarks` já com os nomes finais
 * resolvidos (T2/T3 ou o nome bruto) e o timestamp capturado agora — `init()`
 * drena a fila na ordem de chegada assim que o estado existir. Não há como
 * saber aqui se a sessão vai cair em `sampledIn`/amostragem: essa decisão só
 * existe depois de `init()`, e é lá que a fila é descartada se a sessão não
 * for amostrada.
 */
export function mark(name: string): void {
  if (!state) {
    if (pendingMarks.length >= MAX_PENDING_MARKS) return;
    const ts = nowMs();
    if (name === "action-ready") {
      pendingMarks.push({ name: "T2", timestamp: ts }, { name: "T3", timestamp: ts });
      return;
    }
    if (name === "context-ready") {
      pendingMarks.push({ name: "T2", timestamp: ts });
      return;
    }
    pendingMarks.push({ name, timestamp: ts });
    return;
  }

  // INTG-0139 A21 — achado B2 do A20: em alguns roteadores (confirmado com
  // `<BrowserRouter>` do react-router 7 + React 19), o `popstate` é
  // processado de forma síncrona pelo PRÓPRIO roteador — render, efeitos e
  // `mark()` da app rodam ANTES do listener de `popstate` da lib (registrado
  // depois, dentro de `init()`). O resultado: `mark()` gravava no ciclo da
  // rota ANTERIOR, porque a lib ainda não tinha percebido a troca. Chamar
  // `handleRouteChange()` aqui, no início de toda `mark()`, resolve isso sem
  // depender de ordem de listener nenhuma: se a rota já mudou, a lib
  // sincroniza (fecha o ciclo antigo, abre o novo) ANTES de gravar o marco —
  // o listener de `popstate` da lib, quando rodar depois, vira um no-op
  // (mesmo guard de `rawPath` que já existia). Pequena imprecisão residual
  // aceita: `routeStartTs` nesse caso é o instante em que `mark()` percebeu a
  // troca, não o instante exato do evento de navegação — mas nunca mais
  // grava no lote da rota errada.
  handleRouteChange();
  if (!state) return; // handleRouteChange() nunca zera state, guarda defensiva

  if (!state.sampledIn) return;
  if (name === "action-ready") {
    const ts = nowMs();
    // grava T2 e T3 no mesmo timestamp (spec A02). Se a app já chamou
    // 'context-ready' antes, este T2 é redundante (dois pontos no mesmo
    // marco não quebram a leitura de p50/p75/p95 no consolidado).
    recordMark("T2", ts);
    recordMark("T3", ts);
    return;
  }
  if (name === "context-ready") {
    recordMark("T2");
    return;
  }
  recordMark(name);
}

/** Força o envio do buffer pendente agora (ex.: antes de um unload manual). */
export function flush(): void {
  flushNow();
}

/** Só para teste/inspeção — não é API pública estável. */
export function __getStateForTest(): TelemetriaState | null {
  return state;
}

/**
 * Só para teste — não é API pública estável. `state` e `pendingMarks` são
 * singletons de módulo; sem isso, testes que rodam `init()`/`mark()` em
 * sequência no mesmo processo (ex.: `node --test`, que não recarrega o
 * módulo entre arquivos) vazam estado de um teste pro outro.
 */
export function __resetForTest(): void {
  state = null;
  pendingMarks = [];
  pendingNavStartTs = null;
  // `navHooksInstalled` zera pra permitir reinstalar contra um novo shim de
  // window/history a cada teste (INTG-0139 A09) — sem isso, o segundo teste
  // que troca o globalThis.window herdaria o wrapper preso ao objeto antigo.
  navHooksInstalled = false;
}
