package com.pacificrimathleticsapp.steps

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateGroupByPeriodRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.runBlocking
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.Period
import java.time.format.DateTimeFormatter

// Health Connect is Android's shared health hub -- Samsung Health, Fitbit,
// Oura, Pixel/Galaxy Watch etc. all sync their steps into it, de-duplicated,
// so reading it picks up steps walked with only a watch or ring on. Its API is
// all Kotlin suspend functions; these blocking wrappers are only ever called
// from Capacitor's plugin thread (never the main thread).
object HealthConnectSteps {
    private const val PROVIDER = "com.google.android.apps.healthdata"
    private val READ_STEPS = HealthPermission.getReadPermission(StepsRecord::class)

    @JvmStatic
    fun isAvailable(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < 28) return false
        return try {
            HealthConnectClient.getSdkStatus(context, PROVIDER) == HealthConnectClient.SDK_AVAILABLE
        } catch (e: Exception) {
            false
        }
    }

    @JvmStatic
    fun hasPermission(context: Context): Boolean {
        if (!isAvailable(context)) return false
        return try {
            runBlocking {
                HealthConnectClient.getOrCreate(context).permissionController.getGrantedPermissions().contains(READ_STEPS)
            }
        } catch (e: Exception) {
            false
        }
    }

    @JvmStatic
    fun permissionIntent(context: Context): Intent =
        PermissionController.createRequestPermissionResultContract().createIntent(context, setOf(READ_STEPS))

    // date ("yyyy-MM-dd") -> that day's step total, for the last `days` days
    // including today. Empty when unavailable / not permitted / it fails.
    @JvmStatic
    fun dailySteps(context: Context, days: Int): Map<String, Long> {
        if (!hasPermission(context)) return emptyMap()
        return try {
            runBlocking {
                val start = LocalDate.now().minusDays((days - 1).toLong()).atStartOfDay()
                val groups = HealthConnectClient.getOrCreate(context).aggregateGroupByPeriod(
                    AggregateGroupByPeriodRequest(
                        metrics = setOf(StepsRecord.COUNT_TOTAL),
                        timeRangeFilter = TimeRangeFilter.between(start, LocalDateTime.now()),
                        timeRangeSlicer = Period.ofDays(1)
                    )
                )
                val fmt = DateTimeFormatter.ISO_LOCAL_DATE
                groups.mapNotNull { g ->
                    g.result[StepsRecord.COUNT_TOTAL]?.let { fmt.format(g.startTime) to it }
                }.toMap()
            }
        } catch (e: Exception) {
            emptyMap()
        }
    }
}
