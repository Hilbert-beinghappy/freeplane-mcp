import AppKit
import ApplicationServices
import Foundation

private let helperVersion = "1.0.0"
private let freeplaneBundleIdentifier = "org.freeplane.launcher"

private struct ActionSpec {
    let capability: String
    let action: String
    let paths: [(locale: String, titles: [String])]
}

private let actionSpecs = [
    ActionSpec(capability: "presentation.navigate", action: "start", paths: [
        ("en", ["Navigate", "Presentation", "Run presentation"]),
        ("zh_CN", ["导航", "演示", "开始演示"]),
    ]),
    ActionSpec(capability: "presentation.navigate", action: "stop", paths: [
        ("en", ["Navigate", "Presentation", "Stop presentation"]),
        ("zh_CN", ["导航", "演示", "停止演示"]),
    ]),
    ActionSpec(capability: "presentation.navigate", action: "first", paths: [
        ("en", ["Navigate", "Presentation", "First slide"]),
        ("zh_CN", ["导航", "演示", "第一张幻灯片"]),
    ]),
    ActionSpec(capability: "presentation.navigate", action: "previous", paths: [
        ("en", ["Navigate", "Presentation", "Show previous slide"]),
        ("zh_CN", ["导航", "演示", "上一张幻灯片"]),
    ]),
    ActionSpec(capability: "presentation.navigate", action: "next", paths: [
        ("en", ["Navigate", "Presentation", "Show next slide"]),
        ("zh_CN", ["导航", "演示", "下一张幻灯片"]),
    ]),
    ActionSpec(capability: "presentation.navigate", action: "last", paths: [
        ("en", ["Navigate", "Presentation", "Last slide"]),
        ("zh_CN", ["导航", "演示", "最后一张幻灯片"]),
    ]),
    ActionSpec(capability: "print.preview", action: "open", paths: [
        ("en", ["File", "Print map…", "Print preview…"]),
        ("zh_CN", ["文件", "打印导图…", "打印预览…"]),
    ]),
]

private struct HelperFailure: Error {
    let code: String
    let message: String
}

private func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func normalized(_ value: String) -> String {
    value
        .replacingOccurrences(of: "...", with: "…")
        .replacingOccurrences(
            of: #"\([A-Za-z0-9]\)(?=…?$)"#,
            with: "",
            options: .regularExpression
        )
        .split(whereSeparator: { $0.isWhitespace })
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

private func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    attribute(element, name) as? String
}

private func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool? {
    attribute(element, name) as? Bool
}

private func elementAttribute(_ element: AXUIElement, _ name: CFString) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
    guard let value = attribute(element, kAXChildrenAttribute as CFString) else { return [] }
    return value as? [AXUIElement] ?? []
}

private func role(_ element: AXUIElement) -> String {
    stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
}

private func title(_ element: AXUIElement) -> String {
    stringAttribute(element, kAXTitleAttribute as CFString) ?? ""
}

private func matchingChild(_ element: AXUIElement, title expected: String, roles: Set<String>) -> AXUIElement? {
    let target = normalized(expected)
    return children(element).first {
        roles.contains(role($0)) && normalized(title($0)).localizedCaseInsensitiveCompare(target) == .orderedSame
    }
}

private func childMenu(_ element: AXUIElement) -> AXUIElement? {
    children(element).first { role($0) == (kAXMenuRole as String) }
}

private func resolveMenuItem(_ app: AXUIElement, path: [String]) -> AXUIElement? {
    guard path.count >= 2,
          let menuBar = elementAttribute(app, kAXMenuBarAttribute as CFString),
          let top = matchingChild(menuBar, title: path[0], roles: [kAXMenuBarItemRole as String]),
          var menu = childMenu(top) else { return nil }
    for index in 1..<path.count {
        guard let item = matchingChild(menu, title: path[index], roles: [kAXMenuItemRole as String]) else { return nil }
        if index == path.count - 1 { return item }
        guard let submenu = childMenu(item) else { return nil }
        menu = submenu
    }
    return nil
}

private func previewWindow(_ app: AXUIElement) -> AXUIElement? {
    let titles = Set(["Print preview", "打印预览"])
    return childrenFromAttribute(app, kAXWindowsAttribute as CFString).first {
        role($0) == (kAXWindowRole as String) && titles.contains(normalized(title($0)))
    }
}

private func childrenFromAttribute(_ element: AXUIElement, _ name: CFString) -> [AXUIElement] {
    guard let value = attribute(element, name) else { return [] }
    return value as? [AXUIElement] ?? []
}

private func waitFor<T>(timeout: TimeInterval, _ body: () -> T?) -> T? {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if let value = body() { return value }
        Thread.sleep(forTimeInterval: 0.05)
    } while Date() < deadline
    return nil
}

