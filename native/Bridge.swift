// SPDX-License-Identifier: MIT OR Apache-2.0
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Darwin

// Experimental window-targeted SPI, also used by QwenLM/qwen-code's macOS driver.
// Resolve at runtime and fail closed; never fall back to a global HID event.
@MainActor final class WindowEventAPI {
    typealias Post = @convention(c) (pid_t, CGEvent) -> Void
    typealias Location = @convention(c) (CGEvent, CGPoint) -> Void
    typealias Integer = @convention(c) (CGEvent, UInt32, Int64) -> Void
    static let shared = WindowEventAPI()
    let handle:UnsafeMutableRawPointer?
    let post:Post?, location:Location?, integer:Integer?
    var available:Bool { post != nil && location != nil && integer != nil }
    init() {
        handle=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_LAZY|RTLD_GLOBAL)
        let all=UnsafeMutableRawPointer(bitPattern:-2)
        post=dlsym(all,"SLEventPostToPid").map{unsafeBitCast($0,to:Post.self)}
        location=dlsym(all,"CGEventSetWindowLocation").map{unsafeBitCast($0,to:Location.self)}
        integer=dlsym(all,"SLEventSetIntegerValueField").map{unsafeBitCast($0,to:Integer.self)}
    }
}

struct Failure: Error, CustomStringConvertible { let description: String; init(_ s: String) { description = s } }
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) { print(s) }
}
func rect(_ r: CGRect) -> [String: Double] { ["x":r.origin.x,"y":r.origin.y,"width":r.width,"height":r.height] }
func number(_ p: [String:Any], _ k: String) throws -> Double {
    guard let n = p[k] as? Double, n.isFinite else { throw Failure("Missing numeric \(k)") }; return n
}

func pointer() -> CGPoint { CGEvent(source:nil)?.location ?? .zero }
@MainActor func interactionState() -> [String:Any] {
    let app=NSWorkspace.shared.frontmostApplication, pos=pointer()
    return ["frontmostPid":app?.processIdentifier ?? 0,"frontmostBundleId":app?.bundleIdentifier ?? "",
            "cursor":["x":pos.x,"y":pos.y]]
}
final class PointerPanel:NSPanel {
    override var canBecomeKey:Bool { false }
    override var canBecomeMain:Bool { false }
}
final class PointerView:NSView {
    override func draw(_ dirtyRect:NSRect) {
        let arrow=NSBezierPath();arrow.move(to:NSPoint(x:4,y:32));arrow.line(to:NSPoint(x:5,y:9))
        arrow.line(to:NSPoint(x:11,y:15));arrow.line(to:NSPoint(x:18,y:3));arrow.line(to:NSPoint(x:23,y:6))
        arrow.line(to:NSPoint(x:16,y:18));arrow.line(to:NSPoint(x:26,y:19));arrow.close()
        NSColor.systemTeal.setFill();arrow.fill();NSColor.white.setStroke();arrow.lineWidth=1.5;arrow.stroke()
    }
}
@MainActor final class AgentPointer {
    let panel=PointerPanel(contentRect:NSRect(x:0,y:0,width:32,height:36),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
    init(){panel.isOpaque=false;panel.backgroundColor = .clear;panel.hasShadow=true;panel.ignoresMouseEvents=true
        panel.hidesOnDeactivate=false;panel.level = .floating;panel.contentView=PointerView(frame:panel.contentView!.bounds)}
    func show(_ position:CGPoint,pid:pid_t){
        // Don't draw over a different app that covers the game. The marker never handles input.
        let windows=CGWindowListCopyWindowInfo(.optionOnScreenOnly,kCGNullWindowID) as? [[String:Any]] ?? []
        let top=windows.first { w in
            guard (w[kCGWindowLayer as String] as? Int)==0,let b=w[kCGWindowBounds as String] as? [String:Any],
                  let r=CGRect(dictionaryRepresentation:b as CFDictionary) else { return false };return r.contains(position)
        }
        guard (top?[kCGWindowOwnerPID as String] as? Int32)==pid else {panel.orderOut(nil);return}
        let screenTop=NSScreen.screens.first?.frame.maxY ?? 0
        panel.setFrameOrigin(NSPoint(x:position.x-4,y:screenTop-position.y-32));panel.orderFrontRegardless()
    }
    func hide(){panel.orderOut(nil)}
}

@main struct Bridge {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            if CommandLine.arguments.count == 2, CommandLine.arguments[1].hasPrefix("{") {
                do {
                    let data = CommandLine.arguments[1].data(using:.utf8)!
                    let p = try JSONSerialization.jsonObject(with:data) as! [String:Any]
                    emit(try await run(p))
                } catch { emit(["ok":false,"error":String(describing:error)]) }
                app.terminate(nil)
                return
            }
            let base = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(".nyatinorma/ipc")
            do {
                try FileManager.default.createDirectory(at:base,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
                while true {
                    let files = try FileManager.default.contentsOfDirectory(at:base,includingPropertiesForKeys:nil).filter{$0.lastPathComponent.hasSuffix(".request.json")}.sorted{$0.lastPathComponent < $1.lastPathComponent}
                    for file in files {
                        var response:[String:Any]
                        do {
                            let data = try Data(contentsOf:file)
                            let p = try JSONSerialization.jsonObject(with:data) as! [String:Any]
                            try FileManager.default.removeItem(at:file)
                            guard let expires = p["expiresAt"] as? Double, expires > Date().timeIntervalSince1970*1000 else { throw Failure("Expired request; no action taken") }
                            response = try await run(p)
                        } catch { response = ["ok":false,"error":String(describing:error)] }
                        let out=base.appendingPathComponent(file.lastPathComponent.replacingOccurrences(of:".request.json",with:".response.json"))
                        try JSONSerialization.data(withJSONObject:response,options:[.sortedKeys]).write(to:out,options:.atomic)
                    }
                    try await Task.sleep(for:.milliseconds(40))
                }
            } catch { emit(["ok":false,"error":String(describing:error)]);app.terminate(nil) }
        }
        app.run()
    }

