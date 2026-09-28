import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const distDir = new URL("../dist/", import.meta.url).pathname;

const files = readdirSync(distDir).filter((f) => f.endsWith(".js") || f.endsWith(".cjs"));

console.log("Arquivo".padEnd(24), "raw".padStart(10), "gzip".padStart(10));
let coreGzip = 0;

for (const file of files) {
  const full = join(distDir, file);
  const raw = readFileSync(full);
  const gz = gzipSync(raw, { level: 9 });
  console.log(file.padEnd(24), `${raw.length}B`.padStart(10), `${gz.length}B`.padStart(10));
  if (file === "index.js") {
    coreGzip = gz.length;
  }
}

console.log("");
console.log(`Núcleo (dist/index.js) gzip: ${coreGzip} bytes (${(coreGzip / 1024).toFixed(2)} KB)`);
console.log(`Meta: <= 3072 bytes (3 KB). ${coreGzip <= 3072 ? "OK" : "ACIMA DA META"}`);
