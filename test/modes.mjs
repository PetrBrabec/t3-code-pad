#!/usr/bin/env node
// End-to-end test of permission and preview mode (and the tutorial) against the live T3 app.
//
//   node test/modes.mjs <scratchThreadRoute> <permissionThreadRoute> [--only=permission,preview,tutorial]
//
// Permission: types a prompt into the permission fixture thread (approval-required, Haiku) that makes
// the agent ask to run `touch` on a new file, then answers with the pad: Decline (nothing is run). A
// second prompt asks a question (AskUserQuestion) that the pad answers. Only in that fixture thread.
// Preview: the scratch thread's image fixture (three attached images) and its file link.
// Restores the open thread, the right panel and the stored settings afterwards.
import { mkdirSync, writeFileSync } from "node:fs";
import { connectApp } from "../sidecar/cdp.mjs";

const [route, permRoute, ...flags] = process.argv.slice(2);
if (!route?.startsWith("#/") || !permRoute?.startsWith("#/")) {
  console.error("usage: node test/modes.mjs '<#/env/scratch>' '<#/env/permission fixture>' [--only=permission,preview,tutorial]");
  process.exit(2);
}
const only = (flags.find((f) => f.startsWith("--only=")) || "--only=permission,preview,tutorial").slice(7).split(",");
const SHOTS = process.env.T3PAD_SHOTS || "/tmp/t3pad-e2e";
mkdirSync(SHOTS, { recursive: true });
const B = { create: 8, touchpad: 17, cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7, options: 9, up: 12, down: 13, left: 14, right: 15 };
const cdp = await connectApp();
const ev = (expr) => cdp.evaluate(expr);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  console.log(results.at(-1));
  if (!ok) failures++;
}
async function shot(name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
}
const down = (b) => ev(`window.__fakePad.buttons[${B[b]}] = {pressed:true,touched:true,value:1}; 1`);
const up = (b) => ev(`window.__fakePad.buttons[${B[b]}] = {pressed:false,touched:false,value:0}; 1`);
async function press(button, holdMs = 70) {
  await down(button);
  await sleep(holdMs);
  await up(button);
  await sleep(320);
}
const state = () => ev("window.__t3pad.state()");
const go = async (r) => { await ev(`location.hash = ${JSON.stringify(r)}; 1`); await sleep(2500); };
const panelPressed = `document.querySelector('button[aria-label="Toggle right panel"]')?.getAttribute("aria-pressed")`;
/** Type a prompt into the composer of the open thread and submit it (fixture threads only). */
async function sendPrompt(text) {
  // Wait until the previous turn has finished (the submit button replaces the stop button).
  await waitFor(`!!document.querySelector('button[aria-label="Submit message"]')`, 60000);
  await ev(`(() => { const e = document.querySelector('[data-testid="composer-editor"]').editor; e.commands.setContent(${JSON.stringify(text)}); return 1; })()`);
  await sleep(300);
  await ev(`document.querySelector('button[aria-label="Submit message"]').click(); 1`);
}
async function waitFor(expr, ms) {
  for (let t = 0; t < ms; t += 500) {
    if (await ev(expr)) return true;
    await sleep(500);
  }
  return false;
}

