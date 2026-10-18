package com.lokal.music;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LokalNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
