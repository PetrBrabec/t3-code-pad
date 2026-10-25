#!/usr/bin/env node
// t3-pad sidecar. Runs under the native helper (helper/main.swift), which runs as a LaunchAgent.
//
// 1. Keeps T3 Code running with --remote-debugging-port (relaunches it if it was started from the
//    Dock/Spotlight or by an auto-update without the flag).
// 2. Injects src/t3pad.js into the T3 renderer over CDP, now and on every reload.
// 3. Relays calls from the page (window.t3padNative) to the helper as `T3PAD {json}` lines on stdout.
//
// stdout is the command channel to the helper; logs go to stderr.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { CdpSession, DEFAULT_PORT, findAppTarget } from "./cdp.mjs";

const run = promisify(execFile);
const APP = process.env.T3PAD_APP_NAME || "T3 Code (Beta)";
const PORT = DEFAULT_PORT;
const BUNDLE = new URL("../src/t3pad.js", import.meta.url);
const NO_RELAUNCH = process.env.T3PAD_NO_RELAUNCH === "1";
const MISSING_PORT_GRACE_MS = 6000;
// Native touchpad reader (touch/main.swift), built by scripts/install.sh outside the synced tree.
const TOUCH_BIN = process.env.T3PAD_TOUCH_BIN || `${homedir()}/Library/Application Support/t3-pad-bin/t3pad-touch`;
// Chromium's own DualSense touch support (Gamepad.touchEvents) is behind these two switches. When it
// delivers, the page prefers it over the native reader.
const CHROMIUM_FLAGS = ["--enable-blink-features=GamepadMultitouch", "--enable-features=EnableGamepadMultitouch"];

const log = (...a) => console.error(new Date().toISOString(), "[sidecar]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (payload) => process.stdout.write(`T3PAD ${JSON.stringify(payload)}\n`);

async function cdpUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

const APP_EXEC = `${APP}.app/Contents/MacOS/${APP}`;

/** All processes running T3's main executable: the Electron main process and its backend child. */
async function t3Processes() {
  const { stdout } = await run("/bin/ps", ["-A", "-o", "pid=,command="]);
  return stdout
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
    .filter((m) => m && m[2].includes(APP_EXEC))
    .map((m) => ({ pid: Number(m[1]), command: m[2], backend: m[2].includes(" --require ") }));
}

async function mainProcess() {
  const main = (await t3Processes()).find((p) => !p.backend);
  return main ? { ...main, hasPort: main.command.includes(`--remote-debugging-port=${PORT}`) } : null;
}

/**
 * Launch T3 with the debug port. `foreground` brings it to the front: used when relaunching a T3 that
 * the user just opened from the Dock, since with only a controller in hand he cannot click it back to the
 * front, and VoiceInk pastes into the frontmost app.
 */
export async function launchWithPort({ foreground = false } = {}) {
  log(`launching ${APP} with --remote-debugging-port=${PORT}${foreground ? " (foreground)" : ""}`);
  await run("/usr/bin/open", [...(foreground ? [] : ["-g"]), "-a", APP, "--args", `--remote-debugging-port=${PORT}`, ...CHROMIUM_FLAGS]);
}

async function t3IsFrontmost() {
  try {
    const { stdout: asn } = await run("/usr/bin/lsappinfo", ["front"]);
    const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "name", asn.trim()]);
    return stdout.includes(`"${APP}"`);
  } catch {
    return false;
  }
}

