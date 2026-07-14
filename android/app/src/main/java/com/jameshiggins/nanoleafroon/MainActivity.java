package com.jameshiggins.nanoleafroon;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

import androidx.appcompat.app.AppCompatActivity;

/**
 * Full-screen WebView host for the Nanoleaf Roon visualizer web app.
 *
 * On first run it asks for the extension's companion-app URL
 * (e.g. http://192.168.1.10:8787) and remembers it. D-pad keys are forwarded
 * to the web app via window.__tvKey() so the on-screen controls work with the
 * Shield remote regardless of WebView key quirks.
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREFS = "nlr";
    private static final String KEY_URL = "serverUrl";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setWebViewClient(new WebViewClient());
        web.setBackgroundColor(0xFF000000);
        web.setFocusable(true);
        web.requestFocus();

        String url = prefs().getString(KEY_URL, null);
        if (url == null || url.isEmpty()) {
            promptForUrl();
        } else {
            web.loadUrl(url);
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void promptForUrl() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("http://192.168.1.10:8787");
        String existing = prefs().getString(KEY_URL, "http://192.168.1.10:8787");
        input.setText(existing);
        new AlertDialog.Builder(this)
                .setTitle("Extension address")
                .setMessage("Enter the URL the extension prints on startup (host:port of the companion app).")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("Connect", (d, w) -> {
                    String url = input.getText().toString().trim();
                    prefs().edit().putString(KEY_URL, url).apply();
                    web.loadUrl(url);
                })
                .show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersive();
    }

    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    /** Forward the Shield remote's D-pad to the web app's controls. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            String name = keyName(e.getKeyCode());
            if (name != null) {
                web.evaluateJavascript("window.__tvKey && window.__tvKey('" + name + "')", null);
                // consume directional/OK; let BACK fall through so the user can exit / re-enter setup
                if (!name.equals("back")) return true;
            }
            // long-press MENU re-opens the address prompt
            if (e.getKeyCode() == KeyEvent.KEYCODE_MENU) {
                promptForUrl();
                return true;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    private String keyName(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP: return "up";
            case KeyEvent.KEYCODE_DPAD_DOWN: return "down";
            case KeyEvent.KEYCODE_DPAD_LEFT: return "left";
            case KeyEvent.KEYCODE_DPAD_RIGHT: return "right";
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER: return "ok";
            case KeyEvent.KEYCODE_MEDIA_NEXT: return "next";
            case KeyEvent.KEYCODE_BACK: return "back";
            default: return null;
        }
    }

    @Override
    public void onBackPressed() {
        // If the controls are open the web app handles Back (closes them). Otherwise leave the app.
        moveTaskToBack(true);
    }
}
