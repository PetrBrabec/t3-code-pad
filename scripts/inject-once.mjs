#!/usr/bin/env node
// Dev tool: evaluate src/t3pad.js into the running T3 renderer once (no sidecar, no persistence).
import { readFileSync } from "node:fs";
import { connectApp } from "../sidecar/cdp.mjs";
const src = readFileSync(new URL("../src/t3pad.js", import.meta.url), "utf8");
const cdp = await connectApp();
await cdp.evaluate(src);
console.log(JSON.stringify(await cdp.evaluate("window.__t3pad.state()")));
cdp.close();
