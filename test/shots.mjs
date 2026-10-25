#!/usr/bin/env node
// Design screenshots of the pill and the menu, in chat, reply, palette and preview mode (and the menu's
// permission / preview sheets, the tutorial's welcome card), dark and light theme.
//
//   node test/shots.mjs <scratchThreadRoute> [outDir]
//
// Runs in the scratch thread only, with the fake pad from e2e.mjs; restores the open thread, the
// theme and the composer selection afterwards. Takes a few seconds.
import { mkdirSync, writeFileSync } from "node:fs";
import { connectApp } from "../sidecar/cdp.mjs";

const [route, out = "/tmp/t3pad-shots"] = process.argv.slice(2);
if (!route?.startsWith("#/")) {
  console.error("usage: node test/shots.mjs '<#/env/thread route>' [outDir]");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const cdp = await connectApp();
const ev = (expr) => cdp.evaluate(expr);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${out}/${name}.png`, Buffer.from(data, "base64"));
  console.log(`${out}/${name}.png`);
}
const press = (name) => ev(`window.__t3pad.press(${JSON.stringify(name)})`);
const origHash = await ev("location.hash");
// T3 applies a custom theme as inline variables on <html> (data-theme-id); for the light shots they
// are set aside together with the .dark class, and put back afterwards.
await ev(`(() => { const h = document.documentElement; window.__t3padTheme = { style: h.getAttribute("style"), id: h.getAttribute("data-theme-id"), dark: h.classList.contains("dark") }; return 1; })()`);
const setTheme = (theme) => ev(theme === "dark"
  ? `(() => { const h = document.documentElement, t = window.__t3padTheme; h.setAttribute("style", t.style); if (t.id) h.setAttribute("data-theme-id", t.id); h.classList.add("dark"); return 1; })()`
  : `(() => { const h = document.documentElement; h.removeAttribute("style"); h.removeAttribute("data-theme-id"); h.classList.remove("dark"); return 1; })()`);
const tutWasSeen = await ev(`window.__t3pad.tutorialSeen()`);
await ev(`window.__t3pad.tutorialSeen(true); 1`);
try {
  await ev(`(() => {
    window.__fakePad = { id: "Fake DualSense (t3-pad shots)", index: 0, connected: true, mapping: "standard",
      timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })) };
    Object.defineProperty(navigator, "getGamepads", { value: () => [window.__fakePad], configurable: true });
    return 1; })()`);
  await ev(`location.hash = ${JSON.stringify(route)}; 1`);
  await sleep(2000);
  for (const theme of ["dark", "light"]) {
    await setTheme(theme);
    await ev(`window.__t3pad.setLevel("sentence"); window.__t3pad.jump("Otters are semi-aquatic", 1)`);
    await sleep(1700);
    await shot(`pill-chat-${theme}`);
    await press("createHold");
    await sleep(150);
    await shot(`menu-chat-${theme}`);
    await press("down");
    await press("down");
    await sleep(100);
    await shot(`menu-settings-${theme}`);
    await press("circle");
    await press("l2");
    await sleep(1600);
    await shot(`pill-reply-${theme}`);
    await press("createHold");
    await sleep(150);
    await shot(`menu-reply-${theme}`);
    await press("create");
    await press("l2");
    await press("create"); // tap: command palette
    await sleep(500);
    await press("down");
    await sleep(200);
    await shot(`pill-palette-${theme}`);
    await press("createHold");
    await sleep(150);
    await shot(`menu-palette-${theme}`);
    await press("r1"); // page the sheet: permission, then preview
    await sleep(150);
    await shot(`menu-permission-${theme}`);
    await press("r1");
    await sleep(150);
    await shot(`menu-preview-${theme}`);
    await press("create");
    await press("circle");
    await sleep(400);
    // preview mode: an attached image opened in the lightbox
    await ev(`window.__t3pad.jump("Image fixture: three images", 0)`);
    await sleep(300);
    await press("cross");
    await sleep(1200);
    await press("right");
    await sleep(900);
    await shot(`pill-preview-${theme}`);
    await press("circle");
    await sleep(500);
    // the tutorial's welcome card
    await ev(`window.__t3pad.tutorialWelcome(); 1`);
    await sleep(300);
    await shot(`tutorial-welcome-${theme}`);
    await ev(`window.__t3pad.tutorialClose(); 1`);
    await sleep(200);
  }
} finally {
  await ev(`(() => { const h = document.documentElement, t = window.__t3padTheme; if (!t) return 0; h.setAttribute("style", t.style); if (t.id) h.setAttribute("data-theme-id", t.id); h.classList.toggle("dark", t.dark); delete window.__t3padTheme; return 1; })()`).catch(() => {});
  if (tutWasSeen === false) await ev(`window.__t3pad.tutorialSeen(false); 1`).catch(() => {});
  await ev(`delete navigator.getGamepads; delete window.__fakePad; 1`).catch(() => {});
  if (origHash !== route) await ev(`location.hash = ${JSON.stringify(origHash)}; 1`).catch(() => {});
  cdp.close();
}
