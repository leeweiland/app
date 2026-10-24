import Foundation
import Capacitor
import CoreMotion

// The iPhone's motion coprocessor counts steps all day on its own and keeps
// the last 7 days -- this just reads those per-day totals. Only needs the
// "Motion & Fitness" permission (NSMotionUsageDescription), not HealthKit.
@objc(PraStepsPlugin)
public class PraStepsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PraStepsPlugin"
    public let jsName = "PraSteps"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailySteps", returnType: CAPPluginReturnPromise)
    ]
    private let pedometer = CMPedometer()

    private func status() -> String {
        if !CMPedometer.isStepCountingAvailable() { return "unavailable" }
        switch CMPedometer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "prompt"
        }
    }

    @objc func checkPermission(_ call: CAPPluginCall) {
        call.resolve(["status": status()])
    }

    // iOS has no explicit "ask" call for motion -- the first query triggers
    // the system prompt, and its callback fires once the user answers.
    @objc func requestPermission(_ call: CAPPluginCall) {
        if status() != "prompt" { return call.resolve(["status": status()]) }
        let now = Date()
        pedometer.queryPedometerData(from: now.addingTimeInterval(-60), to: now) { [weak self] _, _ in
            call.resolve(["status": self?.status() ?? "denied"])
        }
    }

    @objc func getDailySteps(_ call: CAPPluginCall) {
        let s = status()
        if s != "granted" { return call.reject("Motion permission not granted", s) }
        let days = min(max(call.getInt("days") ?? 7, 1), 7)
        let cal = Calendar.current
        let now = Date()
        let todayStart = cal.startOfDay(for: now)
        let fmt = DateFormatter()
        fmt.calendar = Calendar(identifier: .gregorian)
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"

        var results: [[String: Any]] = []
        let lock = NSLock()
        let group = DispatchGroup()
        for i in 0..<days {
            guard let start = cal.date(byAdding: .day, value: -i, to: todayStart),
                  let dayEnd = cal.date(byAdding: .day, value: 1, to: start) else { continue }
            let end = min(dayEnd, now)
            group.enter()
            pedometer.queryPedometerData(from: start, to: end) { data, _ in
                if let data = data {
                    lock.lock()
                    results.append(["date": fmt.string(from: start), "steps": data.numberOfSteps.intValue])
                    lock.unlock()
                }
                group.leave()
            }
        }
        group.notify(queue: .main) {
            call.resolve(["days": results.sorted { ($0["date"] as! String) < ($1["date"] as! String) }])
        }
    }
}
