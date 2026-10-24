import Foundation
import Capacitor
import CoreMotion
import HealthKit

// Two sources, higher per day wins:
// - Apple Health: every device that syncs into it (Apple Watch, Oura, Garmin,
//   Fitbit...), de-duplicated by Health itself, so a watch-only walk counts.
// - The iPhone's own motion coprocessor (CoreMotion pedometer), which counts
//   steps all day and keeps the last 7 days -- the fallback when Health
//   access is declined (iOS never tells an app whether Health READ access
//   was granted, a declined read just returns no data).
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
    private let healthStore = HKHealthStore()
    private var stepType: HKQuantityType { HKQuantityType.quantityType(forIdentifier: .stepCount)! }

    private func motionStatus() -> String {
        if !CMPedometer.isStepCountingAvailable() { return "unavailable" }
        switch CMPedometer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "prompt"
        }
    }

    // "prompt" until Health's permission sheet has been shown once, then
    // "granted" (meaning asked -- see the note at the top).
    private func healthStatus(_ done: @escaping (String) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else { return done("unavailable") }
        healthStore.getRequestStatusForAuthorization(toShare: [], read: [stepType]) { status, _ in
            switch status {
            case .shouldRequest: done("prompt")
            case .unnecessary: done("granted")
            default: done("unavailable")
            }
        }
    }

    private func permissionResult(_ done: @escaping ([String: Any]) -> Void) {
        let motion = motionStatus()
        healthStatus { health in
            let all = [motion, health]
            let combined = all.contains("granted") ? "granted"
                : all.contains("prompt") ? "prompt"
                : all.contains("denied") ? "denied" : "unavailable"
            done(["status": combined, "motionStatus": motion, "healthStatus": health])
        }
    }

    @objc func checkPermission(_ call: CAPPluginCall) {
        permissionResult { call.resolve($0) }
    }

    // Motion first (iOS has no explicit ask -- the first query triggers its
    // prompt), then Apple Health's permission sheet.
    @objc func requestPermission(_ call: CAPPluginCall) {
        let askHealth = { [weak self] in
            guard let self = self else { return }
            self.healthStatus { health in
                if health != "prompt" { return self.permissionResult { call.resolve($0) } }
                self.healthStore.requestAuthorization(toShare: [], read: [self.stepType]) { _, _ in
                    self.permissionResult { call.resolve($0) }
                }
            }
        }
        if motionStatus() != "prompt" { return askHealth() }
        let now = Date()
        pedometer.queryPedometerData(from: now.addingTimeInterval(-60), to: now) { _, _ in askHealth() }
    }

    @objc func getDailySteps(_ call: CAPPluginCall) {
        let days = min(max(call.getInt("days") ?? 7, 1), 7)
        let cal = Calendar.current
        let now = Date()
        let todayStart = cal.startOfDay(for: now)
        let fmt = DateFormatter()
        fmt.calendar = Calendar(identifier: .gregorian)
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"

        var byDay: [String: Int] = [:]
        let lock = NSLock()
        let add = { (key: String, steps: Int) in
            lock.lock()
            byDay[key] = max(byDay[key] ?? 0, steps)
            lock.unlock()
        }
        let group = DispatchGroup()

        if motionStatus() == "granted" {
            for i in 0..<days {
                guard let start = cal.date(byAdding: .day, value: -i, to: todayStart),
                      let dayEnd = cal.date(byAdding: .day, value: 1, to: start) else { continue }
                group.enter()
                pedometer.queryPedometerData(from: start, to: min(dayEnd, now)) { data, _ in
                    if let data = data { add(fmt.string(from: start), data.numberOfSteps.intValue) }
                    group.leave()
                }
            }
        }

        if HKHealthStore.isHealthDataAvailable(), let start = cal.date(byAdding: .day, value: -(days - 1), to: todayStart) {
            group.enter()
            let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
            let query = HKStatisticsCollectionQuery(quantityType: stepType, quantitySamplePredicate: predicate,
                                                    options: .cumulativeSum, anchorDate: todayStart,
                                                    intervalComponents: DateComponents(day: 1))
            query.initialResultsHandler = { _, results, _ in
                results?.enumerateStatistics(from: start, to: now) { stats, _ in
                    if let sum = stats.sumQuantity() {
                        add(fmt.string(from: stats.startDate), Int(sum.doubleValue(for: .count())))
                    }
                }
                group.leave()
            }
            healthStore.execute(query)
        }

        group.notify(queue: .main) { [weak self] in
            self?.permissionResult { perm in
                if perm["status"] as? String != "granted" && byDay.isEmpty {
                    return call.reject("Step permission not granted", perm["status"] as? String)
                }
                let list = byDay.keys.sorted().map { ["date": $0, "steps": byDay[$0]!] as [String: Any] }
                call.resolve(["days": list])
            }
        }
    }
}