private func trusted() -> Bool {
    AXIsProcessTrusted()
}

private func frontmostPID() -> pid_t? {
    let system = AXUIElementCreateSystemWide()
    guard let focused = elementAttribute(system, kAXFocusedApplicationAttribute as CFString) else { return nil }
    var pid: pid_t = 0
    return AXUIElementGetPid(focused, &pid) == .success ? pid : nil
}

private func parseRequest() throws -> [String: Any] {
    guard CommandLine.arguments.count == 2,
          let data = CommandLine.arguments[1].data(using: .utf8),
          data.count <= 16 * 1024,
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw HelperFailure(code: "VALIDATION_ERROR", message: "Expected one bounded JSON request argument")
    }
    return request
}

private func requireInvokeContext(
    _ request: [String: Any],
    activate: Bool
) throws -> (NSRunningApplication, AXUIElement, pid_t, Bool, Bool) {
    guard trusted() else {
        throw HelperFailure(code: "POLICY_DENIED", message: "macOS Accessibility permission is not granted")
    }
    guard let pidValue = request["pid"] as? NSNumber, CFGetTypeID(pidValue) != CFBooleanGetTypeID() else {
        throw HelperFailure(code: "VALIDATION_ERROR", message: "pid must be a positive integer")
    }
    let pid64 = pidValue.int64Value
    guard pidValue.doubleValue == Double(pid64),
          let pid = pid_t(exactly: pid64),
          pid > 1,
          let running = NSRunningApplication(processIdentifier: pid),
          !running.isTerminated,
          running.bundleIdentifier == freeplaneBundleIdentifier else {
        throw HelperFailure(code: "ACTION_PRECONDITION_FAILED", message: "Target PID is not the qualified Freeplane bundle")
    }
    let frontmostBefore = frontmostPID() == pid
    let app = AXUIElementCreateApplication(pid)
    if activate {
        _ = running.activate(options: [.activateAllWindows])
        _ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(
            AXUIElementCreateSystemWide(),
            kAXFocusedApplicationAttribute as CFString,
            app
        )
        if let main = elementAttribute(app, kAXMainWindowAttribute as CFString) {
            _ = AXUIElementPerformAction(main, kAXRaiseAction as CFString)
        }
    }
    guard waitFor(timeout: 3, {
        elementAttribute(app, kAXFocusedWindowAttribute as CFString)
            ?? elementAttribute(app, kAXMainWindowAttribute as CFString)
    }) != nil else {
        throw HelperFailure(code: "ACTION_PRECONDITION_FAILED", message: "Freeplane has no identifiable focused main window")
    }
    let frontmostAfter = activate
        ? waitFor(timeout: 3, { frontmostPID() == pid ? true : nil }) == true
        : frontmostPID() == pid
    if activate && !frontmostAfter {
        throw HelperFailure(code: "ACTION_PRECONDITION_FAILED", message: "Freeplane could not become the frontmost application")
    }
    return (running, app, pid, frontmostBefore, frontmostAfter)
}

