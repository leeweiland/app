import Foundation
import Capacitor
import CoreMotion
import HealthKit

// Steps come from two sources, higher per day wins:
// - Apple Health: every device that syncs into it (Apple Watch, Oura, Garmin,
//   Fitbit...), de-duplicated by Health itself, so a watch-only walk counts.
// - The iPhone's own motion coprocessor (CoreMotion pedometer), which counts
//   steps all day and keeps the last 7 days -- the fallback when Health
//   access is declined (iOS never tells an app whether Health READ access
//   was granted, a declined read just returns no data).
// getDailyHealth also reads the rest of the main Health data (distance,
// active calories, heart rate, resting HR, HRV, sleep, workouts, weight,
// body fat) for the Health tab.
@objc(PraStepsPlugin)
public class PraStepsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PraStepsPlugin"
    public let jsName = "PraSteps"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailySteps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDailyHealth", returnType: CAPPluginReturnPromise)
    ]
    private let pedometer = CMPedometer()
    private let healthStore = HKHealthStore()

    private func quantity(_ id: HKQuantityTypeIdentifier) -> HKQuantityType { HKQuantityType.quantityType(forIdentifier: id)! }
    private var stepType: HKQuantityType { quantity(.stepCount) }

    // Everything the Health tab may show -- asked for together, once.
    private var readTypes: Set<HKObjectType> {
        [quantity(.stepCount), quantity(.distanceWalkingRunning), quantity(.activeEnergyBurned),
         quantity(.heartRate), quantity(.restingHeartRate), quantity(.heartRateVariabilitySDNN),
         quantity(.bodyMass), quantity(.bodyFatPercentage),
         HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!, HKObjectType.workoutType()]
    }

    private func motionStatus() -> String {
        if !CMPedometer.isStepCountingAvailable() { return "unavailable" }
        switch CMPedometer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        default: return "prompt"
        }
    }

    // "prompt" until Health's permission sheet has been shown for every type
    // in readTypes, then "granted" (meaning asked -- see the note at the top).
    private func healthStatus(_ done: @escaping (String) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else { return done("unavailable") }
        healthStore.getRequestStatusForAuthorization(toShare: [], read: readTypes) { status, _ in
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
                self.healthStore.requestAuthorization(toShare: [], read: self.readTypes) { _, _ in
                    self.permissionResult { call.resolve($0) }
                }
            }
        }
        if motionStatus() != "prompt" { return askHealth() }
        let now = Date()
        pedometer.queryPedometerData(from: now.addingTimeInterval(-60), to: now) { _, _ in askHealth() }
    }

    private func dayFormatter() -> DateFormatter {
        let fmt = DateFormatter()
        fmt.calendar = Calendar(identifier: .gregorian)
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt
    }

    // Per-day pedometer step totals (empty without motion permission).
    private func pedometerDays(_ days: Int, _ done: @escaping ([String: Int]) -> Void) {
        guard motionStatus() == "granted" else { return done([:]) }
        let cal = Calendar.current
        let now = Date()
        let todayStart = cal.startOfDay(for: now)
        let fmt = dayFormatter()
        var out: [String: Int] = [:]
        let lock = NSLock()
        let group = DispatchGroup()
        for i in 0..<days {
            guard let start = cal.date(byAdding: .day, value: -i, to: todayStart),
                  let dayEnd = cal.date(byAdding: .day, value: 1, to: start) else { continue }
            group.enter()
            pedometer.queryPedometerData(from: start, to: min(dayEnd, now)) { data, _ in
                if let data = data {
                    lock.lock(); out[fmt.string(from: start)] = data.numberOfSteps.intValue; lock.unlock()
                }
                group.leave()
            }
        }
        group.notify(queue: .global()) { done(out) }
    }

    // Per-day statistics for one quantity type: date -> (value, source names).
    private func dailyStats(_ type: HKQuantityType, _ options: HKStatisticsOptions, _ unit: HKUnit, days: Int,
                            _ done: @escaping ([String: (Double, [String])]) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else { return done([:]) }
        let cal = Calendar.current
        let now = Date()
        let todayStart = cal.startOfDay(for: now)
        guard let start = cal.date(byAdding: .day, value: -(days - 1), to: todayStart) else { return done([:]) }
        let fmt = dayFormatter()
        let predicate = HKQuery.predicateForSamples(withStart: start, end: now, options: .strictStartDate)
        let query = HKStatisticsCollectionQuery(quantityType: type, quantitySamplePredicate: predicate,
                                                options: options.union(.separateBySource), anchorDate: todayStart,
                                                intervalComponents: DateComponents(day: 1))
        query.initialResultsHandler = { _, results, _ in
            var out: [String: (Double, [String])] = [:]
            results?.enumerateStatistics(from: start, to: now) { stats, _ in
                let q = options.contains(.cumulativeSum) ? stats.sumQuantity() : stats.averageQuantity()
                if let q = q {
                    out[fmt.string(from: stats.startDate)] = (q.doubleValue(for: unit), (stats.sources ?? []).map { $0.name })
                }
            }
            done(out)
        }
        healthStore.execute(query)
    }

    private func samples(_ type: HKSampleType, from start: Date, _ done: @escaping ([HKSample]) -> Void) {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: [])
        let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit,
                                  sortDescriptors: nil) { _, results, _ in done(results ?? []) }
        healthStore.execute(query)
    }

    @objc func getDailySteps(_ call: CAPPluginCall) {
        let days = min(max(call.getInt("days") ?? 7, 1), 7)
        var health: [String: (Double, [String])] = [:]
        var phone: [String: Int] = [:]
        let group = DispatchGroup()
        group.enter(); dailyStats(stepType, .cumulativeSum, .count(), days: days) { health = $0; group.leave() }
        group.enter(); pedometerDays(days) { phone = $0; group.leave() }
        group.notify(queue: .main) { [weak self] in
            var byDay: [String: Int] = phone
            for (k, v) in health { byDay[k] = max(byDay[k] ?? 0, Int(v.0)) }
            self?.permissionResult { perm in
                if perm["status"] as? String != "granted" && byDay.isEmpty {
                    return call.reject("Step permission not granted", perm["status"] as? String)
                }
                let list = byDay.keys.sorted().map { ["date": $0, "steps": byDay[$0]!] as [String: Any] }
                call.resolve(["days": list])
            }
        }
    }

    // One object per day (oldest first): date, steps, distanceM, activeKcal,
    // avgHr, restingHr, hrvMs, sleepMin, weightKg, bodyFatPct, workouts
    // [{type,start,end,kcal}], sources [app/device names]. A value is left
    // out when there's no data (or Health access was declined).
    @objc func getDailyHealth(_ call: CAPPluginCall) {
        let days = min(max(call.getInt("days") ?? 7, 1), 7)
        let cal = Calendar.current
        let todayStart = cal.startOfDay(for: Date())
        let rangeStart = cal.date(byAdding: .day, value: -(days - 1), to: todayStart)!
        let fmt = dayFormatter()
        let iso = ISO8601DateFormatter()
        let energyType = quantity(.activeEnergyBurned)

        var stats: [String: [String: (Double, [String])]] = [:]
        var phone: [String: Int] = [:]
        var sleepSamples: [HKSample] = []
        var workouts: [HKSample] = []
        let lock = NSLock()
        let group = DispatchGroup()
        let metrics: [(String, HKQuantityTypeIdentifier, HKStatisticsOptions, HKUnit)] = [
            ("steps", .stepCount, .cumulativeSum, .count()),
            ("distanceM", .distanceWalkingRunning, .cumulativeSum, .meter()),
            ("activeKcal", .activeEnergyBurned, .cumulativeSum, .kilocalorie()),
            ("avgHr", .heartRate, .discreteAverage, HKUnit.count().unitDivided(by: .minute())),
            ("restingHr", .restingHeartRate, .discreteAverage, HKUnit.count().unitDivided(by: .minute())),
            ("hrvMs", .heartRateVariabilitySDNN, .discreteAverage, .secondUnit(with: .milli)),
            ("weightKg", .bodyMass, .discreteAverage, .gramUnit(with: .kilo)),
            ("bodyFatPct", .bodyFatPercentage, .discreteAverage, .percent())
        ]
        if HKHealthStore.isHealthDataAvailable() {
            for (key, id, opts, unit) in metrics {
                group.enter()
                dailyStats(quantity(id), opts, unit, days: days) { res in
                    lock.lock(); stats[key] = res; lock.unlock(); group.leave()
                }
            }
            // Sleep: from 6pm the evening before the first day.
            group.enter()
            samples(HKCategoryType.categoryType(forIdentifier: .sleepAnalysis)!, from: rangeStart.addingTimeInterval(-6 * 3600)) {
                sleepSamples = $0; group.leave()
            }
            group.enter()
            samples(HKObjectType.workoutType(), from: rangeStart) { workouts = $0; group.leave() }
        }
        group.enter(); pedometerDays(days) { phone = $0; group.leave() }

        group.notify(queue: .main) { [weak self] in
            var out: [[String: Any]] = []
            for i in 0..<days {
                guard let dayStart = cal.date(byAdding: .day, value: i, to: rangeStart),
                      let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart) else { continue }
                let key = fmt.string(from: dayStart)
                var o: [String: Any] = ["date": key]
                var sources = Set<String>()
                for (name, _, _, _) in metrics {
                    guard let pair = stats[name]?[key] else { continue }
                    let (value, src) = pair
                    sources.formUnion(src)
                    switch name {
                    case "steps", "distanceM", "activeKcal", "avgHr", "restingHr": o[name] = Int(value.rounded())
                    case "bodyFatPct": o[name] = (value * 1000).rounded() / 10 // fraction -> %
                    default: o[name] = (value * 10).rounded() / 10
                    }
                }
                let phoneSteps = phone[key] ?? 0
                if phoneSteps > 0 || o["steps"] != nil { o["steps"] = max(o["steps"] as? Int ?? 0, phoneSteps) }

                // Sleep for the night ending on this day (6pm before -> 6pm),
                // asleep stages only, overlapping samples from several
                // sources (watch + ring) merged so they aren't counted twice.
                let nightStart = dayStart.addingTimeInterval(-6 * 3600), nightEnd = dayStart.addingTimeInterval(18 * 3600)
                let asleep = sleepSamples.compactMap { $0 as? HKCategorySample }.filter { s in
                    s.endDate > nightStart && s.endDate <= nightEnd &&
                        s.value != HKCategoryValueSleepAnalysis.inBed.rawValue &&
                        s.value != HKCategoryValueSleepAnalysis.awake.rawValue
                }.sorted { $0.startDate < $1.startDate }
                var sleepSec: TimeInterval = 0
                var curStart: Date?, curEnd: Date?
                for s in asleep {
                    sources.insert(s.sourceRevision.source.name)
                    if let e = curEnd, s.startDate <= e {
                        curEnd = max(e, s.endDate)
                    } else {
                        if let a = curStart, let e = curEnd { sleepSec += e.timeIntervalSince(a) }
                        curStart = s.startDate; curEnd = s.endDate
                    }
                }
                if let a = curStart, let e = curEnd { sleepSec += e.timeIntervalSince(a) }
                if sleepSec > 0 { o["sleepMin"] = Int((sleepSec / 60).rounded()) }

                let dayWorkouts = workouts.compactMap { $0 as? HKWorkout }.filter { $0.startDate >= dayStart && $0.startDate < dayEnd }
                o["workouts"] = dayWorkouts.map { w -> [String: Any] in
                    sources.insert(w.sourceRevision.source.name)
                    var item: [String: Any] = ["type": PraStepsPlugin.workoutName(w.workoutActivityType),
                                               "start": iso.string(from: w.startDate), "end": iso.string(from: w.endDate)]
                    var kcal: Double?
                    if #available(iOS 16.0, *) {
                        kcal = w.statistics(for: energyType)?.sumQuantity()?.doubleValue(for: .kilocalorie())
                    } else {
                        kcal = w.totalEnergyBurned?.doubleValue(for: .kilocalorie())
                    }
                    if let kcal = kcal { item["kcal"] = Int(kcal.rounded()) }
                    return item
                }
                o["sources"] = Array(sources).sorted()
                out.append(o)
            }
            self?.permissionResult { perm in
                if perm["status"] as? String != "granted" && out.allSatisfy({ $0.count <= 3 }) {
                    return call.reject("Health permission not granted", perm["status"] as? String)
                }
                call.resolve(["days": out])
            }
        }
    }

    private static func workoutName(_ t: HKWorkoutActivityType) -> String {
        switch t {
        case .walking: return "walking"
        case .running: return "running"
        case .cycling: return "cycling"
        case .hiking: return "hiking"
        case .swimming: return "swimming"
        case .traditionalStrengthTraining, .functionalStrengthTraining: return "strength"
        case .highIntensityIntervalTraining: return "hiit"
        case .yoga: return "yoga"
        case .pilates: return "pilates"
        case .flexibility: return "stretching"
        case .martialArts: return "martial arts"
        case .boxing, .kickboxing: return "boxing"
        case .gymnastics: return "gymnastics"
        case .coreTraining: return "core"
        case .mixedCardio: return "cardio"
        case .dance: return "dancing"
        case .rowing: return "rowing"
        case .elliptical: return "elliptical"
        case .stairs, .stairClimbing: return "stairs"
        case .cooldown: return "cooldown"
        default: return "workout"
        }
    }
}
