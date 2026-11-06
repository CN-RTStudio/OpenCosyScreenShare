package com.rtstu.screenshare.cosy.sender;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.Manifest;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import android.graphics.Point;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;
import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraVideoCapturer;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.audio.JavaAudioDeviceModule;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoDecoderFactory;
import org.webrtc.VideoEncoderFactory;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Base64;

@CapacitorPlugin(name = "CosyNetwork", permissions = {
    @Permission(alias = "audio", strings = { Manifest.permission.RECORD_AUDIO })
})
public class CosyNetworkPlugin extends Plugin {

    private static final String TAG = "CosyLog";
    private static final int MIN_SDK_VERSION = 2;
    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS = 5000;

    // ---- TCP ----
    private Socket clientSocket = null;
    private OutputStream socketOut = null;
    private Thread receiverThread = null;
    private volatile boolean running = false;

    // ---- 原生 WebRTC (屏幕投射模式) ----
    private volatile boolean nativeShareActive = false;
    private EglBase eglBase = null;
    private PeerConnectionFactory factory = null;
    private PeerConnection peerConnection = null;
    private VideoCapturer videoCapturer = null;
    private VideoSource videoSource = null;
    private SurfaceTextureHelper surfaceHelper = null;
    private VideoTrack videoTrack = null;
    private AudioSource audioSource = null;
    private AudioTrack audioTrack = null;
    private JavaAudioDeviceModule audioDeviceModule = null;

    // MediaProjection 权限
    private PluginCall pendingScreenCall = null;
    private int mpResultCode = 0;
    private Intent mpData = null;
    // 用于系统音频捕获的独立 MediaProjection (与视频 capturer 的分开)
    private MediaProjection audioMediaProjection = null;

    @Override
    public void load() {
        super.load();
        // 插件加载时清理可能残留的前台服务 (上次崩溃遗留的 MediaProjection)
        try {
            getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
        } catch (Exception e) {}
        nativeLog("插件已加载, 残留服务已清理");
    }

    // ==================== 连接 ====================

