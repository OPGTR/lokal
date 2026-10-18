package com.lokal.music;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;

/**
 * A SpotiFLAC addon's verification page (a captcha, a sign-in), like the
 * desktop app's addon window: it may only visit the addon's own domains, and
 * when it reaches the addon's callback address the window closes and hands
 * Lokal that address and the cookies the page set.
 */
public class AddonAuthActivity extends Activity {
    static final String EXTRA_URL = "url";
    static final String EXTRA_CALLBACK = "callback";
    static final String EXTRA_DOMAINS = "domains";
    static final String RESULT_URL = "callbackUrl";
    static final String RESULT_COOKIES = "cookies";

    private WebView web;
    private Uri callback;
    private ArrayList<String> domains;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra(EXTRA_URL);
        String cb = getIntent().getStringExtra(EXTRA_CALLBACK);
        domains = getIntent().getStringArrayListExtra(EXTRA_DOMAINS);
        if (domains == null) domains = new ArrayList<>();
        callback = cb != null ? Uri.parse(cb) : null;
        if (url == null) { finish(); return; }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0A0A0A"));
        root.setFitsSystemWindows(true);
        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return inspect(request.getUrl());
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        setTitle("Lokal");
        web.loadUrl(url);
    }

    /** True: don't load it (the callback, or a page outside the addon). */
    private boolean inspect(Uri url) {
        if (callback != null && same(url, callback)) {
            finishWith(url);
            return true;
        }
        String scheme = url.getScheme();
        if (!"https".equalsIgnoreCase(scheme)) return true;
        return !allowed(url.getHost());
    }

    private static boolean same(Uri a, Uri b) {
        return eq(a.getScheme(), b.getScheme()) && eq(a.getHost(), b.getHost()) && eq(path(a), path(b));
    }

    private static String path(Uri u) {
        String p = u.getPath();
        return p == null || p.isEmpty() ? "/" : p;
    }

    private static boolean eq(String a, String b) {
        return a == null ? b == null : a.equalsIgnoreCase(b);
    }

    private boolean allowed(String host) {
        if (host == null) return false;
        host = host.toLowerCase();
        for (String d : domains) {
            String domain = d.toLowerCase();
            if (domain.startsWith("*.")) {
                if (host.endsWith(domain.substring(1)) && !host.equals(domain.substring(2))) return true;
            } else if (host.equals(domain)) {
                return true;
            }
        }
        return false;
    }

    private void finishWith(Uri url) {
        JSONArray cookies = new JSONArray();
        CookieManager manager = CookieManager.getInstance();
        manager.flush();
        for (String d : domains) {
            String host = d.startsWith("*.") ? d.substring(2) : d;
            String header = manager.getCookie("https://" + host + "/");
            if (header == null) continue;
            for (String part : header.split(";")) {
                int eqAt = part.indexOf('=');
                if (eqAt <= 0) continue;
                try {
                    JSONObject cookie = new JSONObject();
                    cookie.put("name", part.substring(0, eqAt).trim());
                    cookie.put("value", part.substring(eqAt + 1).trim());
                    cookie.put("domain", host);
                    cookie.put("path", "/");
                    cookie.put("secure", true);
                    cookies.put(cookie);
                } catch (Exception ignored) {}
            }
        }
        Intent data = new Intent();
        data.putExtra(RESULT_URL, url.toString());
        data.putExtra(RESULT_COOKIES, cookies.toString());
        setResult(RESULT_OK, data);
        finish();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