let origHash = null;
let origPanel = null;
let savedSettings;
let tutWasSeen = null;
try {
  await ev(`(() => {
    window.__fakePad = { id: "Fake DualSense (t3-pad modes)", index: 0, connected: true, mapping: "standard",
      timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })) };
    Object.defineProperty(navigator, "getGamepads", { value: () => [window.__fakePad], configurable: true });
    return 1; })()`);
  // No welcome card in the way (put back at the end if the user has not seen it yet).
  tutWasSeen = await ev(`window.__t3pad.tutorialSeen()`);
  await ev(`window.__t3pad.tutorialSeen(true); window.__t3pad.tutorialClose(); 1`);
  savedSettings = await ev(`localStorage.getItem("t3pad.settings.v1")`);
  await ev(`window.__t3pad.loadSettings({}); 1`);
  // A hidden T3 (another app in front, display off) throttles timers to about once a minute, so the
  // fake pad's presses would be missed. Refuse instead of reporting nonsense.
  if ((await ev("document.visibilityState")) !== "visible") throw new Error("T3 is not visible (timers throttled); run again when it is in front");
  origHash = await ev("location.hash");
  origPanel = await ev(panelPressed);

  if (only.includes("permission")) {
    // --- approval: the agent asks to write a file; the pad declines
    await go(permRoute);
    check("on the permission fixture thread", (await ev("location.hash")) === permRoute);
    // Bash with a command that changes something always asks (Write may be allowed for the session).
    await sendPrompt(`Fixture step. Use the Bash tool to run exactly: touch t3pad-declined-${Date.now()}.txt  If it is declined, reply with the one word Declined.`);
    const asked = await waitFor(`window.__t3pad.state().pendingKind === "approval"`, 60000);
    check("an approval request is pending", asked);
    await sleep(800);
    let s = await state();
    check("pill shows the waiting hint but stays in chat mode", s.mode === "chat" && s.hud.includes("request waiting, L2"), `${s.mode} "${s.hud}"`);
    await press("l2");
    s = await state();
    check("L2: reply mode first", s.mode === "reply", `${s.mode} "${s.hud}" ${JSON.stringify(s.tutorial)} ${s.lastError}`);
    await press("l2");
    await sleep(300);
    s = await state();
    check("L2 again: permission mode (only because a request waits)", s.mode === "permission" && s.hud.includes("PERMISSION"), `${s.mode} "${s.hud}"`);
    let permFrom = s.perm?.from;
    check("choices read from T3, allow first", s.perm && s.perm.choices[0] === "Approve" && s.perm.choices.includes("Decline"), JSON.stringify(s.perm?.choices));
    check("nothing highlighted yet", s.perm.index === -1 && !s.ring, `${s.perm.index} ${s.ring}`);
    await press("cross");
    s = await state();
    check("a stray Cross answers nothing", s.pendingKind === "approval" && s.mode === "permission", `${s.pendingKind} ${s.mode}`);
    await press("square");
    await press("triangle");
    s = await state();
    check("other buttons do nothing in permission mode", s.mode === "permission" && s.pendingKind === "approval");
    await press("down");
    s = await state();
    check("first D-pad press highlights the first choice", s.perm.index === 0 && s.ring === "Approve" && s.hud.includes("Approve"), `${s.perm.index} ring=${s.ring} "${s.hud}"`);
    await shot("12-permission");
    for (let i = 0; i < 5 && (await state()).perm.choices[(await state()).perm.index] !== "Decline"; i++) await press("down");
    s = await state();
    check("D-pad walks to Decline", s.ring === "Decline", s.ring);
    await press("cross");
    await sleep(1200);
    s = await state();
    check("Cross declines: request gone, back to the previous mode", s.pendingKind === null && s.mode === permFrom, `${s.pendingKind} ${s.mode}`);
    await press("circle");
    if ((await state()).mode === "reply") await press("circle");

    // --- a choice that only lives in T3's "..." menu: Cancel (never "Always allow" in this fixture)
    await sendPrompt(`Fixture step. Use the Bash tool to run exactly: touch t3pad-cancelled-${Date.now()}.txt  If it is not run, reply with the one word Cancelled.`);
    check("a second approval request is pending", await waitFor(`window.__t3pad.state().pendingKind === "approval"`, 60000));
    await sleep(800);
    await press("l2");
    await press("l2");
    if ((await state()).mode !== "permission") await press("l2");
    permFrom = (await state()).perm?.from;
    for (let i = 0; i < 6 && (await state()).ring !== "Cancel"; i++) await press("down");
    s = await state();
    check("D-pad reaches the menu-only choice Cancel (ring on the ... button)", s.mode === "permission" && s.ring === "Cancel", `${s.mode} ${s.ring}`);
    await press("cross");
    await sleep(1500);
    s = await state();
    check("Cross on Cancel goes through T3's menu: request gone, menu closed, back to the previous mode", s.pendingKind === null && s.mode === permFrom && !(await ev(`!!document.querySelector("[role=menu]")`)), `${s.pendingKind} ${s.mode}`);
    await press("circle");
    if ((await state()).mode === "reply") await press("circle");

    // --- question: the agent asks, the pad answers
    await sendPrompt('Fixture step. Use the AskUserQuestion tool to ask me "Which fruit for the fixture?" with the options Apple, Pear, Plum. Then reply with the chosen fruit in one word.');
    const q = await waitFor(`window.__t3pad.state().pendingKind === "question"`, 60000);
    check("a question is pending", q);
    await sleep(800);
    s = await state();
    check("pill says a question waits", s.mode === "chat" && s.hud.includes("question waiting"), s.hud);
    await press("l2");
    await press("l2");
    s = await state();
    if ((await state()).mode !== "permission") await press("l2");
    s = await state();
    permFrom = s.perm?.from;
    check("question choices in permission mode", s.mode === "permission" && JSON.stringify(s.perm?.choices) === JSON.stringify(["Apple", "Pear", "Plum"]), JSON.stringify(s.perm?.choices));
    await press("up"); // from nothing, up starts at the last choice
    await press("up");
    s = await state();
    check("D-pad up from nothing: last choice, then the one above", s.ring === "Pear", s.ring);
    await shot("13-question");
    await press("cross");
    await sleep(1200);
    s = await state();
    check("Cross answers the question, back to the previous mode", s.pendingKind === null && s.mode === permFrom, `${s.pendingKind} ${s.mode}`);
    const answered = await waitFor(`[...document.querySelectorAll("[data-timeline-row-kind=message]")].at(-1)?.innerText.includes("Pear")`, 30000);
    check("the agent got Pear", answered);
    await press("circle");
    if ((await state()).mode === "reply") await press("circle");
    check("no request: L2 cycles chat and reply only", await (async () => { await press("l2"); await press("l2"); return (await state()).mode === "chat"; })());
  }

  if (only.includes("preview")) {
    await go(route);
    // --- image lightbox: Cross opens, left / right walk the images, Circle closes
    await ev(`window.__t3pad.setLevel("sentence"); 1`);
    await ev(`window.__t3pad.jump("Image fixture: three images", 0)`);
    let s = await state();
    check("attached image is a stop", s.unitKind === "image" && s.unitText.includes("otter-one"), `${s.unitKind} ${s.unitText}`);
    await press("cross");
    await sleep(1200);
    s = await state();
    check("Cross opens the lightbox, pill shows PREVIEW", s.uiMode === "preview" && s.preview?.kind === "lightbox" && s.hud.includes("PREVIEW"), `${s.uiMode} "${s.hud}"`);
    await press("right");
    await sleep(500);
    s = await state();
    const dlgImg = `(() => { const d = [...document.querySelectorAll('[role=dialog]')].find((x) => x.getClientRects().length); return d?.querySelector("img")?.getAttribute("alt") || d?.innerText.slice(0, 40) || null; })()`;
    check("right: next image in the lightbox", s.preview?.img === "otter-two.png" && (await ev(dlgImg)) !== null, `${s.preview?.img} dialog=${await ev(dlgImg)}`);
    await shot("14-lightbox");
    await press("right");
    await sleep(500);
    await press("left");
    await sleep(500);
    s = await state();
    check("right, left: back to the second image", s.preview?.img === "otter-two.png", s.preview?.img);
    await press("circle");
    await sleep(500);
    s = await state();
    check("Circle closes the lightbox, preview mode ends, highlight on the last image", s.uiMode === "chat" && !(await ev(dlgImg)) && s.unitText?.includes("otter-two"), `${s.uiMode} ${s.unitText}`);

    // --- right panel: file preview, scroll, Circle closes
    await ev(`window.__t3pad.jump("File fixture: see", 0)`);
    for (let i = 0; i < 4 && (await state()).unitKind !== "link"; i++) await press("down");
    await press("cross");
    await sleep(1600);
    s = await state();
    check("Cross on a file link: preview mode (right panel)", s.uiMode === "preview" && s.preview?.kind === "panel" && (await ev(panelPressed)) === "true", `${s.uiMode} ${s.preview?.kind}`);
    await press("left");
    s = await state();
    check("panel without images: says so", s.hud.includes("No images"), s.hud);
    await press("circle");
    await sleep(600);
    s = await state();
    check("Circle closes the panel and preview mode", s.uiMode === "chat" && (await ev(panelPressed)) !== "true" && (await ev("location.hash")) === route, `${s.uiMode} ${await ev(panelPressed)}`);
    await ev(`(() => { document.querySelector('[data-right-panel-tabbar] button[aria-label="Close t3pad-notes.md"]')?.click(); return 1; })()`);

    // --- right panel with a web page: scroll it, walk its images, show one large, back, close
    await ev(`window.__t3pad.jump("Web fixture: the", 0)`);
    for (let i = 0; i < 4 && (await state()).unitKind !== "link"; i++) await press("down");
    s = await state();
    check("web link highlighted (as a stop, or in its sentence)", s.selection.includes("sea otter article"), `${s.unitKind}: ${s.selection}`);
    await press("cross");
    await sleep(4000);
    s = await state();
    check("Cross on a web link: preview mode (web page in the right panel)", s.uiMode === "preview" && s.preview?.kind === "panel", `${s.uiMode} ${s.preview?.kind} "${s.hud}"`);
    const inWeb = (js) => ev(`(async () => { const v = [...document.querySelectorAll("webview[data-preview-tab]")].find((x) => { const r = x.getBoundingClientRect(); return r.width > 50 && r.left < innerWidth && r.right > 0; }); return v ? v.executeJavaScript(${JSON.stringify(js)}) : null; })()`);
    const y0 = await inWeb("scrollY");
    await press("down");
    await press("down");
    const y1 = await inWeb("scrollY");
    check("D-pad down scrolls the web page", y1 > y0, `${y0} -> ${y1}`);
    await ev(`window.__fakePad.axes[1] = 1; 1`);
    await sleep(400);
    await ev(`window.__fakePad.axes[1] = 0; 1`);
    const y2 = await inWeb("scrollY");
    check("left stick scrolls the web page too", y2 > y1, `${y1} -> ${y2}`);
    await press("right");
    s = await state();
    check("right picks the first image of the page (outlined)", s.preview?.index === 0 && s.preview?.count > 1 && (await inWeb("document.images[0] && [...document.images].some((i) => i.style.outline.includes('3px'))")), `${JSON.stringify(s.preview)} "${s.hud}"`);
    await press("right");
    s = await state();
    check("right again: the second image", s.preview?.index === 1, JSON.stringify(s.preview));
    await shot("15-web-preview");
    const pageUrl = await inWeb("location.href");
    await press("cross");
    await sleep(2500);
    const bigUrl = await inWeb("location.href");
    s = await state();
    check("Cross shows the picked image large in the preview", s.preview?.big === "web" && bigUrl !== pageUrl && /\.(jpe?g|png|webp|svg)/i.test(bigUrl), `${s.preview?.big} ${String(bigUrl).slice(-50)}`);
    await shot("16-web-image-large");
    await press("circle");
    await sleep(2500);
    s = await state();
    check("Circle steps back to the page, still in preview mode", s.uiMode === "preview" && !s.preview?.big && (await inWeb("location.href")) === pageUrl, `${s.uiMode} ${s.preview?.big} ${String(await inWeb("location.href")).slice(-40)}`);
    await press("circle");
    await sleep(800);
    s = await state();
    check("Circle closes the web preview, same thread", s.uiMode === "chat" && (await ev(panelPressed)) !== "true" && (await ev("location.hash")) === route, `${s.uiMode} ${await ev(panelPressed)}`);
  }
  if (only.includes("tutorial")) {
    // the practice thread's uuid (configured via localStorage "t3pad.tutorialThread", see README)
    const TUT_ID = (await ev(`localStorage.getItem("t3pad.tutorialThread") || "mcp:47488447-5d0b-46cf-adaa-1620d2781ecd"`)).replace(/^mcp:/, "");
    await go(route);
    // Dictation stays on this side of the page (no VoiceInk recording).
    await ev(`(() => { const real = window.t3padNative; window.__realNative = real; window.t3padNative = (p) => { if (JSON.parse(p).op !== "ptt") real(p); }; return 1; })()`);
    await ev(`window.__t3pad.tutorialWelcome(); 1`);
    let s = await state();
    check("welcome card (as on a first run)", s.tutorial?.welcome && s.tutorial.text.includes("Welcome") && s.tutorial.text.includes("start the tutorial"), s.tutorial?.text.slice(0, 60));
    await shot("17-tutorial-welcome");
    await press("cross");
    await sleep(2500);
    s = await state();
    const tutHash = await ev("location.hash");
    check("Cross starts it in its own thread", s.tutorial?.step === 0 && tutHash.includes(TUT_ID) && s.tutorial.text.includes("Pick a sentence"), `${tutHash.slice(-30)} ${s.tutorial?.title}`);
    check("step shows the button's line from the table", s.tutorial.text.includes("previous / next piece of text"), s.tutorial.text.replace(/\s+/g, " ").slice(0, 120));
    await shot("18-tutorial-step");
    const stepIs = async (title) => { for (let i = 0; i < 12; i++) { if ((await state()).tutorial?.title === title) return true; await sleep(200); } return false; };
    await press("down");
    check("step 1 done by a real D-pad press, step 2 follows", await stepIs("Zoom"));
    await press("right");
    check("step 2 (zoom) done", await stepIs("Quote it"));
    await press("square");
    check("step 3 (quote, a real citation chip from the agent's text) done", await stepIs("Edit your reply") && (await ev(`document.querySelectorAll('[data-testid="composer-editor"] [data-composer-citation-chip]').length`)) > 0, await (async () => { const x = await state(); return `hud "${x.hud}" sel "${x.selection.slice(0, 30)}" level ${x.level} cite ${x.citeVisible} err ${x.lastError} chips ${await ev(`document.querySelectorAll('[data-testid="composer-editor"] [data-composer-citation-chip]').length`)}`; })());
    await press("l2");
    check("step 4 (reply mode) done", await stepIs("Delete a piece"));
    await press("up");
    await press("square");
    check("step 5 (delete) done", await stepIs("Undo"));
    await sleep(400);
    await press("triangle");
    check("step 6 (undo) done", await stepIs("Move the caret"));
    for (let i = 0; i <= 15; i++) { await ev(`window.__t3pad.touchNative({ op: "touch", down: true, x: ${-0.6 + i * 0.03}, y: 0 }); 1`); await sleep(16); }
    await ev(`window.__t3pad.touchNative({ op: "touch", down: false }); 1`);
    check("step 7 (touchpad caret) done", await stepIs("Dictate"));
    await down("r2"); await sleep(250); await up("r2"); await sleep(200);
    check("step 8 (dictate) done", await stepIs("Send"));
    await ev(`(() => { const e = document.querySelector('[data-testid="composer-editor"]').editor; e.commands.insertContent(" (tutorial test)"); return 1; })()`);
    await sleep(300);
    await press("options");
    check("step 9 (send) done", await stepIs("The menu"));
    await down("create"); await sleep(650); await up("create"); await sleep(300);
    check("step 10 (menu) done: finished card", await stepIs("finished"));
    await press("circle"); // close the menu
    await sleep(4500);
    s = await state();
    check("after the last step it ends and goes back to the thread it started from", !s.tutorial && (await ev("location.hash")) === route, `${s.tutorial?.title} ${(await ev("location.hash")).slice(-20)}`);

    // From the menu, and skipped by holding Circle; a short Circle still does its usual thing.
    await down("create"); await sleep(650); await up("create"); await sleep(200);
    for (let i = 0; i < 20 && !(await state()).menu.includes("Start the tutorial") ; i++) await sleep(50);
    const tutRow = await ev(`window.__t3pad.state().menu.includes("Start the tutorial")`);
    for (let i = 0; i < 12 && !(await ev(`document.querySelector("[data-t3pad-menu] .t3p-item.on")?.innerText.includes("Start the tutorial")`)); i++) await press("down");
    await press("cross");
    await sleep(2500);
    s = await state();
    check("menu row starts the tutorial", tutRow && s.tutorial?.step === 0 && (await ev("location.hash")).includes(TUT_ID), `${tutRow} ${s.tutorial?.title}`);
    await press("circle");
    s = await state();
    check("a short Circle does not skip", s.tutorial?.step === 0, s.tutorial?.title);
    await down("circle"); await sleep(700); await up("circle"); await sleep(300);
    s = await state();
    check("holding Circle skips it", !s.tutorial && s.hud.includes("skipped"), `${s.tutorial?.title} "${s.hud}"`);
    await sleep(1500);
    check("and goes back to the thread it started from", (await ev("location.hash")) === route, (await ev("location.hash")).slice(-20));
    await ev(`if (window.__realNative) window.t3padNative = window.__realNative; 1`);
  }
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await ev(`window.__t3pad.tutorialClose(); 1`).catch(() => {}); // a tutorial left running would mark itself seen later
  if (tutWasSeen === false) await ev(`window.__t3pad.tutorialSeen(false); 1`).catch(() => {});
  await ev(`delete navigator.getGamepads; delete window.__fakePad; 1`).catch(() => {});
  if (savedSettings !== undefined) await ev(`(() => { const raw = ${JSON.stringify(savedSettings)}; if (raw === null) localStorage.removeItem("t3pad.settings.v1"); else localStorage.setItem("t3pad.settings.v1", raw);
    window.__t3pad.loadSettings(raw ? JSON.parse(raw) : {}); return 1; })()`).catch(() => {});
  if (origHash) await ev(`location.hash = ${JSON.stringify(origHash)}; 1`).catch(() => {});
  if (origPanel) await sleep(1500).then(() => ev(`(() => { const t = document.querySelector('button[aria-label="Toggle right panel"]'); if (t && t.getAttribute("aria-pressed") !== ${JSON.stringify(origPanel)}) t.click(); return 1; })()`)).catch(() => {});
  cdp.close();
}
writeFileSync(`${SHOTS}/results-modes.txt`, results.join("\n") + "\n");
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