async function waitGone(ms) {
  for (let t = 0; t < ms; t += 250) {
    if (!(await t3Processes()).length) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Quit T3 and wait until its backend child is gone too: a new instance refuses to start while an
 * old backend still owns ~/.t3/userdata (ServerAlreadyRunningError), and then exits.
 */
async function quitT3() {
  log(`quitting ${APP}`);
  if (await mainProcess()) {
    await run("/usr/bin/osascript", ["-e", `tell application "${APP}" to quit`]).catch((e) => log("quit failed:", e.message));
  }
  if (await waitGone(30000)) return true;
  for (const sig of ["TERM", "KILL"]) {
    const left = await t3Processes();
    log(`still running (${left.map((p) => p.pid).join(", ")}); SIG${sig}`);
    for (const p of left) await run("/bin/kill", [`-${sig}`, String(p.pid)]).catch(() => {});
    if (await waitGone(10000)) return true;
  }
  return false;
}

export async function restartWithPort() {
  const foreground = await t3IsFrontmost();
  if (!(await quitT3())) throw new Error("T3 did not quit");
  await launchWithPort({ foreground });
}

/** Make sure T3 is up with CDP. Never starts T3 that is not running: the user may have quit it. */
async function ensurePort() {
  if (await cdpUp()) return true;
  let main = await mainProcess();
  if (!main) return false;
  if (!main.hasPort) {
    // Started from the Dock/Spotlight or relaunched by an auto-update. Let a fresh launch settle.
    await sleep(MISSING_PORT_GRACE_MS);
    main = await mainProcess();
    if (!main) return false;
  }
  if (!main.hasPort) {
    if (NO_RELAUNCH) {
      log("T3 is running without the debug port; T3PAD_NO_RELAUNCH=1 so leaving it");
      return false;
    }
    log("T3 is running without the debug port; relaunching it with the port");
    await restartWithPort();
  }
  for (let i = 0; i < 60; i++) {
    if (await cdpUp()) return true;
    await sleep(250);
  }
  return false;
}

/** The live CDP session, for forwarding touch samples into the page. */
let liveCdp = null;

/** Run the touch reader for the sidecar's lifetime and forward its samples into the page. */
function startTouchReader() {
  if (!existsSync(TOUCH_BIN)) {
    log(`no touch reader at ${TOUCH_BIN}; touchpad caret off`);
    return;
  }
  const child = spawn(TOUCH_BIN, [], { stdio: ["ignore", "pipe", "inherit"] });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("T3TOUCH ")) return;
    const json = line.slice(8);
    if (!liveCdp || liveCdp.closed) return;
    // Fire and forget: a lost sample only costs a few pixels of caret travel.
    liveCdp
      .send("Runtime.evaluate", { expression: `window.__t3pad && window.__t3pad.touchNative(${json})` })
      .catch(() => {});
  });
  child.on("exit", (code) => {
    log(`touch reader exited (${code}); restarting in 5 s`);
    setTimeout(startTouchReader, 5000);
  });
}

async function attach() {
  const target = await findAppTarget(PORT);
  if (!target) return null;
  const cdp = await new CdpSession(target.webSocketDebuggerUrl).open();
  const source = readFileSync(BUNDLE, "utf8");
  cdp.on("Runtime.bindingCalled", ({ name, payload }) => {
    if (name !== "t3padNative") return;
    try {
      send(JSON.parse(payload));
    } catch {
      log("bad payload", payload);
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.addBinding", { name: "t3padNative" });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
  await cdp.evaluate(source);
  const state = await cdp.evaluate("window.__t3pad && window.__t3pad.version");
  log(`injected t3pad ${state} into ${target.url}`);
  return cdp;
}

async function main() {
  log(`starting (app "${APP}", port ${PORT})`);
  startTouchReader();
  let warned = false;
  for (;;) {
    try {
      if (!(await ensurePort())) {
        if (!warned) log("T3 not reachable; waiting");
        warned = true;
        await sleep(2000);
        continue;
      }
      warned = false;
      const cdp = await attach();
      if (!cdp) {
        await sleep(1000);
        continue;
      }
      liveCdp = cdp;
      await new Promise((resolve) => cdp.on("close", resolve));
      liveCdp = null;
      send({ op: "ptt", down: false }); // never leave dictation held across a disconnect
      log("CDP connection closed");
    } catch (e) {
      log("error:", e.message);
    }
    await sleep(1000);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv[2] === "--launch") await launchWithPort();
  else if (process.argv[2] === "--restart") await restartWithPort();
  else if (process.argv[2] === "--quit") process.exit((await quitT3()) ? 0 : 1);
  else main();
}
