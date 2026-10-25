#!/usr/bin/env node
// End-to-end test against the live T3 app, driven through a fake gamepad.
//
//   node test/e2e.mjs <scratchThreadRoute> [--send] [--dictate]
//
// <scratchThreadRoute> is the hash route of the scratch fixture thread, e.g.
//   '#/<environment id>/<thread id>' (from location.hash while the thread is open)
// The fixture's assistant message is the otter text produced by the prompt in README "Testing".
// --send also presses Options and checks that the message was submitted (into the scratch thread only).
// --dictate lets R2 reach the helper for real: VoiceInk records ~0.7 s of microphone audio and pastes
//   whatever it hears into the composer. Without it the test stops the call at the page boundary.
//
// The module must already be injected (by the sidecar). Screenshots go to $T3PAD_SHOTS (default /tmp/t3pad-e2e).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { connectApp } from "../sidecar/cdp.mjs";

const [route, ...flags] = process.argv.slice(2);
if (!route?.startsWith("#/")) {
  console.error("usage: node test/e2e.mjs '<#/env/thread route>' [--send]");
  process.exit(2);
}
const SEND = flags.includes("--send");
const DICTATE = flags.includes("--dictate");
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
async function press(button, holdMs = 70) {
  await ev(`window.__fakePad.buttons[${B[button]}] = {pressed:true,touched:true,value:1}; 1`);
  await sleep(holdMs);
  await ev(`window.__fakePad.buttons[${B[button]}] = {pressed:false,touched:false,value:0}; 1`);
  await sleep(320); // actions are async (scrolling, selection observer)
}
const state = () => ev("window.__t3pad.state()");
const composer = () => ev("window.__t3pad.composer()");
/** What VoiceInk does after a dictation: Cmd+V into the editor. A paste event, no clipboard write. */
async function paste(text) {
  await ev(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)});
    document.querySelector('[data-testid="composer-editor"]').dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`);
  await sleep(750); // T3 groups undo steps closer than ~600 ms
}
/** Hold R2 like a dictation (the native call is stubbed unless --dictate), then paste the "transcript". */
async function dictate(text) {
  await ev(`window.__fakePad.buttons[${B.r2}] = {pressed:true,touched:true,value:1}; 1`);
  await sleep(250);
  await ev(`window.__fakePad.buttons[${B.r2}] = {pressed:false,touched:false,value:0}; 1`);
  await sleep(150);
  await paste(text);
}
const parts = async () => (await composer()).parts.map((p) => p.trim()).filter(Boolean);
/** Fake touchpad: a finger path of [x, y] points, fed like the native reader would (~60 Hz). */
async function swipe(points) {
  for (const [x, y] of points) {
    await ev(`window.__t3pad.touchNative({ op: "touch", down: true, x: ${x}, y: ${y} }); 1`);
    await sleep(16);
  }
  await ev(`window.__t3pad.touchNative({ op: "touch", down: false }); 1`);
  await sleep(100);
}
const line = (x0, y0, x1, y1, n) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
let origHash = null;
let origPanel = null;
let savedSettings; // undefined until read, so an early failure never touches the stored settings
let tutWasSeen = null;

try {
  check("module injected by sidecar", (await ev("window.__t3pad?.version")) != null);
  check("native binding present", (await ev("typeof window.t3padNative")) === "function");

  // Fake DualSense: the poll loop reads navigator.getGamepads() every tick.
  await ev(`(() => {
    window.__fakePad = { id: "Fake DualSense (t3-pad e2e)", index: 0, connected: true, mapping: "standard",
      timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })) };
    Object.defineProperty(navigator, "getGamepads", { value: () => [window.__fakePad], configurable: true });
    return 1;
  })()`);
  // Tunables: run with the defaults, put the user's own values back at the end.
  // No welcome card in the way (put back at the end if the user has not seen it yet).
  tutWasSeen = await ev(`window.__t3pad.tutorialSeen()`);
  await ev(`window.__t3pad.tutorialSeen(true); window.__t3pad.tutorialClose(); 1`);
  savedSettings = await ev(`localStorage.getItem("t3pad.settings.v1")`);
  await ev(`window.__t3pad.loadSettings({}); 1`);
  if ((await ev("document.visibilityState")) !== "visible") throw new Error("T3 is not visible (timers throttled); run again when it is in front");
  origHash = await ev("location.hash");
  origPanel = await ev(`document.querySelector('button[aria-label="Toggle right panel"]')?.getAttribute("aria-pressed")`);
  await ev(`location.hash = ${JSON.stringify(route)}; 1`);
  // T3 focuses the composer once the (long) thread has loaded, which takes the selection; let it settle.
  await sleep(4500);
  check("on scratch thread", (await ev("location.hash")) === route);
  check("pad detected", (await state()).pad?.id === "Fake DualSense (t3-pad e2e)");

  // --- sentence navigation
  await ev(`window.__t3pad.setLevel("sentence"); 1`);
  const first = await ev(`window.__t3pad.jump("Otters are semi-aquatic", 0)`);
  check("jump to fixture message", first.startsWith("Otters are semi-aquatic"), first);
  await press("down");
  let s = await state();
  const S2 = "Sea otters use tools, such as rocks, to crack shellfish: they float on their backs while they eat; this habit is rare among mammals.";
  check("D-pad down selects next sentence", s.selection === S2, s.selection);
  check("T3 Cite toolbar visible for the selection", s.citeVisible);

  // --- pill and cheat sheet, chat mode
  await sleep(1600);
  s = await state();
  check("idle pill stays up and shows CHAT", s.hudVisible && s.hud.includes("CHAT"), s.hud);
  const MNEMONIC = "Square acts on the selection: quote it (chat) / delete it (reply)";
  const activeOf = `(() => { const a = document.activeElement; return a ? a.tagName + "|" + (a.getAttribute("data-testid") || "") : null; })()`;
  const active0 = await ev(activeOf);
  const down = (b) => ev(`window.__fakePad.buttons[${B[b]}] = {pressed:true,touched:true,value:1}; 1`);
  const up = (b) => ev(`window.__fakePad.buttons[${B[b]}] = {pressed:false,touched:false,value:0}; 1`);

  // --- Create held: the t3-pad menu (cheat sheet + settings)
  await down("create");
  await sleep(300);
  check("Create held 0.3 s: nothing yet", (await state()).menu === null && !(await state()).palette);
  await sleep(400);
  s = await state();
  check("Create held 0.7 s opens the menu while still held", !!s.menu, `menu=${!!s.menu}`);
  await up("create");
  await sleep(300);
  s = await state();
  check("releasing a hold does not open the palette", !!s.menu && s.palette === null && s.uiMode === "chat", `palette=${s.palette}`);
  check("menu cheat sheet shows chat mode", s.menu.includes("CHAT") && s.menu.includes("quote the selection") && !s.menu.includes("delete the selection"), s.menu.replace(/\s+/g, " ").slice(0, 80));
  check("menu has the mnemonic and the settings", s.menu.includes(MNEMONIC) && s.menu.includes("Vertical travel per line") && s.menu.includes("Reset to defaults"));
  check("menu keeps the selection and focus", s.selection === S2 && (await ev(activeOf)) === active0, `${s.selection.slice(0, 30)} / ${active0}`);
  await shot("07-menu-chat");
  // settings: D-pad down to "Vertical travel per line", right raises it, live and stored
  await press("down");
  await press("down");
  const lt0 = (await state()).settings.lineTravel;
  await press("right");
  s = await state();
  const stored = JSON.parse((await ev(`localStorage.getItem("t3pad.settings.v1")`)) || "{}");
  check("menu: D-pad picks a setting, right changes it (live and stored)", s.menuIndex === 2 && s.settings.lineTravel === +(lt0 + 0.05).toFixed(4) && stored.lineTravel === s.settings.lineTravel, `index ${s.menuIndex}, ${lt0} -> ${s.settings.lineTravel}, stored ${stored.lineTravel}`);
  check("menu: D-pad did not move the chat selection", s.selection === S2 && s.level === "sentence", `${s.level}: ${s.selection.slice(0, 30)}`);
  await shot("09-menu-settings");
  await press("left");
  check("menu: left changes it back", (await state()).settings.lineTravel === lt0);
  await press("circle");
  s = await state();
  check("Circle closes the menu (and only the menu)", s.menu === null && s.selection === S2, s.selection.slice(0, 30));
  await down("create"); await sleep(650); await up("create"); await sleep(200);
  await press("create");
  check("a Create tap closes the menu", (await state()).menu === null && !(await state()).palette);

  // --- menu: L2 switches the mode and the cheat sheet follows; L1 / R1 page through the other modes
  await down("create"); await sleep(650); await up("create"); await sleep(200);
  check("menu footer says how to switch mode", (await state()).menu.includes("switch mode") && (await state()).menu.includes("buttons of the other modes"));
  await press("l2");
  s = await state();
  check("menu: L2 switches to reply mode, sheet follows", s.mode === "reply" && s.menuSheet === "reply" && s.menu.includes("delete the selection"), `${s.mode} / ${s.menuSheet}`);
  await press("l2");
  s = await state();
  check("menu: L2 again, back to chat", s.mode === "chat" && s.menuSheet === "chat" && s.menu.includes("quote the selection"), `${s.mode} / ${s.menuSheet}`);
  await press("r1");
  await press("r1");
  s = await state();
  check("menu: R1 pages to the palette sheet without switching mode or thread", s.menuSheet === "palette" && s.mode === "chat" && s.menu.includes("run the highlighted command") && (await ev("location.hash")) === route, `${s.menuSheet} ${s.mode}`);
  await press("l1");
  check("menu: L1 pages back", (await state()).menuSheet === "reply");
  await press("circle");
  check("menu closed again, still in chat mode", (await state()).menu === null && (await state()).mode === "chat");

  // --- pill: bottom left of the main pane (right of an open sidebar), centred on the sidebar footer row, clear of the composer
  const geo = await ev(`(() => { const r = (q) => document.querySelector(q)?.getBoundingClientRect().toJSON() || null;
    return { gap: r("[data-slot=sidebar-gap]"), sb: document.querySelector("[data-slot=sidebar]")?.getAttribute("data-state"), row: r("[data-slot=sidebar-footer] [data-slot=sidebar-menu]"),
      form: r("form[data-chat-composer-form]"), hud: r("[data-t3pad-hud]"), vh: innerHeight }; })()`);
  const expLeft = (geo.sb === "collapsed" || !geo.gap?.width ? 0 : geo.gap.right) + 14;
  check("pill sits at the main pane's left edge", Math.abs(geo.hud.left - expLeft) < 2, `${Math.round(geo.hud.left)} vs ${Math.round(expLeft)} (sidebar ${geo.sb})`);
  if (geo.row && geo.row.height) {
    const mid = (r) => (r.top + r.bottom) / 2;
    check("pill centred on the sidebar footer row (update icon)", Math.abs(mid(geo.hud) - mid(geo.row)) < 2, `${Math.round(mid(geo.hud))} vs ${Math.round(mid(geo.row))}`);
  }
  const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  check("pill does not cover the composer", !overlap(geo.hud, geo.form), `pill ${Math.round(geo.hud.left)}..${Math.round(geo.hud.right)}, composer from ${Math.round(geo.form?.left)}`);

  // --- Create tapped: T3's command palette, driven by the pad
  await press("create");
  await sleep(300);
  s = await state();
  check("Create tap opens the command palette, pill shows PALETTE", s.uiMode === "palette" && s.palette !== null && s.hud.includes("PALETTE"), `${s.uiMode} "${s.hud}"`);
  const pal0 = s.palette;
  await press("down");
  s = await state();
  check("palette: D-pad down moves the highlight", s.palette && s.palette !== pal0 && s.hud.includes(s.palette.slice(0, 12)), `${pal0} -> ${s.palette}`);
  await press("up");
  check("palette: D-pad up moves it back", (await state()).palette === pal0, (await state()).palette);
  await ev(`window.__fakePad.axes[1] = 1; 1`);
  await sleep(450);
  await ev(`window.__fakePad.axes[1] = 0; 1`);
  await sleep(100);
  const palStick = (await state()).palette;
  check("palette: left stick walks the commands", palStick !== pal0, `${pal0} -> ${palStick}`);
  const chips0 = await ev(`document.querySelectorAll('[data-testid="composer-editor"] [data-composer-citation-chip]').length`);
  const lv0 = (await state()).level;
  await press("left");
  await press("square");
  await press("triangle");
  s = await state();
  check("palette: chat bindings do not fire (no zoom, no quote, no jump)", s.uiMode === "palette" && s.level === lv0 && (await ev(`document.querySelectorAll('[data-testid="composer-editor"] [data-composer-citation-chip]').length`)) === chips0, `${s.uiMode} ${s.level}`);
  await shot("10-palette");
  // Cross runs the highlighted command: "New thread in..." only opens the project list (harmless).
  for (let i = 0; i < 12 && (await state()).palette !== "New thread in..."; i++) await press((await state()).palette?.startsWith("New thread in") ? "down" : "up");
  const optsBefore = await ev(`[...document.querySelectorAll('[data-testid="command-palette"] [role=option]')].map(o => o.textContent.trim()).join("|")`);
  await press("cross");
  await sleep(300);
  const optsAfter = await ev(`[...document.querySelectorAll('[data-testid="command-palette"] [role=option]')].map(o => o.textContent.trim()).join("|")`);
  check("palette: Cross runs the highlighted command (submenu opens)", (await state()).palette !== null && optsAfter !== optsBefore, `${optsBefore.slice(0, 40)} -> ${optsAfter.slice(0, 40)}`);
  for (let i = 0; i < 3 && (await state()).palette !== null; i++) await press("circle");
  s = await state();
  check("palette: Circle closes it, back to chat mode", s.palette === null && s.uiMode === "chat" && s.hud.includes("CHAT"), `${s.uiMode} "${s.hud}"`);
  check("route unchanged by the palette", (await ev("location.hash")) === route);

  // --- touchpad click in chat mode: word, sentence, paragraph
  await ev(`window.__t3pad.setLevel("sentence"); 1`);
  await ev(`window.__t3pad.jump("Otters are semi-aquatic", 1)`);
  await press("touchpad");
  s = await state();
  check("chat: touchpad click selects the first word of the highlight", s.selection === "Sea", s.selection);
  await press("touchpad");
  s = await state();
  check("chat: second click grows it to the sentence", s.selection === S2 && s.level === "sentence", `${s.level}: ${s.selection.slice(0, 30)}`);
  await press("touchpad");
  s = await state();
  check("chat: third click grows it to the paragraph", s.level === "paragraph" && s.selection.includes("Their dense fur") && s.selection.startsWith("Otters"), `${s.level}: ${s.selection.slice(0, 30)}`);
  await sleep(600);
  await press("touchpad");
  check("chat: a click after the window starts again at a word", (await state()).selection === "Otters", (await state()).selection);
  await ev(`window.__t3pad.setLevel("sentence"); 1`);
  await ev(`window.__t3pad.jump("Otters are semi-aquatic", 1)`);

  // --- zoom in to clauses and walk them (left = smaller unit)
  await press("left");
  s = await state();
  check("D-pad left zooms in to clause", s.level === "clause" && s.selection === "Sea otters use tools,", `${s.level}: ${s.selection}`);
  const clauses = ["such as rocks,", "to crack shellfish:", "they float on their backs while they eat;"];
  for (const c of clauses) {
    await press("down");
    s = await state();
    check(`clause step -> "${c}"`, s.selection === c, s.selection);
  }
  await shot("01-clause-selection");

  // --- quote
  await press("square");
  await sleep(300);
  const chips = await ev(`[...document.querySelectorAll('[data-testid="composer-editor"] [data-composer-citation-chip]')].map(c => c.innerText.trim())`);
  check("Square quotes the clause into the composer", chips.some((c) => c.includes("they float on their backs")), JSON.stringify(chips));
  check("citation comment popover closed", !(await ev(`!!document.querySelector('[aria-label="Edit citation comment"]')`)));
  await shot("02-quoted-into-composer");

  // --- zoom out to paragraph / message (right = bigger unit)
  await ev(`window.__t3pad.jump("Otters are semi-aquatic", 0)`); // clause level, first clause
  await press("right");
  s = await state();
  check("D-pad right zooms out to sentence", s.level === "sentence" && s.selection.startsWith("Otters are semi-aquatic"), `${s.level}: ${s.selection.slice(0, 40)}`);
  await press("right");
  s = await state();
  check("zoom out to paragraph", s.level === "paragraph" && s.selection.includes("Their dense fur"), `${s.level}: ${s.selection.slice(0, 40)}…`);
  await press("right");
  s = await state();
  check("zoom out to message", s.level === "message" && s.selection.includes("T3 Code on GitHub") && s.selection.includes("conservation work"), s.level);
  await press("left");
  await press("left");

  // --- R2 push-to-talk reaches the native side
  if (!DICTATE) {
    await ev(`(() => { const real = window.t3padNative; window.__realNative = real;
      window.t3padNative = (p) => { if (JSON.parse(p).op !== "ptt") real(p); }; return 1; })()`);
  }
  await ev(`window.__fakePad.buttons[${B.r2}] = {pressed:true,touched:true,value:1}; 1`);
  await sleep(700);
  const focused = await ev(`document.activeElement?.getAttribute("data-testid")`);
  await ev(`window.__fakePad.buttons[${B.r2}] = {pressed:false,touched:false,value:0}; 1`);
  await sleep(300);
  s = await state();
  const ptt = s.native.filter((n) => n.op === "ptt").slice(-2);
  check("R2 focuses the composer", focused === "composer-editor", focused);
  check("R2 down/up sent to the helper", ptt.length === 2 && ptt[0].down === true && ptt[1].down === false, JSON.stringify(ptt));
  const logPath = `${homedir()}/Library/Logs/t3-pad.log`;
  const logTail = readFileSync(logPath, "utf8").split("\n").slice(-30).join("\n");
  if (!DICTATE) await ev(`window.t3padNative = window.__realNative; 1`);
  else check(
    "helper received the dictation command",
    /dictation key down|no Accessibility permission|VoiceInk is not running/.test(logTail),
    (logTail.match(/\[helper\] (dictation key down|no Accessibility permission|VoiceInk is not running)[^\n]*/) || [""])[0].slice(0, 80),
  );

  // Simulate what VoiceInk pastes, so the send test has a body.
  await ev(`document.execCommand("insertText", false, "t3-pad e2e: quoted clause above, this line stands in for dictation."); 1`);
  const composerText = await ev(`document.querySelector('[data-testid="composer-editor"]').innerText`);
  check("composer holds quote + dictated text", composerText.includes("stands in for dictation"), composerText.replace(/\s+/g, " ").slice(0, 80));
  await shot("03-composer-ready-to-send");

  // --- two quotes in a row: A, dictation, B, dictation must come out in that order
  if (!DICTATE) await ev(`(() => { const real = window.t3padNative; window.t3padNative = (p) => { if (JSON.parse(p).op !== "ptt") real(p); }; return 1; })()`);
  await ev(`document.querySelector('[data-testid="composer-editor"]').editor.commands.clearContent(); 1`);
  await ev(`window.__t3pad.setLevel("clause"); 1`);
  await ev(`window.__t3pad.jump("Otters are semi-aquatic", 1)`); // "Sea otters use tools,"
  await press("square");
  await sleep(300);
  let c = await composer();
  check("after a cite the caret sits right after the chip", c.empty && c.parts[0] === "[chip]" && c.from === 2, `from=${c.from} parts=${JSON.stringify(c.parts)}`);
  await dictate("Alpha one, beta two. Gamma three.");
  await ev(`window.__t3pad.jump("Otters are semi-aquatic", 3)`); // "to crack shellfish:"
  await press("square");
  await sleep(300);
  await dictate("Delta four; epsilon five.");
  let p = await parts();
  check("quote A, text, quote B, text in order", JSON.stringify(p) === JSON.stringify(["[chip]", "Alpha one, beta two. Gamma three.", "[chip]", "Delta four; epsilon five."]), JSON.stringify(p));

  // --- reply mode: L2 in, D-pad walks the composer
  await press("l2");
  s = await state();
  c = await composer();
  check("L2 enters reply mode (pill shows it, composer focused)", s.mode === "reply" && s.hud.includes("REPLY") && c.focused, `${s.mode} "${s.hud}" focused=${c.focused}`);
  await ev(`window.__t3pad.setReplyLevel("sentence"); 1`);
  const walk = ["Delta four; epsilon five.", "[chip]", "Gamma three.", "Alpha one, beta two.", "[chip]"];
  for (const w of walk) {
    await press("up");
    c = await composer();
    check(`reply up -> ${w}`, c.selected === w && (w !== "[chip]" || c.node === "composer-citation"), `${c.selected} (${c.node || "text"})`);
  }
  await press("down");
  await press("left");
  c = await composer();
  check("reply zoom in to clause (left)", c.selected === "Alpha one,", c.selected);
  await press("down");
  check("reply clause step", (await composer()).selected === "beta two.", (await composer()).selected);
  await press("right");
  await press("right");
  c = await composer();
  check("reply zoom out to paragraph (text between chips)", c.selected === "Alpha one, beta two. Gamma three.", c.selected);
  await press("right");
  c = await composer();
  check("reply zoom out to whole reply", c.selected.startsWith("[chip]") && c.selected.includes("epsilon five."), c.selected);
  await press("left");
  await press("left");
  s = await state();
  check("reply level back to sentence", s.replyLevel === "sentence" && s.level === "clause", `${s.replyLevel} / chat ${s.level}`);

  // Square deletes, Triangle undoes
  await press("down"); // from the whole-reply selection's start: first sentence after the chip... walk to Gamma
  for (let i = 0; i < 6 && (await composer()).selected !== "Gamma three."; i++) await press("down");
  await press("square");
  await sleep(450);
  c = await composer();
  check("Square deletes the selected sentence", !c.text.includes("Gamma three.") && c.text.includes("beta two.") && c.empty, JSON.stringify(c.text));
  await sleep(400);
  await press("triangle");
  c = await composer();
  check("Triangle undoes the delete", c.text.includes("Gamma three."), JSON.stringify(c.text));
  await sleep(700);
  // chip as a whole
  for (let i = 0; i < 6 && (await composer()).node !== "composer-citation"; i++) await press("down");
  await press("square");
  await sleep(450);
  p = await parts();
  check("Square deletes a selected chip as a whole", p.filter((x) => x === "[chip]").length === 1, JSON.stringify(p));
  await sleep(400);
  await press("triangle");
  p = await parts();
  check("Triangle brings the chip back", p.filter((x) => x === "[chip]").length === 2, JSON.stringify(p));
  await sleep(700);

  // R2 over a selection: the paste replaces it
  for (let i = 0; i < 8 && (await composer()).selected !== "Alpha one, beta two."; i++) await press("up");
  await ev(`window.__fakePad.buttons[${B.r2}] = {pressed:true,touched:true,value:1}; 1`);
  await sleep(250);
  c = await composer();
  check("R2 in reply mode keeps the selection", c.selected === "Alpha one, beta two.", c.selected);
  await ev(`window.__fakePad.buttons[${B.r2}] = {pressed:false,touched:false,value:0}; 1`);
  await sleep(150);
  await paste("Replaced by dictation.");
  c = await composer();
  check("dictation replaces the selection", c.text.includes("Replaced by dictation.") && !c.text.includes("Alpha one"), JSON.stringify(c.text));
  await press("triangle");
  c = await composer();
  check("Triangle undoes the dictated insert", c.text.includes("Alpha one, beta two.") && !c.text.includes("Replaced"), JSON.stringify(c.text));
  await sleep(700);

  // Circle: selection -> caret at its end; caret -> chat mode
  await press("down");
  c = await composer();
  const end = c.to;
  await press("circle");
  c = await composer();
  check("Circle collapses the selection to a caret at its end", c.empty && c.from === end, `${c.from} vs ${end}`);
  // --- touchpad caret (fake touch deltas, native-reader path)
  let before = (await composer()).from;
  await swipe(line(-0.6, 0, -0.3, 0, 15)); // slow slide right
  c = await composer();
  const slow = c.from - before;
  check("touch: slow slide right moves the caret a few characters", c.empty && slow >= 2 && slow <= 12, `+${slow}`);
  before = c.from;
  await swipe(line(0.4, 0, -0.4, 0, 6)); // fast slide left
  c = await composer();
  const fast = before - c.from;
  check("touch: fast slide left moves further (acceleration)", c.empty && fast > slow * 2, `-${fast}`);
  s = await state();
  check("still in reply mode after touch", s.mode === "reply", s.mode);

  // --- pill and menu, reply mode; the menu must not move the caret
  await sleep(1600);
  s = await state();
  check("idle pill stays up and shows REPLY", s.hudVisible && s.hud.includes("REPLY"), s.hud);
  c = await composer();
  await down("create"); await sleep(650); await up("create"); await sleep(200);
  s = await state();
  let c2 = await composer();
  check("menu in reply mode shows the reply map", !!s.menu && s.menu.includes("REPLY") && s.menu.includes("delete the selection") && !s.menu.includes("quote the selection") && s.menu.includes(MNEMONIC), (s.menu || "").replace(/\s+/g, " ").slice(0, 80));
  check("menu keeps the caret and the editor focus", c2.from === c.from && c2.empty && c2.focused, `${c.from} -> ${c2.from} focused=${c2.focused}`);
  await shot("08-menu-reply");
  await press("create");
  check("Create tap closes the menu in reply mode", (await state()).menu === null && (await state()).mode === "reply");

  // --- touchpad click in reply mode: word at the caret, then sentence, then paragraph
  const caretIn = (word, off = 1) => ev(`(() => { const e = document.querySelector('[data-testid="composer-editor"]').editor; let at = null; e.state.doc.descendants((n, pos) => { if (at === null && n.isText && n.text.includes(${JSON.stringify(word)})) at = pos + n.text.indexOf(${JSON.stringify(word)}) + ${off}; }); e.commands.setTextSelection(at); return at; })()`);
  await caretIn("beta", 2);
  await press("touchpad");
  c2 = await composer();
  check("reply: click selects the word at the caret", c2.selected === "beta", c2.selected);
  await press("touchpad");
  c2 = await composer();
  check("reply: second click grows it to the sentence", c2.selected === "Alpha one, beta two." && (await state()).replyLevel === "sentence", c2.selected);
  await press("touchpad");
  c2 = await composer();
  check("reply: third click grows it to the paragraph", c2.selected === "Alpha one, beta two. Gamma three." && (await state()).replyLevel === "paragraph", c2.selected);
  await sleep(600);
  await caretIn("beta", 2);
  await press("touchpad");
  await press("right");
  c2 = await composer();
  check("reply: D-pad right from a clicked word grows it to its clause", c2.selected === "beta two.", c2.selected);
  await press("right");
  check("reply: then to the sentence", (await composer()).selected === "Alpha one, beta two.", (await composer()).selected);
  await sleep(600);
  await caretIn("Gamma", 0);
  await press("touchpad");
  check("reply: click with the caret at a word start selects that word", (await composer()).selected === "Gamma", (await composer()).selected);
  await press("square");
  await sleep(450);
  c2 = await composer();
  check("reply: Square deletes the clicked word", !c2.text.includes("Gamma") && c2.text.includes("three."), JSON.stringify(c2.text));
  await sleep(400);
  await press("triangle");
  check("reply: Triangle brings it back", (await composer()).text.includes("Gamma three."), JSON.stringify((await composer()).text));
  await sleep(700);

  // A click lands with a finger on the pad that may wiggle: the word is taken where the finger landed.
  await caretIn("epsilon", 3);
  await sleep(600);
  before = (await composer()).from;
  for (const [x, y] of line(0, 0, 0.15, 0, 6)) { await ev(`window.__t3pad.touchNative({ op: "touch", down: true, x: ${x}, y: ${y} }); 1`); await sleep(16); }
  const wiggled = (await composer()).from;
  await ev(`window.__fakePad.buttons[${B.touchpad}] = {pressed:true,touched:true,value:1}; 1`);
  await sleep(60);
  for (const [x, y] of line(0.15, 0, 0.45, 0, 8)) { await ev(`window.__t3pad.touchNative({ op: "touch", down: true, x: ${x}, y: ${y} }); 1`); await sleep(16); }
  await ev(`window.__fakePad.buttons[${B.touchpad}] = {pressed:false,touched:false,value:0}; 1`);
  await sleep(50);
  await ev(`window.__t3pad.touchNative({ op: "touch", down: false }); 1`);
  await sleep(300);
  c2 = await composer();
  check("click with a wiggling finger selects the word where the finger landed", c2.selected === "epsilon", `landed ${before}, wiggle ${wiggled}, selected "${c2.selected}"`);
  await press("circle");
  c2 = await composer();
  check("Circle makes the clicked word a caret, stays in reply mode", c2.empty && (await state()).mode === "reply", `${(await state()).mode} ${c2.from}`);
  await press("circle");
  s = await state();
  check("Circle on a caret goes back to chat mode", s.mode === "chat" && s.hud.includes("CHAT"), `${s.mode} "${s.hud}"`);
  before = (await composer()).from;
  await swipe(line(-0.6, 0, 0.4, 0, 10));
  check("touch does nothing in chat mode", (await composer()).from === before);

  // vertical: several lines
  await press("l2");
  await ev(`(() => { const e = document.querySelector('[data-testid="composer-editor"]').editor; e.chain().focus("end").insertContent([1,2,3,4,5,6,7,8,9,10,11,12].map(i => ({ type: "paragraph", content: [{ type: "text", text: "Line " + i + " of filler." }] }))).run(); return 1; })()`);
  await sleep(750);
  const lineOf = async () => { const c2 = await composer(); return ev(`(() => { const e = document.querySelector('[data-testid="composer-editor"]').editor; return e.state.doc.resolve(${c2.from}).parent.textContent; })()`); };
  const l0 = await lineOf();
  const lt = (await state()).settings.lineTravel;
  await swipe(line(0, 0.6, 0, -0.6, 12)); // slide up 1.2 units: floor(1.2 / lineTravel) lines
  const l1 = await lineOf();
  const expectLine = `Line ${12 - Math.floor(1.2 / lt)} of filler.`;
  check("touch: vertical slide moves the caret up by lines (travel per line from the settings)", l0 === "Line 12 of filler." && l1 === expectLine, `${l0} -> ${l1}, expected ${expectLine} at ${lt}/line`);
  // Axis lock: a mostly sideways slide that drifts more than a line's travel vertically stays on its line.
  await caretIn("Line 10 of", 0);
  before = (await composer()).from;
  await swipe(line(-0.4, -0.3, 0, 0.3, 20)); // dx 0.4, dy 0.6 (> one line of travel)
  c2 = await composer();
  check("touch: axis lock keeps a sloppy sideways slide on its line", (await lineOf()) === "Line 10 of filler." && c2.from > before, `${await lineOf()} +${c2.from - before}`);
  await swipe(line(0.2, -0.5, 0.25, 0.5, 14)); // mostly vertical with a little sideways drift: lines only
  check("touch: a vertical slide with sideways drift moves lines only", (await lineOf()) === `Line ${10 + Math.floor(1 / lt)} of filler.` && (await composer()).from !== c2.from, await lineOf());

  // --- sticks: right scrolls the overflowing composer, left the transcript
  c = await composer();
  const [ct0, csh, cch] = c.scroll;
  await ev(`document.querySelector('[data-testid="composer-editor"]').scrollTop = 0; 1`);
  await ev(`window.__fakePad.axes[3] = 1; 1`);
  await sleep(300);
  await ev(`window.__fakePad.axes[3] = 0; 1`);
  c = await composer();
  check("right stick scrolls the composer when it overflows", csh > cch && c.scroll[0] > 0, `scrollTop ${ct0} -> ${c.scroll[0]} (h ${csh}/${cch})`);
  // drop the filler again
  await ev(`(() => { const e = document.querySelector('[data-testid="composer-editor"]').editor; let from = null; e.state.doc.descendants((n, pos) => { if (from === null && n.isTextblock && n.textContent === "Line 1 of filler.") from = pos; }); if (from !== null) e.chain().deleteRange({ from, to: e.state.doc.content.size }).run(); return 1; })()`);
  await sleep(300);
  // final edit that must survive into the sent message: delete "Gamma three."
  await ev(`window.__t3pad.setReplyLevel("sentence"); document.querySelector('[data-testid="composer-editor"]').editor.commands.setTextSelection(1); 1`);
  for (let i = 0; i < 8 && (await composer()).selected !== "Gamma three."; i++) await press("down");
  await press("square");
  await sleep(400);
  p = await parts();
  check("composer before send", JSON.stringify(p) === JSON.stringify(["[chip]", "Alpha one, beta two.", "[chip]", "Delta four; epsilon five."]), JSON.stringify(p));
  await press("circle"); // caret -> chat mode
  check("back in chat mode", (await state()).mode === "chat");
  if (!DICTATE) await ev(`window.t3padNative = window.__realNative; 1`);

  // --- Options sends (scratch thread only)
  if (SEND) {
    check("still on scratch thread before send", (await ev("location.hash")) === route);
    if ((await ev("location.hash")) === route) {
      const lastUser = `(() => { document.querySelector(".messages-timeline-scroll").scrollTop = 1e9; const m = [...document.querySelectorAll('[data-message-role=user]')]; const r = m[m.length - 1]; return r ? (r.closest("[data-message-id]")?.dataset.messageId || r.innerText) : null; })()`;
      const before = await ev(lastUser);
      await press("l2"); // send from reply mode: Options leaves the mode and submits
      await press("options");
      check("Options from reply mode returns to chat mode", (await state()).mode === "chat");
      let after = before;
      for (let i = 0; i < 20 && after === before; i++) {
        await sleep(300);
        after = await ev(lastUser);
      }
      const left = await ev(`document.querySelector('[data-testid="composer-editor"]').innerText.trim()`);
      check("Options sends the message (a new user message appears)", after !== before && left === "", `last user msg ${String(before).slice(-12)} -> ${String(after).slice(-12)}, composer "${left.slice(0, 30)}"`);
      const sentText = await ev(`(() => { const m = [...document.querySelectorAll('[data-message-role=user]')]; return m[m.length - 1]?.innerText || ""; })()`);
      check("sent message carries the reply-mode edits", sentText.includes("Alpha one, beta two.") && sentText.includes("epsilon five.") && !sentText.includes("Gamma three."), JSON.stringify(sentText.replace(/\s+/g, " ").slice(0, 160)));
      await shot("04-sent");
    }
  } else {
    await ev(`(() => { const ed = document.querySelector('[data-testid="composer-editor"]'); ed.focus(); document.execCommand("selectAll"); document.execCommand("delete"); return 1; })()`);
  }

  // --- link -> preview pane, Circle closes it
  await ev(`window.__t3pad.setLevel("sentence"); 1`);
  await ev(`window.__t3pad.jump("Otters are semi-aquatic", 3)`);
  await press("down");
  s = await state();
  check("link is its own stop", s.unitKind === "link" && s.selection === "T3 Code on GitHub", `${s.unitKind}: ${s.selection}`);
  const targetsBefore = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).length;
  await press("cross");
  await sleep(2500);
  const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const preview = targets.find((t) => t.url.includes("github.com/pingdotgg/t3code"));
  check("Cross opens the link inside T3 (preview target)", !!preview, `${targetsBefore} -> ${targets.length} targets`);
  await shot("05-link-in-preview");
  await press("circle");
  await sleep(1200);
  const stillOpen = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).some((t) => t.url.includes("github.com/pingdotgg/t3code"));
  const panelVisible = await ev(`[...document.querySelectorAll('webview')].some(w => { const r = w.getBoundingClientRect(); return r.width > 50 && r.height > 50 && r.left < innerWidth && r.right > 0 && r.top < innerHeight && r.bottom > 0; })`);
  check("Circle closes the preview", !stillOpen || !panelVisible, `target alive=${stillOpen}, webview visible=${panelVisible}`);
  await shot("06-after-circle");

  // --- file preview in the right panel: Circle closes it (T3's own toggle) and never leaves the thread
  const panelPressed = `document.querySelector('button[aria-label="Toggle right panel"]')?.getAttribute("aria-pressed")`;
  await ev(`window.__t3pad.setLevel("sentence"); 1`);
  await ev(`window.__t3pad.jump("File fixture: see", 0)`);
  for (let i = 0; i < 4 && (await state()).unitKind !== "link"; i++) await press("down");
  s = await state();
  check("file link is a stop", s.unitKind === "link" && s.selection.includes("t3pad-notes.md"), `${s.unitKind}: ${s.selection}`);
  await press("cross");
  await sleep(1500);
  const fileTab = await ev(`[...document.querySelectorAll("[data-right-panel-tabbar] [data-active-tab=true]")].map(t => t.innerText.trim()).join("|")`);
  check("Cross opens the file preview in the right panel", (await ev(panelPressed)) === "true" && fileTab.includes("t3pad-notes.md"), `pressed=${await ev(panelPressed)} active tab "${fileTab}"`);
  await shot("11-file-preview");
  await press("circle");
  await sleep(500);
  check("Circle closes the right panel (file preview)", (await ev(panelPressed)) !== "true", `pressed=${await ev(panelPressed)}`);
  check("Circle stayed in the thread", (await ev("location.hash")) === route);
  await press("circle"); // clears the selection
  await press("circle"); // nothing left to close: must not navigate
  await sleep(500);
  s = await state();
  check("Circle with nothing open does nothing (no thread change)", (await ev("location.hash")) === route && s.hud.includes("Nothing to close"), s.hud);
  // Close the fixture's file tab again so the tabs do not pile up in the user's panel.
  await ev(`(() => { const b = document.querySelector('[data-right-panel-tabbar] button[aria-label="Close t3pad-notes.md"]'); b?.click(); return !!b; })()`);

  // --- Circle clears a selection
  await ev(`window.__t3pad.jump("Otters are semi-aquatic", 0)`);
  await press("circle");
  check("Circle clears the selection", (await state()).selection === "");

  // --- left stick scrolls the transcript (the right one only the composer)
  const top0 = await ev(`document.querySelector(".messages-timeline-scroll").scrollTop`);
  await ev(`window.__fakePad.axes[1] = -1; 1`);
  await sleep(400);
  await ev(`window.__fakePad.axes[1] = 0; 1`);
  const top1 = await ev(`document.querySelector(".messages-timeline-scroll").scrollTop`);
  check("left stick scrolls the transcript", top1 !== top0, `${Math.round(top0)} -> ${Math.round(top1)}`);
  await ev(`window.__fakePad.axes[3] = -1; 1`);
  await sleep(300);
  await ev(`window.__fakePad.axes[3] = 0; 1`);
  const top2 = await ev(`document.querySelector(".messages-timeline-scroll").scrollTop`);
  check("right stick leaves the transcript alone", top2 === top1, `${Math.round(top1)} -> ${Math.round(top2)}`);

  // --- Triangle: jump to latest
  await ev(`document.querySelector(".messages-timeline-scroll").scrollTop = 0; 1`);
  await press("triangle");
  await sleep(300);
  s = await state();
  const lastId = await ev(`(() => { const r = [...document.querySelectorAll("[data-timeline-row-kind=message][data-message-id]")]; return r[r.length - 1]?.dataset.messageId; })()`);
  check("Triangle jumps to the latest message", s.msgId === lastId, s.msgId);

  // --- L1 / R1: thread switching
  await press("r1");
  await sleep(1500);
  const h1 = await ev("location.hash");
  check("R1 switches thread", h1 !== route, h1.slice(0, 60));
  await press("l1");
  await sleep(1500);
  const h2 = await ev("location.hash");
  check("L1 switches back", h2 === route, h2.slice(0, 60));
} catch (e) {
  check("no exception", false, e.stack);
} finally {
  await ev(`window.__t3pad.tutorialClose(); 1`).catch(() => {}); // a tutorial left running would mark itself seen later
  if (tutWasSeen === false) await ev(`window.__t3pad.tutorialSeen(false); 1`).catch(() => {});
  await ev(`delete navigator.getGamepads; delete window.__fakePad; if (window.__realNative) window.t3padNative = window.__realNative; 1`).catch(() => {});
  if (savedSettings !== undefined) await ev(`(() => { const raw = ${JSON.stringify(savedSettings)}; if (raw === null) localStorage.removeItem("t3pad.settings.v1"); else localStorage.setItem("t3pad.settings.v1", raw);
    window.__t3pad.loadSettings(raw ? JSON.parse(raw) : {}); return 1; })()`).catch(() => {});
  if (origHash && origHash !== route) await ev(`location.hash = ${JSON.stringify(origHash)}; 1`).catch(() => {}); // give the user their thread back
  if (origPanel) await sleep(1200).then(() => ev(`(() => { const t = document.querySelector('button[aria-label="Toggle right panel"]'); if (t && t.getAttribute("aria-pressed") !== ${JSON.stringify(origPanel)}) t.click(); return 1; })()`)).catch(() => {}); // and his right panel
  cdp.close();
}
writeFileSync(`${SHOTS}/results.txt`, results.join("\n") + "\n");
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