    @PluginMethod
    public void connect(PluginCall call) {
        final String code = call.getString("code");
        if (code == null || code.trim().isEmpty()) {
            call.reject("传屏码不能为空");
            return;
        }

        final String[] parsed = parseCode(code.trim());
        if (parsed == null) {
            call.reject("传屏码格式无效");
            return;
        }

        final String ip = parsed[0];
        final int port = Integer.parseInt(parsed[1]);

        Log.i(TAG, "解析传屏码: " + ip + ":" + port);

        new Thread(() -> {
            try {
                stopExistingConnection();

                running = true;
                clientSocket = new Socket();
                clientSocket.connect(new InetSocketAddress(ip, port), CONNECT_TIMEOUT_MS);
                clientSocket.setSoTimeout(READ_TIMEOUT_MS);

                socketOut = clientSocket.getOutputStream();
                final BufferedReader reader = new BufferedReader(new InputStreamReader(clientSocket.getInputStream()));

                Log.i(TAG, "TCP 已连接到 " + ip + ":" + port);

                // Step 1: INIT
                socketOut.write("INIT\n".getBytes());
                socketOut.flush();
                Log.i(TAG, "已发送 INIT");

                // Step 2: STATUS:0
                String line = reader.readLine();
                if (line == null) {
                    call.reject("连接已关闭 (STATUS 阶段)");
                    cleanupConnection();
                    return;
                }
                line = line.trim();
                Log.i(TAG, "收到: " + line);

                if (!line.startsWith("STATUS:")) {
                    call.reject("期望 STATUS 响应, 收到: " + line);
                    cleanupConnection();
                    return;
                }
                int status = parseIntSafe(line.substring(7), -1);
                if (status != 0) {
                    call.reject("连接被拒绝 (status " + status + ")");
                    cleanupConnection();
                    return;
                }

                // Step 3: CONNECTED
                socketOut.write("CONNECTED\n".getBytes());
                socketOut.flush();
                Log.i(TAG, "已发送 CONNECTED");

                // Step 4: INFO 请求
                socketOut.write("INFO\n".getBytes());
                socketOut.flush();
                Log.i(TAG, "已发送 INFO 请求");

                // Step 5: INFO:sdk|version|os
                line = reader.readLine();
                if (line == null) {
                    call.reject("连接已关闭 (INFO 阶段)");
                    cleanupConnection();
                    return;
                }
                line = line.trim();
                Log.i(TAG, "收到: " + line);

                if (!line.startsWith("INFO:")) {
                    call.reject("期望 INFO 响应, 收到: " + line);
                    cleanupConnection();
                    return;
                }

                String infoStr = line.substring(5);
                String[] parts = infoStr.split("\\|");
                if (parts.length < 3) {
                    call.reject("INFO 格式无效: " + infoStr);
                    cleanupConnection();
                    return;
                }

                int sdk = parseIntSafe(parts[0], -1);
                String version = parts[1];
                String osName = parts[2];

                if (sdk < MIN_SDK_VERSION) {
                    call.reject("SDK 版本过低 (收到 " + sdk + ", 需要 >= " + MIN_SDK_VERSION + ")");
                    cleanupConnection();
                    return;
                }

                Log.i(TAG, "连接成功: sdk=" + sdk + " version=" + version + " os=" + osName);

                clientSocket.setSoTimeout(0);

                // 启动接收线程 (信令路由)
                startReceiverThread(reader);

                JSObject ret = new JSObject();
                ret.put("sdk", sdk);
                ret.put("version", version);
                ret.put("os", osName);
                ret.put("ip", ip);
                call.resolve(ret);

            } catch (Exception e) {
                Log.e(TAG, "connect 失败", e);
                cleanupConnection();
                call.reject("连接失败: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        new Thread(() -> {
            stopNativeShare();
            stopExistingConnection();
            notifyConnectionStatus(false);
            call.resolve();
        }).start();
    }

    /** JS 摄像头模式发送信令 */
    @PluginMethod
    public void sendSignal(PluginCall call) {
        String payload = call.getString("payload");
        if (payload != null && socketOut != null) {
            sendTcpLine("SIGNAL:" + payload);
        }
        call.resolve();
    }

    // ==================== 屏幕投射 (原生 WebRTC) ====================

    @PluginMethod
    public void startScreenShare(PluginCall call) {
        nativeLog("startScreenShare 调用");
        if (clientSocket == null || socketOut == null) {
            call.reject("未连接到接收端");
            return;
        }

        // 先检查录音权限
        if (getPermissionState("audio") != PermissionState.GRANTED) {
            nativeLog("请求录音权限");
            requestPermissionForAlias("audio", call, "onAudioPermissionResult");
            return;
        }

        doStartScreenShare(call);
    }

    @PermissionCallback
    private void onAudioPermissionResult(PluginCall call) {
        if (getPermissionState("audio") == PermissionState.GRANTED) {
            nativeLog("录音权限已授予");
            doStartScreenShare(call);
        } else {
            nativeLog("录音权限被拒绝, 继续无音频投射");
            // 不拒绝, 继续无音频模式
            doStartScreenShare(call);
        }
    }

    private void doStartScreenShare(PluginCall call) {
        pendingScreenCall = call;

        MediaProjectionManager mpm = (MediaProjectionManager) getContext()
                .getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("系统不支持 MediaProjection");
            return;
        }

        nativeLog("请求 MediaProjection 权限");
        Intent captureIntent = mpm.createScreenCaptureIntent();
        startActivityForResult(call, captureIntent, "onMediaProjectionResult");
    }

    @ActivityCallback
    private void onMediaProjectionResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            mpResultCode = result.getResultCode();
            mpData = result.getData();
            nativeLog("MediaProjection 权限已获取, 启动前台服务");

            // 先清理可能残留的上次 MediaProjection (防止崩溃后重开冲突)
            stopNativeShare();
            try {
                getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
            } catch (Exception e) {}

            // 启动前台服务 (Android 14+ 要求), 服务就绪后创建 WebRTC
            ScreenCaptureService.onReady = () -> {
                try {
                    Activity activity = getActivity();
                    if (activity == null) {
                        nativeLog("⚠️ Activity 为 null, 无法启动屏幕投射");
                        stopNativeShare();
                        call.reject("Activity 不可用");
                        return;
                    }
                    activity.runOnUiThread(() -> {
                        try {
                            startNativeScreenCapture(call);
                        } catch (Throwable t) {
                            nativeLog("⚠️ startNativeScreenCapture 崩溃: " + t.getClass().getSimpleName() + ": " + t.getMessage());
                            stopNativeShare();
                            call.reject("屏幕投射崩溃: " + t.getMessage());
                        }
                    });
                } catch (Throwable t) {
                    nativeLog("⚠️ onReady 回调异常: " + t.getMessage());
                    stopNativeShare();
                }
            };

            try {
                Intent serviceIntent = new Intent(getContext(), ScreenCaptureService.class);
                getContext().startForegroundService(serviceIntent);
            } catch (Throwable t) {
                nativeLog("⚠️ startForegroundService 失败: " + t.getMessage());
                call.reject("无法启动前台服务: " + t.getMessage());
            }
        } else {
            nativeLog("MediaProjection 权限被拒绝");
            pendingScreenCall = null;
            call.reject("屏幕投射权限被拒绝");
        }
    }

    private void startNativeScreenCapture(PluginCall call) {
        try {
            nativeLog("初始化原生 WebRTC (屏幕投射)");

            initWebRTCFactory();
            nativeLog("WebRTC factory 初始化完成");

            // 创建 PeerConnection
            createPeerConnection();
            nativeLog("PeerConnection 创建完成");

            // 创建 ScreenCapturerAndroid (需要 MediaProjection.Callback)
            videoCapturer = new ScreenCapturerAndroid(mpData, new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    nativeLog("MediaProjection 被停止");
                    stopNativeShare();
                    notifyConnectionStatus(false);
                }
            });
            surfaceHelper = SurfaceTextureHelper.create("ScreenCapture", eglBase.getEglBaseContext());
            videoSource = factory.createVideoSource(videoCapturer.isScreencast());
            videoCapturer.initialize(surfaceHelper, getContext(), videoSource.getCapturerObserver());

            // 获取屏幕尺寸
            WindowManager wm = (WindowManager) getContext().getSystemService(Context.WINDOW_SERVICE);
            Point size = new Point();
            wm.getDefaultDisplay().getRealSize(size);
            DisplayMetrics metrics = getContext().getResources().getDisplayMetrics();
            int width = size.x;
            int height = size.y;
            int density = metrics.densityDpi;

            nativeLog("屏幕尺寸: " + width + "x" + height + " density=" + density);
            videoCapturer.startCapture(width, height, 30);
            nativeLog("startCapture 已调用");

            // 创建 VideoTrack 并用 addTrack + streamIds (Unified Plan 下 addStream 会 abort)
            // 传入 streamIds 让接收端 ontrack 的 event.streams 非空
            videoTrack = factory.createVideoTrack("ARDAMSv0", videoSource);
            peerConnection.addTrack(videoTrack, java.util.Collections.singletonList("ARDAMS"));
            nativeLog("VideoTrack 已添加 (addTrack + streamId=ARDAMS)");

            // 创建 AudioTrack (WebRTC 内部会启动 AudioRecord, onWebRtcAudioRecordStart 回调中替换为系统音频)
            try {
                // 为系统音频捕获创建独立的 MediaProjection
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    MediaProjectionManager mpm = (MediaProjectionManager) getContext()
                            .getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                    if (mpm != null && mpResultCode != 0 && mpData != null) {
                        audioMediaProjection = mpm.getMediaProjection(mpResultCode, mpData);
                        nativeLog("系统音频 MediaProjection 已创建");
                    }
                }

                audioSource = factory.createAudioSource(new MediaConstraints());
                audioTrack = factory.createAudioTrack("ARDAMSa0", audioSource);
                peerConnection.addTrack(audioTrack, java.util.Collections.singletonList("ARDAMS"));
                nativeLog("AudioTrack 已添加");
            } catch (Exception e) {
                nativeLog("AudioTrack 创建失败 (无音频): " + e.getMessage());
            }

            nativeShareActive = true;
            nativeLog("nativeShareActive=true, 开始创建 Offer");

            // 无额外约束 (与 Electron 发送端一致)
            MediaConstraints constraints = new MediaConstraints();

            nativeLog("createOffer 即将调用");

            // 超时检测: 5 秒内回调未触发则记录
            final java.util.concurrent.atomic.AtomicBoolean offerDone = new java.util.concurrent.atomic.AtomicBoolean(false);
            new Thread(() -> {
                try { Thread.sleep(5000); } catch (InterruptedException e) {}
                if (!offerDone.get()) {
                    nativeLog("⚠️ createOffer 5 秒未回调, 可能 WebRTC 线程卡死或 capturer 未就绪");
                    nativeLog("capturer frames=" + (videoCapturer != null ? videoCapturer.hashCode() : "null"));
                }
            }).start();

            peerConnection.createOffer(new SdpObserver() {
                @Override
                public void onCreateSuccess(SessionDescription sdp) {
                    offerDone.set(true);
                    nativeLog("Offer 创建成功 (sdp 长度=" + sdp.description.length() + "), 设置 LocalDescription");
                    peerConnection.setLocalDescription(new SdpObserver() {
                        @Override
                        public void onSetSuccess() {
                            nativeLog("LocalDescription 设置成功, 发送 offer 信令");
                            sendSignalViaTcp("offer", sdp.description, null);
                        }

                        @Override
                        public void onSetFailure(String error) {
                            nativeLog("setLocalDescription 失败: " + error);
                        }

                        @Override
                        public void onCreateSuccess(SessionDescription sdp) {}
                        @Override
                        public void onCreateFailure(String error) {}
                    }, sdp);
                }

                @Override
                public void onCreateFailure(String error) {
                    offerDone.set(true);
                    nativeLog("createOffer 失败: " + error);
                }

                @Override
                public void onSetSuccess() {}
                @Override
                public void onSetFailure(String error) {}
            }, constraints);

            nativeLog("createOffer 已调用, 等待回调...");

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);

        } catch (Throwable e) {
            nativeLog("⚠️ startNativeScreenCapture 异常: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            stopNativeShare();
            try {
                getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
            } catch (Exception ex) {}
            call.reject("屏幕投射启动失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopShare(PluginCall call) {
        Log.i(TAG, "stopShare 调用");
        stopNativeShare();
        if (call != null) call.resolve();
    }

    /**
     * 用 AudioPlaybackCaptureConfiguration 替换 WebRTC 内部的麦克风 AudioRecord
     * 通过反射访问 WebRtcAudioRecord 的 audioRecord 字段, 在 AudioRecordThread 启动前替换
     */
    private void replaceMicWithSystemAudio() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            nativeLog("Android < 10, 不支持系统音频捕获, 使用麦克风");
            return;
        }
        if (audioMediaProjection == null) {
            nativeLog("audioMediaProjection 为 null, 使用麦克风");
            return;
        }
        try {
            // 1. 获取 JavaAudioDeviceModule.audioInput (WebRtcAudioRecord)
            java.lang.reflect.Field audioInputField = JavaAudioDeviceModule.class.getDeclaredField("audioInput");
            audioInputField.setAccessible(true);
            Object webRtcAudioRecord = audioInputField.get(audioDeviceModule);
            if (webRtcAudioRecord == null) {
                nativeLog("WebRtcAudioRecord 为 null");
                return;
            }

            // 2. 获取 WebRtcAudioRecord.audioRecord (麦克风 AudioRecord)
            java.lang.reflect.Field audioRecordField = webRtcAudioRecord.getClass().getDeclaredField("audioRecord");
            audioRecordField.setAccessible(true);
            AudioRecord micRecord = (AudioRecord) audioRecordField.get(webRtcAudioRecord);

            // 3. 从麦克风 AudioRecord 获取采样率
            int sampleRate = 48000;
            if (micRecord != null) {
                sampleRate = micRecord.getFormat().getSampleRate();
            }

            // 4. 创建 AudioPlaybackCaptureConfiguration (系统内部声音)
            AudioPlaybackCaptureConfiguration config =
                    new AudioPlaybackCaptureConfiguration.Builder(audioMediaProjection)
                            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                            .addMatchingUsage(AudioAttributes.USAGE_GAME)
                            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                            .build();

            // 5. 创建系统音频 AudioRecord
            AudioFormat format = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build();

            int minBuf = AudioRecord.getMinBufferSize(sampleRate,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bufferSize = Math.max(minBuf * 2, 1024);

            AudioRecord systemRecord = new AudioRecord.Builder()
                    .setAudioFormat(format)
                    .setAudioPlaybackCaptureConfig(config)
                    .setBufferSizeInBytes(bufferSize)
                    .build();

            if (systemRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                nativeLog("系统音频 AudioRecord 初始化失败, 使用麦克风");
                return;
            }

            // 6. 停止并释放麦克风 AudioRecord
            if (micRecord != null) {
                try { micRecord.stop(); } catch (Exception ignored) {}
                micRecord.release();
            }

            // 7. 启动系统音频 AudioRecord 并替换字段
            systemRecord.startRecording();
            audioRecordField.set(webRtcAudioRecord, systemRecord);

            nativeLog("✅ 系统音频采集已启动 (sampleRate=" + sampleRate + ", bufSize=" + bufferSize + ")");

        } catch (NoSuchFieldException e) {
            nativeLog("反射失败 (字段不存在): " + e.getMessage());
        } catch (Exception e) {
            nativeLog("系统音频替换失败: " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }
    }

    private void stopNativeShare() {
        nativeShareActive = false;

        // 通知接收端停止投屏 (保持 TCP 连接, 仅停止画面传输)
        sendTcpLine("STOP");

        try {
            if (videoCapturer != null) {
                videoCapturer.stopCapture();
                videoCapturer = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "停止 capturer 失败", e);
        }

        if (videoTrack != null) {
            videoTrack.dispose();
            videoTrack = null;
        }
        if (audioTrack != null) {
            audioTrack.dispose();
            audioTrack = null;
        }
        if (videoSource != null) {
            videoSource.dispose();
            videoSource = null;
        }
        if (audioSource != null) {
            audioSource.dispose();
            audioSource = null;
        }
        if (surfaceHelper != null) {
            surfaceHelper.dispose();
            surfaceHelper = null;
        }
        if (peerConnection != null) {
            peerConnection.close();
            peerConnection = null;
        }
        if (audioMediaProjection != null) {
            try { audioMediaProjection.stop(); } catch (Exception e) {}
            audioMediaProjection = null;
        }

        // 停止前台服务
        try {
            getContext().stopService(new Intent(getContext(), ScreenCaptureService.class));
        } catch (Exception e) {}
    }

    // ==================== WebRTC 初始化 ====================

    private void initWebRTCFactory() {
        if (factory != null) return;

        Log.i(TAG, "初始化 PeerConnectionFactory");
        eglBase = EglBase.create();

        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions
                .builder(getContext())
                .createInitializationOptions());

        VideoEncoderFactory encoderFactory = new DefaultVideoEncoderFactory(
                eglBase.getEglBaseContext(), true, true);
        VideoDecoderFactory decoderFactory = new DefaultVideoDecoderFactory(
                eglBase.getEglBaseContext());

        audioDeviceModule = JavaAudioDeviceModule.builder(getContext())
                .setAudioRecordStateCallback(new JavaAudioDeviceModule.AudioRecordStateCallback() {
                    @Override
                    public void onWebRtcAudioRecordStart() {
                        nativeLog("WebRTC AudioRecord 开始, 尝试替换为系统音频");
                        replaceMicWithSystemAudio();
                    }
                    @Override
                    public void onWebRtcAudioRecordStop() {
                        nativeLog("WebRTC AudioRecord 停止");
                    }
                })
                .createAudioDeviceModule();

        factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .setAudioDeviceModule(audioDeviceModule)
                .createPeerConnectionFactory();

        Log.i(TAG, "PeerConnectionFactory 创建成功");
        nativeLog("factory 创建结果: " + (factory != null ? "成功" : "失败(null)"));
    }

    private void createPeerConnection() {
        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
        iceServers.add(new PeerConnection.IceServer("stun:stun.l.google.com:19302"));

        PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(iceServers);
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        peerConnection = factory.createPeerConnection(config, new PeerConnection.Observer() {
            @Override
            public void onSignalingChange(PeerConnection.SignalingState state) {
                nativeLog("Signaling 状态: " + state);
            }

            @Override
            public void onIceCandidate(IceCandidate candidate) {
                nativeLog("生成 ICE candidate: " + candidate.sdpMid);
                sendSignalViaTcp("ice", null, candidate);
            }

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                nativeLog("ICE 连接状态: " + state);
            }

            @Override
            public void onIceConnectionReceivingChange(boolean receiving) {}

            @Override
            public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
                nativeLog("ICE 收集状态: " + state);
            }

            @Override
            public void onIceCandidatesRemoved(IceCandidate[] candidates) {}

            @Override
            public void onAddStream(org.webrtc.MediaStream stream) {}

            @Override
            public void onRemoveStream(org.webrtc.MediaStream stream) {}

            @Override
            public void onDataChannel(org.webrtc.DataChannel dc) {}

            @Override
            public void onRenegotiationNeeded() {}

            @Override
            public void onAddTrack(org.webrtc.RtpReceiver receiver, org.webrtc.MediaStream[] mediaStreams) {}
        });

        Log.i(TAG, "PeerConnection 创建成功");
        nativeLog("PeerConnection 创建结果: " + (peerConnection != null ? "成功" : "失败(null)"));
        if (peerConnection == null) {
            nativeLog("⚠️ factory.createPeerConnection 返回 null, WebRTC 初始化可能不完整");
        }
    }

    // ==================== 信令 (原生模式) ====================

    private void sendSignalViaTcp(String type, String sdp, IceCandidate candidate) {
        try {
            JSONObject json = new JSONObject();
            json.put("type", type);
            if (sdp != null) {
                json.put("sdp", sdp);
            }
            if (candidate != null) {
                JSONObject cand = new JSONObject();
                cand.put("sdpMid", candidate.sdpMid);
                cand.put("sdpMLineIndex", candidate.sdpMLineIndex);
                cand.put("candidate", candidate.sdp);
                json.put("candidate", cand);
            }
            String payload = Base64.getEncoder().encodeToString(json.toString().getBytes("UTF-8"));
            sendTcpLine("SIGNAL:" + payload);
            nativeLog("已发送信号: " + type + " (payload 长度=" + payload.length() + ")");
        } catch (Exception e) {
            nativeLog("sendSignalViaTcp 失败: " + e.getMessage());
        }
    }

    private void handleNativeSignal(String payload) {
        try {
            String json = new String(Base64.getDecoder().decode(payload), "UTF-8");
            JSONObject data = new JSONObject(json);
            String type = data.getString("type");
            nativeLog("处理原生信号: " + type);

            if (peerConnection == null) {
                nativeLog("peerConnection 为空, 忽略信号");
                return;
            }

            if ("answer".equals(type)) {
                String sdp = data.getString("sdp");
                nativeLog("设置 RemoteDescription (answer, sdp 长度=" + sdp.length() + ")");
                peerConnection.setRemoteDescription(new SdpObserver() {
                    @Override
                    public void onSetSuccess() {
                        nativeLog("RemoteDescription (answer) 设置成功");
                    }

                    @Override
                    public void onSetFailure(String error) {
                        nativeLog("setRemoteDescription 失败: " + error);
                    }

                    @Override
                    public void onCreateSuccess(SessionDescription sdp) {}
                    @Override
                    public void onCreateFailure(String error) {}
                }, new SessionDescription(SessionDescription.Type.ANSWER, sdp));

            } else if ("ice".equals(type)) {
                JSONObject cand = data.getJSONObject("candidate");
                IceCandidate candidate = new IceCandidate(
                        cand.getString("sdpMid"),
                        cand.getInt("sdpMLineIndex"),
                        cand.getString("candidate"));
                peerConnection.addIceCandidate(candidate);
                nativeLog("ICE candidate 已添加");
            }
        } catch (Exception e) {
            nativeLog("handleNativeSignal 解析失败: " + e.getMessage());
        }
    }

    // ==================== TCP 接收线程 ====================

    private void startReceiverThread(final BufferedReader reader) {
        receiverThread = new Thread(() -> {
            try {
                String line;
                while (running && (line = reader.readLine()) != null) {
                    line = line.trim();
                    nativeLog("TCP 收到: " + (line.length() > 80 ? line.substring(0, 80) + "..." : line));
                    if (line.startsWith("SIGNAL:")) {
                        String payload = line.substring(7);
                        if (nativeShareActive) {
                            // 屏幕投射模式 → 原生 WebRTC 处理
                            handleNativeSignal(payload);
                        } else {
                            // 摄像头模式 → 转发到 JS
                            JSObject data = new JSObject();
                            data.put("payload", payload);
                            notifyListeners("signal", data);
                        }
                    }
                }
            } catch (Exception e) {
                nativeLog("接收线程结束: " + e.getMessage());
            } finally {
                cleanupConnection();
                notifyConnectionStatus(false);
            }
        });
        receiverThread.setDaemon(true);
        receiverThread.start();
    }

    // ==================== 工具方法 ====================

    /** 同时输出到 Logcat 和前端调试面板 */
    private void nativeLog(String msg) {
        Log.i(TAG, msg);
        try {
            JSObject data = new JSObject();
            data.put("msg", msg);
            notifyListeners("nativeLog", data);
        } catch (Exception e) {}
    }

    private void sendTcpLine(String line) {
        if (socketOut != null) {
            try {
                socketOut.write((line + "\n").getBytes("UTF-8"));
                socketOut.flush();
            } catch (Exception e) {
                Log.e(TAG, "sendTcpLine 失败", e);
            }
        }
    }

    private void notifyConnectionStatus(boolean connected) {
        JSObject data = new JSObject();
        data.put("connected", connected);
        notifyListeners("connectionStatus", data);
    }

    private void cleanupConnection() {
        running = false;
        try { if (clientSocket != null) clientSocket.close(); } catch (Exception e) {}
        clientSocket = null;
        socketOut = null;
    }

    private void stopExistingConnection() {
        running = false;
        try { if (clientSocket != null) clientSocket.close(); } catch (Exception e) {}
        clientSocket = null;
        socketOut = null;
    }

    private String[] parseCode(String code) {
        String cleaned = code.toLowerCase();
        String[] parts = cleaned.split("-");
        if (parts.length != 5) return null;

        int[] nums = new int[5];
        for (int i = 0; i < 5; i++) {
            String p = parts[i];
            if (!p.matches("^[0-9a-f]+$")) return null;
            try {
                nums[i] = Integer.parseInt(p, 16);
            } catch (NumberFormatException e) {
                return null;
            }
        }

        if (nums[0] > 255 || nums[1] > 255 || nums[2] > 255 || nums[3] > 255) return null;
        if (nums[4] < 1 || nums[4] > 65535) return null;

        String ip = nums[0] + "." + nums[1] + "." + nums[2] + "." + nums[3];
        return new String[]{ip, String.valueOf(nums[4])};
    }

    private int parseIntSafe(String s, int def) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return def;
        }
    }
}
