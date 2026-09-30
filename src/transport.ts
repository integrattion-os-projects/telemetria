import type { BufferedEvent } from "./buffer.js";

export interface VitalsSnapshot {
  lcp?: number;
  inp?: number;
  cls?: number;
  ttfb?: number;
}

/**
 * Como este ciclo de marcos foi aberto. `"boot"` é a carga inicial;
 * `"pushstate"`/`"replacestate"` são navegação client-side comum, com
 * `routeStartTs` confiável (o wrapper da lib roda antes de qualquer render
 * do app). `"popstate"` (INTG-0139 A23, achado do A22) é o botão
 * voltar/avançar do navegador — nesse caso o roteador da app pode
 * re-renderizar de forma SÍNCRONA antes do listener da lib rodar (a lib é
 * carregada por import dinâmico, depois do boot do roteador — não há como
 * "furar a fila" de listeners já registrados), então T1/T3 desse ciclo
 * tendem a ficar subestimados (a duração real do render se perde). O
 * consolidado (A03, `app/app/api/telemetria/consolidar`) exclui ciclos
 * `"popstate"` do cálculo de p50/p75/p95 de T1/T3 por decisão do Fioda —
 * o ciclo continua contado (frequência), só o tempo não entra na métrica.
 */
export type NavOrigin = "boot" | "pushstate" | "replacestate" | "popstate";

export interface TelemetriaPayload {
  entitySlug: string;
  route: string;
  marks: BufferedEvent[];
  vitals: VitalsSnapshot;
  sessionId: string;
  nav: NavOrigin;
}

/**
 * Envia o payload em UMA chamada via `navigator.sendBeacon` (nunca fetch por
 * evento). Faz fallback silencioso pra `fetch(..., { keepalive: true })`
 * quando sendBeacon não existir ou recusar (ex.: payload grande demais) —
 * ainda assim uma única requisição por lote.
 */
export function sendBatch(endpoint: string, payload: TelemetriaPayload): void {
  const body = JSON.stringify(payload);

  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      const ok = navigator.sendBeacon(endpoint, blob);
      if (ok) return;
    }
  } catch {
    // cai no fallback abaixo
  }

  try {
    if (typeof fetch === "function") {
      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {
        // telemetria nunca pode quebrar a app — falha de rede é descartada
      });
    }
  } catch {
    // idem
  }
}
