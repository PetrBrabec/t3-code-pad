// t3pad-touch: reads the DualSense touchpad with GameController and prints the primary finger's
// position as `T3TOUCH {json}` lines on stdout, about 60 per second while it moves.
//
// A separate binary on purpose: GameController needs no Accessibility, and keeping it out of
// T3Pad.app means that bundle (and its Accessibility grant) never has to be rebuilt for touch.
// Spawned by the sidecar; exits when the sidecar goes away.
//
// Output: {"op":"touch","x":-1..1,"y":-1..1,"down":true}  (y grows downwards)
//         {"op":"touch","down":false}                       (finger lifted)
//         {"op":"pad","name":"..."} / {"op":"pad","name":null}
import Foundation
import GameController

setvbuf(stdout, nil, _IOLBF, 0)

func log(_ s: String) {
    FileHandle.standardError.write("\(ISO8601DateFormatter().string(from: Date())) [touch] \(s)\n".data(using: .utf8)!)
}

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    print("T3TOUCH \(String(decoding: data, as: UTF8.self))")
}

// T3 is the frontmost app, not this process, so background events are what we need.
GCController.shouldMonitorBackgroundEvents = true

var latest: (x: Float, y: Float)? = nil
var sentDown = false
var dirty = false

func attach(_ c: GCController) {
    guard let ds = c.extendedGamepad as? GCDualSenseGamepad else {
        log("controller \(c.vendorName ?? "?") is not a DualSense; ignoring")
        return
    }
    log("attached \(c.vendorName ?? "DualSense")")
    emit(["op": "pad", "name": c.vendorName ?? "DualSense"])
    ds.touchpadPrimary.valueChangedHandler = { _, x, y in
        // GameController reports (0, 0) when no finger is on the pad.
        latest = (x == 0 && y == 0) ? nil : (x, -y)
        dirty = true
    }
}

NotificationCenter.default.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { n in
    if let c = n.object as? GCController { attach(c) }
}
NotificationCenter.default.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { _ in
    log("controller disconnected")
    emit(["op": "pad", "name": NSNull()])
}
GCController.controllers().forEach(attach)

let parent = getppid()
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now(), repeating: .milliseconds(16))
timer.setEventHandler {
    if getppid() != parent { exit(0) } // sidecar gone
    guard dirty else { return }
    dirty = false
    if let p = latest {
        emit(["op": "touch", "x": Double(p.x), "y": Double(p.y), "down": true])
        sentDown = true
    } else if sentDown {
        emit(["op": "touch", "down": false])
        sentDown = false
    }
}
timer.resume()
log("watching for a DualSense")
RunLoop.main.run()
