#!/usr/bin/env node
// Debug tool: grep every script the T3 renderer has parsed (including lazy chunks) for a pattern.
//   node scripts/grep-bundle.mjs 'Cite selection' [context=300] [maxHits=3] [fileFilter]
import { connectApp } from "../sidecar/cdp.mjs";
process.stdout.on("error", () => process.exit(0));
const [pat, ctxArg, maxArg, fileFilter] = process.argv.slice(2);
const ctx = Number(ctxArg || 300);
const max = Number(maxArg || 3);
const cdp = await connectApp();
const scripts = [];
cdp.on("Debugger.scriptParsed", (p) => p.url && scripts.push(p));
await cdp.send("Debugger.enable");
await new Promise((r) => setTimeout(r, 1500));
for (const s of scripts) {
  if (!/^t3code/.test(s.url) || (fileFilter && !s.url.includes(fileFilter))) continue;
  const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId: s.scriptId });
  let i = scriptSource.indexOf(pat);
  let n = 0;
  while (i >= 0 && n < max) {
    console.log(`== ${s.url.split("/").pop()} @${i}\n${scriptSource.slice(Math.max(0, i - ctx), i + ctx)}\n`);
    i = scriptSource.indexOf(pat, i + 1);
    n++;
  }
}
await cdp.send("Debugger.disable");
cdp.close();
