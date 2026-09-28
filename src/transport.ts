import type { BufferedEvent } from "./buffer.js";

export interface VitalsSnapshot {
  lcp?: number;
  inp?: number;
  cls?: number;
  ttfb?: number;
}

export interface TelemetriaPayload {
  entitySlug: string;
  route: string;
  marks: BufferedEvent[];
  vitals: VitalsSnapshot;
  sessionId: string;
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
