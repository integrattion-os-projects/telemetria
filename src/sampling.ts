/**
 * Amostragem por sessão: a moeda é jogada uma vez por sessão (não por
 * evento), para não gerar telemetria fragmentada da mesma sessão.
 */
export function shouldSample(sampleRate: number, random: () => number = Math.random): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return random() < sampleRate;
}
