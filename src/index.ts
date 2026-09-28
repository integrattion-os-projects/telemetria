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

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
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
 * Inicializa a telemetria pra uma sessão de página. Idempotente: chamar de
 * novo substitui a config e reseta o estado (útil em navegação client-side
 * de SPA, onde a app deve chamar `init` de novo a cada mudança de rota).
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

  // Drena a fila de mark() chamados antes de init() — na ordem em que
  // chegaram, com o timestamp capturado no momento original da chamada.
  if (pendingMarks.length > 0) {
    for (const pending of pendingMarks) {
      state.buffer.push(pending);
    }
    pendingMarks = [];
  }

  // T0 — reação ao clique/navegação: primeiro clique após o init.
  if (typeof window !== "undefined") {
    const onFirstInteraction = () => {
      recordMark("T0");
      window.removeEventListener("click", onFirstInteraction, true);
    };
    window.addEventListener("click", onFirstInteraction, true);
  }

  // T1 — estrutura: DOMContentLoaded já disparou (import dinâmico só roda
  // depois de load, então isso é sempre verdadeiro) ou o first-contentful-paint.
  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    const fcp = performance
      .getEntriesByType("paint")
      .find((entry) => entry.name === "first-contentful-paint");
    recordMark("T1", fcp ? fcp.startTime : undefined);
  } else {
    recordMark("T1");
  }

  // T4 — completo: load já disparou (mesma razão do T1) ou loadEventEnd.
  if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
    const [navEntry] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    recordMark("T4", navEntry?.loadEventEnd || undefined);
  } else {
    recordMark("T4");
  }

  void observeVitals((partial) => {
    if (!state) return;
    state.vitals = { ...state.vitals, ...partial };
  });
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
}
