package com.rtstu.screenshare.cosy.sender;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * 前台服务, 用于 MediaProjection 屏幕捕获 (Android 14+ 强制要求).
 * 当服务进入前台后, 通过静态回调通知插件可以开始创建 MediaProjection.
 */
public class ScreenCaptureService extends Service {

    private static final String TAG = "CosyLog";
    private static final String CHANNEL_ID = "cosy_screen_capture";
    private static final int NOTIFICATION_ID = 20250626;

    /** 服务进入前台后的回调 (由插件设置) */
    public static Runnable onReady = null;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        Log.i(TAG, "ScreenCaptureService onCreate");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "ScreenCaptureService onStartCommand");

        try {
            Notification notification = buildNotification();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ 必须指定前台服务类型
                startForeground(NOTIFICATION_ID, notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
            Log.i(TAG, "startForeground 成功");
        } catch (Throwable t) {
            Log.e(TAG, "startForeground 失败: " + t.getMessage(), t);
            // 如果 startForeground 失败, 直接停止服务避免系统杀进程
            stopSelf();
            return START_NOT_STICKY;
        }

        // 通知插件已进入前台, 可以安全创建 MediaProjection
        if (onReady != null) {
            Runnable r = onReady;
            onReady = null;
            try {
                r.run();
            } catch (Throwable t) {
                Log.e(TAG, "onReady 回调异常: " + t.getMessage(), t);
                stopSelf();
            }
        }

        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "ScreenCaptureService onDestroy");
        super.onDestroy();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "屏幕投射", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("屏幕投射正在进行中");
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Cosy 传屏")
                .setContentText("正在投射屏幕...")
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }
}
