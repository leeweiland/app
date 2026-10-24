package com.pacificrimathleticsapp.steps

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.reflect.KClass

// Health Connect is Android's shared health hub -- Samsung Health, Fitbit,
// Oura, Pixel/Galaxy Watch etc. all sync into it (de-duplicated by its own
// source priority), so reading it picks up a watch-only walk, a ring's sleep
// and so on. Its API is all Kotlin suspend functions; these blocking wrappers
// are only ever called from Capacitor's plugin thread (never the UI thread).
object HealthConnectSteps {
    private const val PROVIDER = "com.google.android.apps.healthdata"
    private val STEPS = HealthPermission.getReadPermission(StepsRecord::class)

    // Everything the Health tab may show -- asked for together, once. Each
    // can be granted or declined separately on Health Connect's screen, so
    // every read below only touches what was actually granted.
    private val READ_TYPES: List<KClass<out Record>> = listOf(
        StepsRecord::class, DistanceRecord::class, ActiveCaloriesBurnedRecord::class,
        HeartRateRecord::class, RestingHeartRateRecord::class, HeartRateVariabilityRmssdRecord::class,
        SleepSessionRecord::class, ExerciseSessionRecord::class, WeightRecord::class, BodyFatRecord::class
    )
    private val ALL_PERMISSIONS = READ_TYPES.map { HealthPermission.getReadPermission(it) }.toSet()

    private val WORKOUT_NAMES = mapOf(
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "walking",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to "running",
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL to "running",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING to "cycling",
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY to "cycling",
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "hiking",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL to "swimming",
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER to "swimming",
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING to "strength",
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING to "strength",
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS to "calisthenics",
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "hiit",
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA to "yoga",
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES to "pilates",
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING to "stretching",
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS to "martial arts",
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING to "boxing",
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING to "dancing",
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE to "rowing",
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL to "elliptical",
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING to "stairs"
    )

