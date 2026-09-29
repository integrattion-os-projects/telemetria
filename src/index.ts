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

/**
 * INTG-0139 A09 — achado do C01: a lib fixava a rota em `init()` (chamado uma
 * vez no boot) e não percebia navegação client-side (SPA/App Router). Toda
 * tela aberta depois por clique herdava o tempo da carga original, inflado.
 *
 * `lastClickTs` é atualizado por um listener PERSISTENTE (nunca removido,
 * diferente do antigo `onFirstInteraction` de uma vez só) — é o que permite
 * `handleRouteChange` saber se a navegação atual nasceu de um clique recente
 * o bastante pra virar T0 real (clique → próximo quadro pintado), sem
 * depender de a app instrumentar o clique manualmente.
 */
let lastClickTs: number | null = null;
const MAX_CLICK_TO_NAV_GAP_MS = 3000;
let navHooksInstalled = false;

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

  const route =
    config.route ??
    normalizeRoute(
      typeof location !== "undefined" ? location.pathname : "/",
      { extraStaticSegments: config.extraStaticSegments },
    );

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
  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    const fcp = performance
      .getEntriesByType("paint")
      .find((entry) => entry.name === "first-contentful-paint");
    recordMark("T1", fcp ? fcp.startTime : undefined);

    const [navEntry] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    recordMark("T4", navEntry?.loadEventEnd || undefined);
  } else {
    recordMark("T1");
    recordMark("T4");
  }
}

/**
 * Troca de rota client-side (SPA). `newRoute` já é o valor de retorno de
 * `normalizeRoute` no instante da chamada — recalculado aqui e não passado
 * pelo chamador porque `handleRouteChange` é o único ponto de entrada tanto
 * do wrapper de pushState/replaceState quanto do listener de `popstate`.
 *
 * Fecha o ciclo da rota anterior (flush do que estiver pendente) ANTES de
 * trocar `state.config.route` — é o que garante que os eventos da rota
 * antiga cheguem no `TelemetriaConsolidadoDiario` com a rota certa, mesmo
 * que o buffer ainda tivesse itens não drenados. O buffer em si NÃO é
 * recriado (só flushado): recriar zeraria `totalAccepted` e o teto de
 * eventos por sessão (spec A02) passaria a valer por rota, não por sessão.
 */
function handleRouteChange(): void {
  if (!state) return;

  const newRoute = normalizeRoute(
    typeof location !== "undefined" ? location.pathname : "/",
    { extraStaticSegments: state.config.extraStaticSegments },
  );
  if (newRoute === state.config.route) return; // ex.: pushState só de query string

  flushNow();

  const navChangeTs = nowMs();
  const clickTs = lastClickTs;
  const clickIsRecent = clickTs != null && navChangeTs - clickTs <= MAX_CLICK_TO_NAV_GAP_MS;

  state.config.route = newRoute;

  if (!state.sampledIn) return;

  doubleRaf(() => {
    if (!state || state.config.route !== newRoute) return; // outra navegação já aconteceu
    const paintedTs = nowMs();
    recordMark("T1", paintedTs - navChangeTs);
    if (clickIsRecent) {
      recordMark("T0", paintedTs - (clickTs as number));
    }
  });

  onIdle(() => {
    if (!state || state.config.route !== newRoute) return;
    recordMark("T4", nowMs() - navChangeTs);
  });
}

/**
 * Instrumenta `history.pushState`/`replaceState` (o App Router do Next e
 * praticamente toda SPA passam por eles, com ou sem `popstate` — o navegador
 * não dispara `popstate` sozinho pra navegação programática) + `popstate`
 * (botão voltar/avançar) + um listener de clique PERSISTENTE pra alimentar
 * `lastClickTs`. Idempotente: chamado a cada `init()`, mas só instala uma vez
 * por `globalThis` — `__resetForTest` zera a flag pra testes que trocam o
 * `window`/`history` global a cada rodada.
 */
function installNavigationHooks(): void {
  if (navHooksInstalled) return;
  if (typeof window === "undefined" || typeof history === "undefined") return;
  navHooksInstalled = true;

  window.addEventListener(
    "click",
    () => {
      lastClickTs = nowMs();
    },
    { capture: true, passive: true },
  );

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

function recordMark(name: string, timestamp?: number): void {
  if (!state || !state.sampledIn) return;
  state.buffer.push({
    name,
    timestamp: timestamp ?? nowMs(),
  });
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
  lastClickTs = null;
  // `navHooksInstalled` zera pra permitir reinstalar contra um novo shim de
  // window/history a cada teste (INTG-0139 A09) — sem isso, o segundo teste
  // que troca o globalThis.window herdaria o wrapper preso ao objeto antigo.
  navHooksInstalled = false;
}

/** Só para teste — expõe se o clique disparou uma navegação recente o
 * bastante pra virar T0 real. Não é API pública estável. */
export function __simulateClickForTest(): void {
  lastClickTs = nowMs();
}