    @MainActor static func run(_ p:[String:Any]) async throws -> [String:Any] {
        let action = p["action"] as? String ?? "doctor"
        let bundle = p["bundleId"] as? String ?? ""
        if action == "shutdown" {
            Task { @MainActor in try? await Task.sleep(for:.milliseconds(150));NSApplication.shared.terminate(nil) }
            return ["ok":true]
        }
        if action == "permissions" {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
            _ = CGRequestScreenCaptureAccess()
        }
        if action == "doctor" || action == "permissions" || action == "diagnostics" {
            return ["ok":true,"screenRecording":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted(),
                    "protocolVersion":4,"capabilities":["backgroundInput":WindowEventAPI.shared.available,"windowRoutedInput":WindowEventAPI.shared.available,"agentPointer":true,"visionOnlyCapture":true],"interaction":interactionState(),
                    "bridgePath":Bundle.main.bundleURL.path,"bridgePid":ProcessInfo.processInfo.processIdentifier,
                    "apps":NSRunningApplication.runningApplications(withBundleIdentifier:bundle).map { ["pid":$0.processIdentifier,"name":$0.localizedName ?? "","path":$0.bundleURL?.path ?? ""] }]
        }
        guard !bundle.isEmpty else { throw Failure("A target bundleId is required.") }
        guard CGPreflightScreenCaptureAccess() else { throw Failure("Screen Recording permission is required for the host application. Enable it in System Settings and restart the host.") }
        let content = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
        let windows = content.windows.filter { $0.owningApplication?.bundleIdentifier == bundle && $0.frame.width > 300 && $0.frame.height > 200 && $0.windowLayer == 0 }
        let selected: SCWindow?
        if let id = p["windowId"] as? UInt32 { selected = windows.first { $0.windowID == id } }
        else if windows.count == 1 { selected = windows[0] }
        else { throw Failure("Expected exactly one game window; found \(windows.count). Specify windowId.") }
        guard let window = selected else { throw Failure("Game window is not available") }
        let frame = window.frame
        let meta:[String:Any] = ["windowId":window.windowID,"frame":rect(frame),"title":window.title ?? "","pid":window.owningApplication?.processID ?? 0]
        if action == "window" { return ["ok":true,"window":meta] }
        if action == "capture" {
            guard let path = p["path"] as? String else { throw Failure("Missing output path") }
            let filter = SCContentFilter(desktopIndependentWindow:window)
            let config = SCStreamConfiguration()
            config.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale)); config.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
            config.scalesToFit = true
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            config.captureResolution = .best
            let image = try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
            let bitmap = NSBitmapImageRep(cgImage:image)
            guard let png = bitmap.representation(using:.png,properties:[:]) else { throw Failure("PNG encoding failed") }
            try png.write(to:URL(fileURLWithPath:path))
            return ["ok":true,"window":meta,"width":image.width,"height":image.height,"path":path,"ocr":[],"recognition":"vision-only"]
        }
        guard AXIsProcessTrusted() else { throw Failure("Accessibility permission is required for the host application") }
        if let expected = p["expectedFrame"] as? [String:Double] {
            guard abs(frame.minX-(expected["x"] ?? -99999)) < 1, abs(frame.minY-(expected["y"] ?? -99999)) < 1,
                  abs(frame.width-(expected["width"] ?? -1)) < 1, abs(frame.height-(expected["height"] ?? -1)) < 1 else { throw Failure("Window moved or resized; observe again before input") }
        }
        guard let pid = window.owningApplication?.processID, let app = NSRunningApplication(processIdentifier:pid) else { throw Failure("Game process disappeared") }
        let mode=p["inputMode"] as? String ?? "background"
        guard mode == "background" || mode == "foreground" else {throw Failure("Unknown input mode")}
        let api=WindowEventAPI.shared
        let transport=p["backgroundTransport"] as? String ?? "skylight"
        let factory=p["eventFactory"] as? String ?? "cg"
        guard ["skylight","public"].contains(transport),["cg","appkit"].contains(factory) else {throw Failure("Unknown event backend")}
        if mode == "background" && !api.available {throw Failure("Window-targeted event API unavailable; no input sent")}
        let before=interactionState(), cursorBefore=pointer()
        if mode == "foreground" {
            app.activate(options:[])
            try await Task.sleep(for:.milliseconds(160))
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw Failure("Game did not become the foreground app; input cancelled") }
        }
        // Re-read geometry without activating the target in background mode.
        let fresh = try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
        guard let current = fresh.windows.first(where:{$0.windowID == window.windowID}), current.frame == frame else { throw Failure("Window geometry changed before input") }
        func point(_ x:Double,_ y:Double) throws -> CGPoint {
            guard x >= 0 && x <= 1 && y >= 0 && y <= 1 else { throw Failure("Input coordinates must be normalized to the observed window") }
            return CGPoint(x:frame.minX+x*frame.width,y:frame.minY+y*frame.height)
        }
        guard let source=CGEventSource(stateID:.privateState) else {throw Failure("Cannot create private event source")}
        source.localEventsSuppressionInterval=0
        let marker=(p["showAgentPointer"] as? Bool ?? true) ? AgentPointer():nil
        defer {marker?.hide()}
        var previous:CGPoint?=nil
        let eventNumber=Int64(Date().timeIntervalSince1970*1000) & 0x7fffffff
        func event(_ type:CGEventType,_ pos:CGPoint) throws {
            let local=CGPoint(x:pos.x-frame.minX,y:pos.y-frame.minY)
            let generated:CGEvent?
            if factory == "appkit",let nsType=NSEvent.EventType(rawValue:UInt(type.rawValue)) {
                generated=NSEvent.mouseEvent(with:nsType,location:local,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,
                    windowNumber:Int(window.windowID),context:nil,eventNumber:Int(eventNumber),clickCount:type == .mouseMoved ? 0:1,
                    pressure:type == .leftMouseUp ? 0:1)?.cgEvent
            } else {generated=CGEvent(mouseEventSource:source,mouseType:type,mouseCursorPosition:pos,mouseButton:.left)}
            guard let e=generated else { throw Failure("Cannot create mouse event") }
            e.location=pos
            e.flags=(p["commandClick"] as? Bool ?? false) ? .maskCommand:[]
            e.setIntegerValueField(.eventTargetUnixProcessID,value:Int64(pid))
            e.setIntegerValueField(.mouseEventWindowUnderMousePointer,value:Int64(window.windowID))
            e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent,value:Int64(window.windowID))
            e.setIntegerValueField(.mouseEventClickState,value:type == .mouseMoved ? 0:1)
            e.setIntegerValueField(.mouseEventNumber,value:eventNumber)
            e.setDoubleValueField(.mouseEventPressure,value:type == .leftMouseUp ? 0:1)
            if let last=previous {
                e.setDoubleValueField(.mouseEventDeltaX,value:pos.x-last.x);e.setDoubleValueField(.mouseEventDeltaY,value:pos.y-last.y)
            }
            if mode == "background" {
                api.integer?(e,3,0)
                api.integer?(e,7,Int64(p["eventSubtype"] as? Int ?? (action == "drag" ? 0:3)))
                api.integer?(e,51,Int64(window.windowID))
                api.integer?(e,58,eventNumber)
                api.location?(e,local)
                if transport == "skylight" {api.post?(pid,e)} else {e.postToPid(pid)}
            } else {e.post(tap:.cghidEventTap)}
            previous=pos;marker?.show(pos,pid:pid)
        }
        let start = try point(number(p,"x"),number(p,"y"))
        if action == "click" {
            try event(.mouseMoved,start); try event(.leftMouseDown,start)
            try await Task.sleep(for:.milliseconds(120)); try event(.leftMouseUp,start)
        } else if action == "drag" {
            let end = try point(number(p,"toX"),number(p,"toY"))
            try event(.mouseMoved,start); try event(.leftMouseDown,start)
            try await Task.sleep(for:.milliseconds(150))
            let duration=max(300,min(3000,p["dragDurationMs"] as? Int ?? 1100))
            for i in 1...40 {
                try await Task.sleep(for:.milliseconds(duration/40))
                let t = Double(i)/40
                try event(.leftMouseDragged,CGPoint(x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t))
            }
            try event(.leftMouseUp,end)
        } else { throw Failure("Unsupported action \(action)") }
        try await Task.sleep(for:.milliseconds(100))
        let after=interactionState(),cursorAfter=pointer()
        return ["ok":true,"window":meta,"action":action,"inputMode":mode,"backgroundTransport":transport,"eventFactory":factory,"before":before,"after":after,
                "cursorDistance":hypot(cursorAfter.x-cursorBefore.x,cursorAfter.y-cursorBefore.y),
                "focusPreserved":(before["frontmostPid"] as? Int32)==(after["frontmostPid"] as? Int32)]
    }
}
