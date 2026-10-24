package com.pacificrimathleticsapp.steps;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

// Health Connect requires an app to explain how it uses health data: its
// permission screen links here ("privacy policy"). Opens the app's privacy
// policy page in the browser and closes.
public class HealthPermissionsRationaleActivity extends Activity {
    private static final String PRIVACY_URL = "https://app-production-3c6a1.up.railway.app/privacy-policy.html";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL)));
        } catch (Exception ignored) {}
        finish();
    }
}