    @JvmStatic
    fun isAvailable(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 28) return false
        return try {
            HealthConnectClient.getSdkStatus(context, PROVIDER) == HealthConnectClient.SDK_AVAILABLE
        } catch (e: Exception) {
            false
        }
    }

    private fun granted(context: Context): Set<String> {
        if (!isAvailable(context)) return emptySet()
        return try {
            runBlocking { HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions() }
        } catch (e: Exception) {
            emptySet()
        }
    }

    // True once any health read has been allowed.
    @JvmStatic
    fun hasPermission(context: Context): Boolean = granted(context).any { it in ALL_PERMISSIONS }

    @JvmStatic
    fun permissionIntent(context: Context): Intent =
        PermissionController.createRequestPermissionResultContract().createIntent(context, ALL_PERMISSIONS)

    // date ("yyyy-MM-dd") -> that day's step total, last `days` days including today.
    @JvmStatic
    fun dailySteps(context: Context, days: Int): Map<String, Long> {
        if (STEPS !in granted(context)) return emptyMap()
        return try {
            runBlocking {
                val groups = HealthConnectClient.getOrCreate(context).aggregateGroupByPeriod(
                    AggregateGroupByPeriodRequest(
                        metrics = setOf(StepsRecord.COUNT_TOTAL),
                        timeRangeFilter = TimeRangeFilter.between(rangeStart(days), LocalDateTime.now()),
                        timeRangeSlicer = Period.ofDays(1)
                    )
                )
                groups.mapNotNull { g -> g.result[StepsRecord.COUNT_TOTAL]?.let { DAY.format(g.startTime) to it } }.toMap()
            }
        } catch (e: Exception) {
            emptyMap()
        }
    }

    // One object per day (oldest first): date, steps, distanceM, activeKcal,
    // avgHr, restingHr, hrvMs, sleepMin, weightKg, bodyFatPct, workouts
    // [{type,start,end,kcal}], sources [package names]. A value is left out
    // when there's no data or no permission for it.
    @JvmStatic
    fun dailyHealth(context: Context, days: Int): JSONArray {
        val ok = granted(context)
        val out = JSONArray()
        if (ok.none { it in ALL_PERMISSIONS }) return out
        fun allowed(type: KClass<out Record>) = HealthPermission.getReadPermission(type) in ok
        return try {
            runBlocking {
                val client = HealthConnectClient.getOrCreate(context)
                val start = rangeStart(days)
                val now = LocalDateTime.now()
                val zone = ZoneId.systemDefault()
                val byDay = linkedMapOf<String, JSONObject>()
                val sources = mutableMapOf<String, MutableSet<String>>()
                for (i in 0 until days) {
                    val key = DAY.format(start.plusDays(i.toLong()))
                    byDay[key] = JSONObject().put("date", key).put("workouts", JSONArray())
                    sources[key] = mutableSetOf()
                }
                fun day(t: Instant) = DAY.format(t.atZone(zone).toLocalDate())
                // One failing read (a revoked permission mid-sync, a bad
                // record) shouldn't lose every other value for the week.
                suspend fun safely(block: suspend () -> Unit) {
                    try { block() } catch (e: Exception) {}
                }

                // Day totals/averages Health Connect can aggregate itself.
                val metrics = mutableSetOf<AggregateMetric<*>>()
                if (allowed(StepsRecord::class)) metrics += StepsRecord.COUNT_TOTAL
                if (allowed(DistanceRecord::class)) metrics += DistanceRecord.DISTANCE_TOTAL
                if (allowed(ActiveCaloriesBurnedRecord::class)) metrics += ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL
                if (allowed(HeartRateRecord::class)) metrics += HeartRateRecord.BPM_AVG
                if (allowed(RestingHeartRateRecord::class)) metrics += RestingHeartRateRecord.BPM_AVG
                if (allowed(WeightRecord::class)) metrics += WeightRecord.WEIGHT_AVG
                if (metrics.isNotEmpty()) safely {
                    val groups = client.aggregateGroupByPeriod(
                        AggregateGroupByPeriodRequest(metrics, TimeRangeFilter.between(start, now), Period.ofDays(1))
                    )
                    for (g in groups) {
                        val key = DAY.format(g.startTime)
                        val o = byDay[key] ?: continue
                        val r = g.result
                        r[StepsRecord.COUNT_TOTAL]?.let { o.put("steps", it) }
                        r[DistanceRecord.DISTANCE_TOTAL]?.let { o.put("distanceM", Math.round(it.inMeters)) }
                        r[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.let { o.put("activeKcal", Math.round(it.inKilocalories)) }
                        r[HeartRateRecord.BPM_AVG]?.let { o.put("avgHr", it) }
                        r[RestingHeartRateRecord.BPM_AVG]?.let { o.put("restingHr", it) }
                        r[WeightRecord.WEIGHT_AVG]?.let { o.put("weightKg", Math.round(it.inKilograms * 10) / 10.0) }
                        r.dataOrigins.forEach { sources[key]?.add(it.packageName) }
                    }
                }

                // Sleep: the night that ends on a day belongs to that day
                // (6pm the evening before -> 6pm), totalled by Health Connect
                // so overlapping watch + ring sessions aren't double counted.
                if (allowed(SleepSessionRecord::class)) safely {
                    for (key in byDay.keys) {
                        val d = LocalDate.parse(key)
                        val r = client.aggregate(AggregateRequest(
                            setOf(SleepSessionRecord.SLEEP_DURATION_TOTAL),
                            TimeRangeFilter.between(d.minusDays(1).atTime(18, 0), d.atTime(18, 0))
                        ))
                        r[SleepSessionRecord.SLEEP_DURATION_TOTAL]?.let { if (!it.isZero) byDay[key]?.put("sleepMin", it.toMinutes()) }
                        r.dataOrigins.forEach { sources[key]?.add(it.packageName) }
                    }
                }

                // HRV and body fat have no built-in daily aggregate: average the readings.
                if (allowed(HeartRateVariabilityRmssdRecord::class)) safely {
                    val recs = client.readRecords(ReadRecordsRequest(HeartRateVariabilityRmssdRecord::class, TimeRangeFilter.between(start, now))).records
                    recs.groupBy { day(it.time) }.forEach { (key, list) ->
                        byDay[key]?.put("hrvMs", Math.round(list.map { it.heartRateVariabilityMillis }.average() * 10) / 10.0)
                        list.forEach { sources[key]?.add(it.metadata.dataOrigin.packageName) }
                    }
                }
                if (allowed(BodyFatRecord::class)) safely {
                    val recs = client.readRecords(ReadRecordsRequest(BodyFatRecord::class, TimeRangeFilter.between(start, now))).records
                    recs.groupBy { day(it.time) }.forEach { (key, list) ->
                        byDay[key]?.put("bodyFatPct", Math.round(list.map { it.percentage.value }.average() * 10) / 10.0)
                        list.forEach { sources[key]?.add(it.metadata.dataOrigin.packageName) }
                    }
                }

                if (allowed(ExerciseSessionRecord::class)) safely {
                    val recs = client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, TimeRangeFilter.between(start, now))).records
                    for (w in recs) {
                        val key = day(w.startTime)
                        val o = byDay[key] ?: continue
                        val wo = JSONObject()
                            .put("type", WORKOUT_NAMES[w.exerciseType] ?: (w.title ?: "workout"))
                            .put("start", w.startTime.toString())
                            .put("end", w.endTime.toString())
                        if (allowed(ActiveCaloriesBurnedRecord::class)) {
                            val kcal = client.aggregate(AggregateRequest(
                                setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL),
                                TimeRangeFilter.between(w.startTime, w.endTime)
                            ))[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]
                            if (kcal != null) wo.put("kcal", Math.round(kcal.inKilocalories))
                        }
                        o.getJSONArray("workouts").put(wo)
                        sources[key]?.add(w.metadata.dataOrigin.packageName)
                    }
                }

                for ((key, o) in byDay) {
                    o.put("sources", JSONArray(sources[key]?.toList() ?: emptyList<String>()))
                    out.put(o)
                }
                out
            }
        } catch (e: Exception) {
            out
        }
    }

    private val DAY: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE

    private fun rangeStart(days: Int): LocalDateTime = LocalDate.now().minusDays((days - 1).toLong()).atStartOfDay()
}
