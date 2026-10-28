package com.handyhub.customer;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * The ONE place the status bar, navigation bar, display cut-out and keyboard
     * are accounted for: the WebView's container is padded by the insets Android
     * actually reports for this window, on every Android version.
     *
     * Capacitor's own SystemBars handling (disabled in capacitor.config.json,
     * plugins.SystemBars.insetsHandling = "disable") pads only on Android 15+
     * (`SDK_INT >= VANILLA_ICE_CREAM`) and re-decides per page, after
     * DOMContentLoaded, from an asynchronous check of the viewport meta. Any
     * window drawn behind the status bar below Android 15, or a page judged
     * "viewport-fit=cover", got no padding at all and the app drew under the
     * clock, battery and signal icons.
     *
     * A window that is not edge-to-edge reports a top inset of 0 here, so this
     * never double-pads; one that is reports the real bar height, so the page
     * always starts below it. The padding shows the window background
     * (@color/fx_system_bar, the app's #FEFEFE) behind the bars.
     */
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Local plugins are registered before the bridge is created.
        // GoogleSignInPlugin: native Google sign-in (the web flow cannot run in
        // a WebView — see that class).
        registerPlugin(GoogleSignInPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null || getBridge().getWebView() == null) return;   // no_webview layout

        View container = (View) getBridge().getWebView().getParent();
        ViewCompat.setOnApplyWindowInsetsListener(container, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            // Handed on as zero rather than CONSUMED: the WebView must not apply
            // them a second time, and CONSUMED stops later inset updates
            // (https://issues.chromium.org/issues/461332423).
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
        ViewCompat.requestApplyInsets(container);
    }
}
