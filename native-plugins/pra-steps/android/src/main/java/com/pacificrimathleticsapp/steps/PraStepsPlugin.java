package com.pacificrimathleticsapp.steps;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import androidx.activity.result.ActivityResult;

import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

// Two sources, higher per day wins: Health Connect (see HealthConnectSteps
// -- watches, rings and other apps), and the phone's own step sensor below.
//
// Android's step-counter sensor is a single running total since the phone
// last restarted -- there's no per-day history to query (that's Health
// Connect, which needs Google's separate health-data approval). So every
// read saves the total, and the steps since the previous read are added to
// the day(s) they happened on. Steps between two reads that span a night
// are split across the days by waking hours (7am-11pm), since the sensor
// can't say exactly when they happened.
@CapacitorPlugin(
    name = "PraSteps",
    permissions = { @Permission(alias = "activity", strings = { Manifest.permission.ACTIVITY_RECOGNITION }) }
)
public class PraStepsPlugin extends Plugin {
    private static final String PREFS = "pra_steps";
    private static final int KEEP_DAYS = 30;
    private static final int AWAKE_START_HOUR = 7, AWAKE_END_HOUR = 23;

    private SensorManager sensorManager() {
        return (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
    }

    private Sensor stepSensor() {
        SensorManager sm = sensorManager();
        return sm == null ? null : sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
    }

    private String status() {
        if (stepSensor() == null) return "unavailable";
        // ACTIVITY_RECOGNITION only became a runtime permission in Android 10.
        if (Build.VERSION.SDK_INT < 29) return "granted";
        PermissionState st = getPermissionState("activity");
        if (st == PermissionState.GRANTED) return "granted";
        if (st == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    // Health Connect (watch/ring/other-app data): "unavailable" when the
    // phone doesn't have it, "prompt" until its permission screen has been
    // shown once for the current set of data types (HEALTH_ASKED_KEY -- bump
    // it when HealthConnectSteps asks for more, so people who only allowed
    // steps get asked about the rest), then "granted" or "denied".
    private static final String HEALTH_ASKED_KEY = "healthAskedV2";

    private String healthStatus() {
        if (!HealthConnectSteps.isAvailable(getContext())) return "unavailable";
        if (!prefs().getBoolean(HEALTH_ASKED_KEY, false)) return "prompt";
        return HealthConnectSteps.hasPermission(getContext()) ? "granted" : "denied";
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // `status` is "granted" when either source can be read, so the JS side
    // only needs that one field; healthStatus says whether the Health Connect
    // screen still needs showing.
    private JSObject permissionResult() {
        String sensor = status(), health = healthStatus();
        String combined;
        if ("granted".equals(sensor) || "granted".equals(health)) combined = "granted";
        else if ("prompt".equals(sensor) || "prompt".equals(health)) combined = "prompt";
        else if ("denied".equals(sensor) || "denied".equals(health)) combined = "denied";
        else combined = "unavailable";
        JSObject ret = new JSObject();
        ret.put("status", combined);
        ret.put("sensorStatus", sensor);
        ret.put("healthStatus", health);
        return ret;
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        call.resolve(permissionResult());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if ("prompt".equals(status())) { requestPermissionForAlias("activity", call, "permissionCallback"); return; }
        requestHealthPermission(call);
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        requestHealthPermission(call);
    }

    private void requestHealthPermission(PluginCall call) {
        if (!"prompt".equals(healthStatus())) { checkPermission(call); return; }
        prefs().edit().putBoolean(HEALTH_ASKED_KEY, true).apply();
        try {
            startActivityForResult(call, HealthConnectSteps.permissionIntent(getContext()), "healthPermissionCallback");
        } catch (Exception e) {
            checkPermission(call);
        }
    }

    @ActivityCallback
    private void healthPermissionCallback(PluginCall call, ActivityResult result) {
        checkPermission(call);
    }

    @PluginMethod
    public void getDailySteps(PluginCall call) {
        int days = Math.min(Math.max(call.getInt("days", 7), 1), KEEP_DAYS);
        // Health Connect first (runs on Capacitor's plugin thread, not the UI
        // thread), then the phone's own sensor; each day keeps the higher of
        // the two, so steps from a watch-only walk and steps the phone saw
        // before Health Connect was allowed both count.
        Map<String, Long> health = HealthConnectSteps.dailySteps(getContext(), days);
        withSensorReading(call, health, () -> call.resolve(result(days, health)));
    }

    // Full daily health summary for the Health tab (see
    // HealthConnectSteps.dailyHealth for the fields); each day's steps are
    // the higher of Health Connect's and the phone sensor's.
    @PluginMethod
    public void getDailyHealth(PluginCall call) {
        int days = Math.min(Math.max(call.getInt("days", 7), 1), KEEP_DAYS);
        org.json.JSONArray health = HealthConnectSteps.dailyHealth(getContext(), days);
        Map<String, Long> healthSteps = new java.util.HashMap<>();
        for (int i = 0; i < health.length(); i++) {
            JSONObject d = health.optJSONObject(i);
            if (d != null && d.has("steps")) healthSteps.put(d.optString("date"), d.optLong("steps"));
        }
        withSensorReading(call, healthSteps, () -> {
            JSONObject sensorDays = loadDays(prefs());
            JSArray out = new JSArray();
            java.util.Set<String> seen = new java.util.HashSet<>();
            for (int i = 0; i < health.length(); i++) {
                JSONObject d = health.optJSONObject(i);
                if (d == null) continue;
                String key = d.optString("date");
                seen.add(key);
                long steps = Math.max(d.optLong("steps", 0), sensorDays.optLong(key, 0));
                try {
                    if (steps > 0 || d.has("steps") || sensorDays.has(key)) d.put("steps", steps);
                } catch (Exception ignored) {}
                out.put(d);
            }
            // No Health Connect (or nothing in it): the sensor's days alone.
            org.json.JSONArray sensorOnly = result(days, java.util.Collections.emptyMap()).optJSONArray("days");
            if (sensorOnly != null) {
                for (int i = 0; i < sensorOnly.length(); i++) {
                    JSONObject d = sensorOnly.optJSONObject(i);
                    if (d != null && !seen.contains(d.optString("date"))) out.put(d);
                }
            }
            JSObject ret = new JSObject();
            ret.put("days", out);
            call.resolve(ret);
        });
    }

    // Takes a fresh step-sensor reading (when allowed) before `then` runs,
    // so the sensor's saved per-day totals are current. Rejects when neither
    // the sensor nor Health Connect is allowed.
    private void withSensorReading(PluginCall call, Map<String, Long> health, Runnable then) {
        if (!"granted".equals(status())) {
            if (health.isEmpty() && !HealthConnectSteps.hasPermission(getContext())) { call.reject("Step permission not granted", "denied"); return; }
            then.run();
            return;
        }
        SensorManager sm = sensorManager();
        Handler main = new Handler(Looper.getMainLooper());
        final boolean[] done = { false };
        SensorEventListener listener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                if (done[0]) return;
                done[0] = true;
                sm.unregisterListener(this);
                recordReading((long) event.values[0]);
                then.run();
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        sm.registerListener(listener, stepSensor(), SensorManager.SENSOR_DELAY_NORMAL, main);
        // The sensor normally reports its current total right away; if it
        // doesn't, answer with what's already saved instead of hanging.
        main.postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            sm.unregisterListener(listener);
            then.run();
        }, 4000);
    }

    private synchronized void recordReading(long counter) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long lastCounter = prefs.getLong("lastCounter", -1);
        long lastTime = prefs.getLong("lastTime", 0);
        long now = System.currentTimeMillis();
        long bootTime = now - SystemClock.elapsedRealtime();
        JSONObject byDay = loadDays(prefs);

        if (lastCounter < 0) {
            // First reading ever: the total is everything since the restart,
            // which can only be credited to today if the restart was today.
            if (bootTime >= startOfDay(now)) addSteps(byDay, dateKey(now), counter);
        } else if (counter >= lastCounter) {
            distribute(byDay, counter - lastCounter, lastTime, now);
        } else {
            // Phone restarted since the last read: the total started over.
            distribute(byDay, counter, Math.max(lastTime, bootTime), now);
        }
        if (!byDay.has(dateKey(now))) addSteps(byDay, dateKey(now), 0);
        prune(byDay, now);
        prefs.edit()
            .putLong("lastCounter", counter)
            .putLong("lastTime", now)
            .putString("days", byDay.toString())
            .apply();
    }

    private void distribute(JSONObject byDay, long steps, long from, long to) {
        if (steps <= 0) return;
        if (from <= 0 || from >= to || dateKey(from).equals(dateKey(to))) {
            addSteps(byDay, dateKey(to), steps);
            return;
        }
        List<Long> dayStarts = new ArrayList<>();
        List<Long> weights = new ArrayList<>();
        long total = 0;
        for (long day = startOfDay(from); day <= to; day = nextDay(day)) {
            long awakeStart = atHour(day, AWAKE_START_HOUR), awakeEnd = atHour(day, AWAKE_END_HOUR);
            long w = Math.max(0, Math.min(to, awakeEnd) - Math.max(from, awakeStart));
            dayStarts.add(day);
            weights.add(w);
            total += w;
        }
        if (total == 0) { addSteps(byDay, dateKey(to), steps); return; }
        long given = 0;
        for (int i = 0; i < dayStarts.size(); i++) {
            long share = i == dayStarts.size() - 1 ? steps - given : Math.round((double) steps * weights.get(i) / total);
            given += share;
            if (share > 0) addSteps(byDay, dateKey(dayStarts.get(i)), share);
        }
    }

    private JSObject result(int days, Map<String, Long> health) {
        JSONObject byDay = loadDays(prefs());
        List<JSObject> list = new ArrayList<>();
        long day = startOfDay(System.currentTimeMillis());
        for (int i = 0; i < days; i++) {
            String key = dateKey(day);
            if (byDay.has(key) || health.containsKey(key)) {
                long fromHealth = health.containsKey(key) ? health.get(key) : 0;
                JSObject o = new JSObject();
                o.put("date", key);
                o.put("steps", Math.max(byDay.optLong(key, 0), fromHealth));
                list.add(o);
            }
            day = startOfDay(day - 1);
        }
        Collections.reverse(list);
        JSArray arr = new JSArray();
        for (JSObject o : list) arr.put(o);
        JSObject ret = new JSObject();
        ret.put("days", arr);
        return ret;
    }

    private static JSONObject loadDays(SharedPreferences prefs) {
        try { return new JSONObject(prefs.getString("days", "{}")); } catch (Exception e) { return new JSONObject(); }
    }

    private static void addSteps(JSONObject byDay, String key, long steps) {
        try { byDay.put(key, byDay.optLong(key, 0) + steps); } catch (Exception ignored) {}
    }

    private static void prune(JSONObject byDay, long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(startOfDay(now));
        c.add(Calendar.DAY_OF_MONTH, -KEEP_DAYS);
        String cutoff = dateKey(c.getTimeInMillis());
        List<String> old = new ArrayList<>();
        for (Iterator<String> it = byDay.keys(); it.hasNext(); ) {
            String k = it.next();
            if (k.compareTo(cutoff) < 0) old.add(k);
        }
        for (String k : old) byDay.remove(k);
    }

    private static String dateKey(long millis) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(millis);
    }

    private static long startOfDay(long millis) {
        return atHour(millis, 0);
    }

    private static long atHour(long millis, int hour) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(millis);
        c.set(Calendar.HOUR_OF_DAY, hour);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    private static long nextDay(long dayStart) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(dayStart);
        c.add(Calendar.DAY_OF_MONTH, 1);
        return c.getTimeInMillis();
    }
}
