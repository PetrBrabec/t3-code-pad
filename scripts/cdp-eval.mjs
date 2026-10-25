#!/usr/bin/env node
// Debug tool: evaluate JS from stdin (or argv) in the T3 renderer and print the JSON result.
//   node scripts/cdp-eval.mjs 'document.title'
//   node scripts/cdp-eval.mjs < probe.js
//   node scripts/cdp-eval.mjs --screenshot out.png
import { readFileSync, writeFileSync } from "node:fs";
import { connectApp } from "../sidecar/cdp.mjs";

const args = process.argv.slice(2);
const cdp = await connectApp();
try {
  if (args[0] === "--screenshot") {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(args[1], Buffer.from(data, "base64"));
    console.log(`wrote ${args[1]}`);
  } else {
    const expr = args.length ? args.join(" ") : readFileSync(0, "utf8");
    const value = await cdp.evaluate(expr);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
} finally {
  cdp.close();
}
