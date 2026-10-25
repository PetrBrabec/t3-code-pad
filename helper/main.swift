// t3-pad helper: the one native process. Runs as a LaunchAgent from T3Pad.app so that macOS
// attributes the Accessibility grant to this bundle (not to node).
//
// - Spawns the node sidecar and restarts it if it exits.
// - Reads `T3PAD {json}` command lines from the sidecar's stdout.
// - {"op":"ptt","down":true|false}: posts VoiceInk's recording shortcut (Fn+Space by default)
//   key down / key up, so holding R2 is push-to-talk (VoiceInk "hybrid" mode: hold >= 0.5 s).
//
// Usage: t3pad-helper <node> <sidecar.mjs>      (normal, from the LaunchAgent)
//        t3pad-helper --check                    (print Accessibility status, prompt if missing)
//        t3pad-helper --ptt <seconds>            (hold the dictation key for N seconds, for testing)
import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
setvbuf(stderr, nil, _IOLBF, 0)

func log(_ s: String) {
    FileHandle.standardError.write("\(ISO8601DateFormatter().string(from: Date())) [helper] \(s)\n".data(using: .utf8)!)
}

// VoiceInk's primary recording shortcut. Override with T3PAD_PTT_KEYCODE / T3PAD_PTT_FLAGS
// (CGEventFlags raw value) if you change it in VoiceInk.
let env = ProcessInfo.processInfo.environment
let pttKeyCode = CGKeyCode(env["T3PAD_PTT_KEYCODE"].flatMap { UInt16($0) } ?? 49) // Space
let pttFlags = CGEventFlags(rawValue: env["T3PAD_PTT_FLAGS"].flatMap { UInt64($0) } ?? CGEventFlags.maskSecondaryFn.rawValue)
let voiceInkBundleId = "com.prakashjoshipax.VoiceInk"

func accessibilityTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

var pttHeld = false

func postPtt(down: Bool) {
    if down == pttHeld { return }
    if down && NSRunningApplication.runningApplications(withBundleIdentifier: voiceInkBundleId).isEmpty {
        log("VoiceInk is not running; ignoring dictation")
        return
    }
    if !accessibilityTrusted(prompt: false) {
        log("no Accessibility permission; cannot send the dictation key (System Settings > Privacy & Security > Accessibility > T3Pad)")
        return
    }
    let src = CGEventSource(stateID: .privateState)
    guard let ev = CGEvent(keyboardEventSource: src, virtualKey: pttKeyCode, keyDown: down) else { return }
    ev.flags = pttFlags
    ev.post(tap: .cghidEventTap)
    pttHeld = down
    log("dictation key \(down ? "down" : "up")")
}

func handle(line: String) {
    guard line.hasPrefix("T3PAD ") else {
        if !line.isEmpty { log("sidecar stdout: \(line)") }
        return
    }
    let json = line.dropFirst(6)
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let op = obj["op"] as? String else {
        log("bad command: \(line)")
        return
    }
    switch op {
    case "ptt":
        let down = (obj["down"] as? Bool) ?? false
        DispatchQueue.main.async { postPtt(down: down) }
    default:
        log("unknown op \(op)")
    }
}

// MARK: - CLI modes

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "--check" {
    let ok = accessibilityTrusted(prompt: true)
    print(ok ? "accessibility: granted" : "accessibility: NOT granted (prompt shown; enable T3Pad in System Settings > Privacy & Security > Accessibility)")
    exit(ok ? 0 : 1)
}
if args.count >= 3 && args[1] == "--ptt" {
    let secs = Double(args[2]) ?? 2
    postPtt(down: true)
    Thread.sleep(forTimeInterval: secs)
    postPtt(down: false)
    exit(0)
}
guard args.count >= 3 else {
    log("usage: t3pad-helper <node> <sidecar.mjs> | --check | --ptt <seconds>")
    exit(2)
}

// MARK: - Supervise the sidecar

let nodePath = args[1]
let sidecarPath = args[2]
var child: Process?

if !accessibilityTrusted(prompt: true) {
    log("Accessibility not granted yet; dictation (R2) stays off until T3Pad is enabled in System Settings > Privacy & Security > Accessibility")
}

func startSidecar() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [sidecarPath]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.standardError
    var buffer = Data()
    out.fileHandleForReading.readabilityHandler = { h in
        let chunk = h.availableData
        if chunk.isEmpty { return }
        buffer.append(chunk)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            handle(line: String(decoding: lineData, as: UTF8.self))
        }
    }
    p.terminationHandler = { proc in
        log("sidecar exited (\(proc.terminationStatus)); restarting in 2 s")
        DispatchQueue.main.async { postPtt(down: false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { startSidecar() }
    }
    do {
        try p.run()
        child = p
        log("sidecar started (pid \(p.processIdentifier))")
    } catch {
        log("failed to start sidecar: \(error)")
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { startSidecar() }
    }
}

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let s = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    s.setEventHandler {
        postPtt(down: false)
        child?.terminationHandler = nil
        child?.terminate()
        exit(0)
    }
    s.resume()
    signalSources.append(s)
}

startSidecar()
RunLoop.main.run()
