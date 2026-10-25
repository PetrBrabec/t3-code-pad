# Development

## Layout

- `src/t3pad.js`: the injected module (one file, no build step). `MAP` is the button table, `SETTINGS`
  the tunables, `SEL` the T3 selectors. Test hooks on `window.__t3pad`.
- `sidecar/`: node CDP client and the sidecar process (injects the module, relays to the helper).
- `helper/`: Swift app bundle `T3Pad.app` (Accessibility, posts the dictation shortcut).
- `touch/`: Swift DualSense touchpad reader.
- `scripts/`: `install.sh` (on the Mac running T3), `deploy-air.sh` / `dev-air.sh` (from another Mac,
  configured by `.env.local`), `cdp-eval.mjs` (evaluate JS in T3), `grep-bundle.mjs` (grep T3's loaded
  JS, handy when a selector changes), `inject-once.mjs` (inject the current module without the sidecar).

## Tests (optional)

The tests drive the live T3 app through a fake gamepad (`navigator.getGamepads` replaced in the page)
and assert on the real DOM. Run them on the Mac that runs T3, with T3 visible: Chromium throttles a
hidden page's timers to about once a minute, so the tests refuse to run when T3 is hidden. They put
back what they change (open thread, settings, tutorial flag, panels).

```sh
node test/e2e.mjs '#/<environment id>/<scratch thread id>' [--send] [--dictate]
node test/modes.mjs '#/<environment id>/<scratch thread id>' '#/<environment id>/<permission thread id>' [--only=permission,preview,tutorial]
node test/shots.mjs '#/<environment id>/<scratch thread id>' [outDir]   # design screenshots of the pill and menu
```

The route is `location.hash` while the thread is open in T3. Screenshots go to `$T3PAD_SHOTS`
(default `/tmp/t3pad-e2e`). A lock directory `~/t3pad-air.lock` keeps two drivers from running at once
(created with `mkdir`, owner in `~/t3pad-air.lock/owner`, removed afterwards).

**Fixtures**, all threads in T3 (any project), on a cheap model with no tools:

- **Scratch thread**: its prompt asks for three paragraphs about otters with commas, colons and
  semicolons, a GitHub link, a code block and an image; the tests also add a message with three
  attached images (lightbox), a link to a small markdown file in the thread's folder (file preview) and
  a link to a Wikipedia article (web preview with images). The assertions expect that otter text.
- **Permission thread** (approval-required): the test asks the agent to `touch` a file and declines
  the approval with the pad, then answers an AskUserQuestion. Never choose "Always allow this session"
  there, or the thread stops asking.
- **Tutorial thread**: see README, Install step 5.

`--send` presses Options (sends into the scratch thread). `--dictate` lets R2 reach VoiceInk for real,
which records a moment of microphone audio and pastes whatever it hears. Without it, dictation is
simulated by a `paste` event on the editor (what VoiceInk's Cmd+V produces; no clipboard write), and
the touchpad by feeding samples to `__t3pad.touchNative` (the native reader's path).

Last full runs (T3 0.1.x, macOS 26): e2e 116/116 with `--send`, modes 54/54.
