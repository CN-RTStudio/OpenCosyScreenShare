package com.rtstu.screenshare.cosy.sender;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CosyNetworkPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