private func invoke(_ request: [String: Any]) throws -> [String: Any] {
    guard request["schema_version"] as? Int == 1,
          request["command"] as? String == "invoke",
          let capability = request["capability_id"] as? String,
          let action = request["action"] as? String,
          let expectedLocale = request["expected_locale"] as? String,
          ["en", "zh_CN"].contains(expectedLocale),
          let dryRun = request["dry_run"] as? Bool else {
        throw HelperFailure(code: "VALIDATION_ERROR", message: "Invoke request schema is invalid")
    }
    let (_, app, pid, frontmostBefore, frontmostAfter) = try requireInvokeContext(request, activate: !dryRun)

    if capability == "print.preview" && action == "close" {
        guard let preview = previewWindow(app) else {
            throw HelperFailure(code: "ACTION_PRECONDITION_FAILED", message: "Print preview window is not open")
        }
        if !dryRun {
            guard let close = elementAttribute(preview, kAXCloseButtonAttribute as CFString),
                  AXUIElementPerformAction(close, kAXPressAction as CFString) == .success,
                  waitFor(timeout: 3, { previewWindow(app) == nil ? true : nil }) == true else {
                throw HelperFailure(code: "POSTCONDITION_FAILED", message: "Print preview window did not close")
            }
        }
        return [
            "schema_version": 1,
            "ok": true,
            "helper_version": helperVersion,
            "pid": Int(pid),
            "bundle_id": freeplaneBundleIdentifier,
            "capability_id": capability,
            "action": action,
            "effect": dryRun ? "planned" : "closed",
            "locale": expectedLocale,
            "menu_resolution": "resolved",
            "preview_open": dryRun,
            "frontmost_before_matches": frontmostBefore,
            "frontmost_after_matches": frontmostAfter,
            "focus_recovered": !frontmostBefore && frontmostAfter,
        ]
    }

    guard let spec = actionSpecs.first(where: { $0.capability == capability && $0.action == action }) else {
        throw HelperFailure(code: "CAPABILITY_UNAVAILABLE", message: "Capability/action tuple is not allowlisted")
    }
    guard let path = spec.paths.first(where: { $0.locale == expectedLocale }) else {
        throw HelperFailure(code: "CAPABILITY_UNAVAILABLE", message: "Freeplane locale is not qualified")
    }
    if dryRun && !frontmostBefore {
        return [
            "schema_version": 1,
            "ok": true,
            "helper_version": helperVersion,
            "pid": Int(pid),
            "bundle_id": freeplaneBundleIdentifier,
            "capability_id": capability,
            "action": action,
            "effect": "planned",
            "locale": expectedLocale,
            "resolved_titles": path.titles,
            "menu_resolution": "deferred_until_focus",
            "preview_open": false,
            "frontmost_before_matches": frontmostBefore,
            "frontmost_after_matches": frontmostAfter,
            "focus_recovered": false,
        ]
    }
    guard let item = waitFor(timeout: 3, { resolveMenuItem(app, path: path.titles) }) else {
        throw HelperFailure(code: "ACTION_PRECONDITION_FAILED", message: "Allowlisted Freeplane menu item was not found")
    }
    guard boolAttribute(item, kAXEnabledAttribute as CFString) != false else {
        throw HelperFailure(code: "ACTION_PRECONDITION_FAILED", message: "Allowlisted Freeplane menu item is disabled")
    }
    if !dryRun && AXUIElementPerformAction(item, kAXPressAction as CFString) != .success {
        throw HelperFailure(code: "FREEPLANE_ERROR", message: "Accessibility press action failed")
    }
    var previewOpen = false
    if capability == "print.preview" && action == "open" && !dryRun {
        previewOpen = waitFor(timeout: 5, { previewWindow(app) == nil ? nil : true }) == true
        if !previewOpen {
            throw HelperFailure(code: "POSTCONDITION_FAILED", message: "Print preview window did not appear")
        }
    }
    return [
        "schema_version": 1,
        "ok": true,
        "helper_version": helperVersion,
        "pid": Int(pid),
        "bundle_id": freeplaneBundleIdentifier,
        "capability_id": capability,
        "action": action,
        "effect": dryRun ? "planned" : "pressed",
        "locale": expectedLocale,
        "resolved_titles": path.titles,
        "menu_resolution": "resolved",
        "preview_open": previewOpen,
        "frontmost_before_matches": frontmostBefore,
        "frontmost_after_matches": frontmostAfter,
        "focus_recovered": !frontmostBefore && frontmostAfter,
    ]
}

do {
    let request = try parseRequest()
    switch request["command"] as? String {
    case "status":
        emit([
            "schema_version": 1,
            "ok": true,
            "helper_version": helperVersion,
            "trusted": trusted(),
            "bundle_id": freeplaneBundleIdentifier,
        ])
    case "self_test":
        let keys = actionSpecs.map { "\($0.capability):\($0.action)" }
        let pathsValid = actionSpecs.allSatisfy { spec in
            spec.paths.count == 2 && spec.paths.allSatisfy { $0.titles.count >= 2 && $0.titles.allSatisfy { !$0.isEmpty } }
        }
        let normalizationValid = normalized("导航(N)") == "导航"
            && normalized("打印预览(P)…") == "打印预览…"
        let localesValid = actionSpecs.allSatisfy { Set($0.paths.map(\.locale)) == Set(["en", "zh_CN"]) }
        guard Set(keys).count == keys.count, pathsValid, normalizationValid, localesValid else {
            throw HelperFailure(code: "POSTCONDITION_FAILED", message: "Compiled allowlist is invalid")
        }
        emit([
            "schema_version": 1,
            "ok": true,
            "helper_version": helperVersion,
            "allowlisted_action_count": actionSpecs.count + 1,
        ])
    case "invoke":
        emit(try invoke(request))
    default:
        throw HelperFailure(code: "VALIDATION_ERROR", message: "Unsupported helper command")
    }
} catch let failure as HelperFailure {
    emit([
        "schema_version": 1,
        "ok": false,
        "helper_version": helperVersion,
        "error": ["code": failure.code, "message": failure.message],
    ])
} catch {
    emit([
        "schema_version": 1,
        "ok": false,
        "helper_version": helperVersion,
        "error": ["code": "FREEPLANE_ERROR", "message": "Accessibility helper failed"],
    ])
}
