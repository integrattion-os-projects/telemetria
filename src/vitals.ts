import type { VitalsSnapshot } from "./transport.js";

/**
 * Carrega `web-vitals` por import dinâmico (nunca no bundle do núcleo) e
 * escuta LCP/INP/CLS/TTFB, reportando cada valor pro callback assim que
 * fica disponível (os vitals chegam em momentos diferentes do ciclo de
 * vida da página).
 */
export async function observeVitals(onUpdate: (partial: VitalsSnapshot) => void): Promise<void> {
  const mod = await import("web-vitals");

  mod.onLCP((metric) => onUpdate({ lcp: metric.value }));
  mod.onINP((metric) => onUpdate({ inp: metric.value }));
  mod.onCLS((metric) => onUpdate({ cls: metric.value }));
  mod.onTTFB((metric) => onUpdate({ ttfb: metric.value }));
}
