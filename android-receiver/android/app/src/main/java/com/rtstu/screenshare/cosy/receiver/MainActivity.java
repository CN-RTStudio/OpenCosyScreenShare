package com.rtstu.screenshare.cosy.receiver;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CosyNetworkPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
