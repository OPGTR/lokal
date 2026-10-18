package com.lokal.music;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

/**
 * What the Lokal interface needs from Android: access to the music files,
 * a folder picker that gives a real path (Lokal's server reads files by path),
 * opening links in the browser, restarting.
 */
@CapacitorPlugin(
    name = "LokalNative",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO, Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class LokalNativePlugin extends Plugin {

    private boolean hasMediaAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return granted(Manifest.permission.READ_MEDIA_AUDIO);
        }
        return granted(Manifest.permission.READ_EXTERNAL_STORAGE);
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return granted(Manifest.permission.WRITE_EXTERNAL_STORAGE);
    }

    private JSObject accessState() {
        JSObject result = new JSObject();
        result.put("media", hasMediaAccess());
        result.put("allFiles", hasAllFilesAccess());
        result.put("sdk", Build.VERSION.SDK_INT);
        result.put("musicDir", Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC).getAbsolutePath());
        return result;
    }

    @PluginMethod
    public void storageAccess(PluginCall call) {
        call.resolve(accessState());
    }

    @PluginMethod
    public void requestMediaAccess(PluginCall call) {
        if (hasMediaAccess()) {
            call.resolve(accessState());
            return;
        }
        String alias = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "storage";
        requestPermissionForAlias(alias, call, "onMediaAccess");
    }

    @PermissionCallback
    private void onMediaAccess(PluginCall call) {
        // Android 13+: also ask to show the playback notification (media
        // notifications work without it, but some phones hide them).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "onNotifications");
            return;
        }
        call.resolve(accessState());
    }

    @PermissionCallback
    private void onNotifications(PluginCall call) {
        call.resolve(accessState());
    }

    /** "All files access": needed to edit tags or delete songs, not to play them. */
    @PluginMethod
    public void requestAllFilesAccess(PluginCall call) {
        if (hasAllFilesAccess()) {
            call.resolve(accessState());
            return;
        }
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        }
        try {
            startActivityForResult(call, intent, "onAllFilesAccess");
        } catch (ActivityNotFoundException e) {
            try {
                startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION), "onAllFilesAccess");
            } catch (ActivityNotFoundException again) {
                call.reject("This phone has no setting for all-files access");
            }
        }
    }

    @ActivityCallback
    private void onAllFilesAccess(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve(accessState());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** The system folder picker, answered with a filesystem path. */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            File music = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC);
            Uri initial = DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:" + music.getName());
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, initial);
        }
        try {
            startActivityForResult(call, intent, "onFolderPicked");
        } catch (ActivityNotFoundException e) {
            call.reject("No folder picker on this phone");
        }
    }

    @ActivityCallback
    private void onFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            JSObject none = new JSObject();
            none.put("path", null);
            call.resolve(none);
            return;
        }
        String path = treeUriToPath(data.getData());
        if (path == null) {
            call.reject("This folder can't be used: choose a folder in the phone's storage or on the SD card.");
            return;
        }
        JSObject picked = new JSObject();
        picked.put("path", path);
        call.resolve(picked);
    }

    /**
     * content://com.android.externalstorage.documents/tree/primary%3AMusic%2FRock
     *   -> /storage/emulated/0/Music/Rock
     * content://.../tree/1234-ABCD%3AMusic -> /storage/1234-ABCD/Music
     */
    static String treeUriToPath(Uri uri) {
        String docId;
        try {
            docId = DocumentsContract.getTreeDocumentId(uri);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (docId == null) return null;
        String authority = uri.getAuthority();
        if ("com.android.providers.downloads.documents".equals(authority)) {
            if (docId.startsWith("raw:")) return docId.substring(4);
            return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getAbsolutePath();
        }
        if (!"com.android.externalstorage.documents".equals(authority)) return null;
        int colon = docId.indexOf(':');
        String volume = colon >= 0 ? docId.substring(0, colon) : docId;
        String relative = colon >= 0 ? docId.substring(colon + 1) : "";
        String base;
        if ("primary".equalsIgnoreCase(volume)) {
            base = Environment.getExternalStorageDirectory().getAbsolutePath();
        } else if ("home".equalsIgnoreCase(volume)) {
            base = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS).getAbsolutePath();
        } else {
            base = "/storage/" + volume;
        }
        String path = relative.isEmpty() ? base : base + "/" + relative;
        while (path.endsWith("/") && path.length() > 1) path = path.substring(0, path.length() - 1);
        return path;
    }

    /** A SpotiFLAC addon's verification page, in its own window (AddonAuthActivity). */
    @PluginMethod
    public void addonAuth(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("No verification page");
            return;
        }
        Intent intent = new Intent(getContext(), AddonAuthActivity.class);
        intent.putExtra(AddonAuthActivity.EXTRA_URL, url);
        intent.putExtra(AddonAuthActivity.EXTRA_CALLBACK, call.getString("callback"));
        java.util.ArrayList<String> domains = new java.util.ArrayList<>();
        try {
            com.getcapacitor.JSArray list = call.getArray("domains");
            if (list != null) for (Object d : list.toList()) domains.add(String.valueOf(d));
        } catch (org.json.JSONException ignored) {}
        intent.putStringArrayListExtra(AddonAuthActivity.EXTRA_DOMAINS, domains);
        startActivityForResult(call, intent, "onAddonAuth");
    }

    @ActivityCallback
    private void onAddonAuth(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject out = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() == android.app.Activity.RESULT_OK && data != null) {
            out.put("url", data.getStringExtra(AddonAuthActivity.RESULT_URL));
            try {
                out.put("cookies", new com.getcapacitor.JSArray(data.getStringExtra(AddonAuthActivity.RESULT_COOKIES)));
            } catch (org.json.JSONException e) {
                out.put("cookies", new com.getcapacitor.JSArray());
            }
        } else {
            out.put("url", null);
            out.put("cookies", new com.getcapacitor.JSArray());
        }
        call.resolve(out);
    }

    /** Is this app installed (and visible: see <queries> in the manifest)? */
    @PluginMethod
    public void appInstalled(PluginCall call) {
        String pkg = call.getString("package");
        JSObject out = new JSObject();
        out.put("installed", pkg != null && getContext().getPackageManager().getLaunchIntentForPackage(pkg) != null);
        call.resolve(out);
    }

    /** Opens another app (the SpotiFLAC app, to download something). */
    @PluginMethod
    public void openApp(PluginCall call) {
        String pkg = call.getString("package");
        Intent intent = pkg == null ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
        if (intent == null) {
            call.reject("This app isn't installed");
            return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:"))) {
            call.reject("Unsupported link");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app can open this link");
        }
    }

    @PluginMethod
    public void appInfo(PluginCall call) {
        JSObject info = new JSObject();
        try {
            PackageInfo pkg = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            info.put("version", pkg.versionName);
        } catch (PackageManager.NameNotFoundException ignored) {}
        info.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(info);
    }

    /** Restarts the app (its embedded Node.js can only start once per process). */
    @PluginMethod
    public void restartApp(PluginCall call) {
        call.resolve();
        Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        if (intent == null) return;
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        getContext().startActivity(Intent.makeRestartActivityTask(intent.getComponent()));
        Runtime.getRuntime().exit(0);
    }
}
