package com.rtstu.screenshare.cosy.receiver;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Collections;
import java.util.Enumeration;

@CapacitorPlugin(name = "CosyNetwork")
public class CosyNetworkPlugin extends Plugin {

    private static final int TCP_PORT = 25555;
    private static final int TCP_PORT_MAX = 25565;
    private static final int DISCOVERY_PORT = 30001;
    private static final int SDK_VERSION = 3;
    private static final String APP_VERSION = "1.0.0-beta.4";

    private ServerSocket tcpServer = null;
    private Thread serverThread = null;
    private Socket activeSocket = null;
    private OutputStream socketOut = null;
    private volatile boolean running = false;
    private WifiManager.MulticastLock multicastLock = null;

    @PluginMethod
    public void startServer(PluginCall call) {
        Log.i("CosyLog", "startServer 被调用");
        new Thread(() -> {
            try {
                stopExistingServer();
                Log.i("CosyLog", "已停止旧服务");

                running = true;
                int currentPort = TCP_PORT;
                while (currentPort <= TCP_PORT_MAX) {
                    try {
                        tcpServer = new ServerSocket(currentPort);
                        Log.i("CosyLog", "TCP 服务已启动, 端口: " + currentPort);
                        break;
                    } catch (java.net.BindException e) {
                        Log.i("CosyLog", "端口 " + currentPort + " 被占用, 尝试下一个");
                        currentPort++;
                    }
                }

                if (tcpServer == null) {
                    call.reject("所有端口均被占用 (" + TCP_PORT + "-" + TCP_PORT_MAX + ")");
                    return;
                }

                acquireMulticastLock();
                Log.i("CosyLog", "MulticastLock 已获取");

                String localIp = discoverLocalIp();
                Log.i("CosyLog", "获取到本机 IP: " + localIp);

                String code = generateCode(localIp, currentPort);
                Log.i("CosyLog", "生成传屏码: " + code);

                serverThread = new Thread(() -> {
                    try {
                        while (running) {
                            Socket socket = tcpServer.accept();
                            Log.i("CosyLog", "接受新连接: " + socket.getRemoteSocketAddress());
                            handleClient(socket);
                        }
                    } catch (Exception e) {
                        Log.i("CosyLog", "服务线程结束: " + e.getMessage());
                    }
                });
                serverThread.setDaemon(true);
                serverThread.start();

                JSObject ret = new JSObject();
                ret.put("code", code);
                Log.i("CosyLog", "调用 call.resolve");
                call.resolve(ret);
            } catch (Exception e) {
                Log.e("CosyLog", "startServer 失败", e);
                call.reject("Failed to start server: " + e.getMessage());
            }
        }).start();
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        stopExistingServer();
        notifyConnectionStatus(false);
        call.resolve();
    }

    @PluginMethod
    public void sendSignal(PluginCall call) {
        String payload = call.getString("payload");
        if (payload != null && socketOut != null) {
            try {
                socketOut.write(("SIGNAL:" + payload + "\n").getBytes());
                socketOut.flush();
            } catch (Exception e) {
            }
        }
        call.resolve();
    }

    private void acquireMulticastLock() {
        try {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("CosyDiscovery");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
        } catch (Exception e) {
        }
    }

    private void releaseMulticastLock() {
        if (multicastLock != null) {
            try {
                if (multicastLock.isHeld()) {
                    multicastLock.release();
                }
            } catch (Exception e) {}
            multicastLock = null;
        }
    }

    private void handleClient(Socket socket) {
        if (activeSocket != null) {
            try { socket.close(); } catch (Exception e) {}
            return;
        }

        activeSocket = socket;

        try {
            socketOut = socket.getOutputStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream()));

            String line;
            while (running && (line = reader.readLine()) != null) {
                line = line.trim();
                handleMessage(line);
            }
        } catch (Exception e) {
        } finally {
            cleanupConnection();
        }
    }

    private void handleMessage(String line) {
        Log.i("CosyLog", "收到消息: " + line);
        if (line.equals("INIT")) {
            try {
                socketOut.write("STATUS:0\n".getBytes());
                socketOut.flush();
                Log.i("CosyLog", "已回复 STATUS:0");
            } catch (Exception e) {
                Log.e("CosyLog", "回复 STATUS 失败", e);
            }
        } else if (line.equals("INFO")) {
            try {
                String response = "INFO:" + SDK_VERSION + "|" + APP_VERSION + "|android\n";
                socketOut.write(response.getBytes());
                socketOut.flush();
                Log.i("CosyLog", "已回复 INFO: " + response.trim());
            } catch (Exception e) {
                Log.e("CosyLog", "回复 INFO 失败", e);
            }
        } else if (line.equals("CONNECTED")) {
            Log.i("CosyLog", "收到 CONNECTED, 通知前端");
            notifyConnectionStatus(true);
        } else if (line.equals("STOP")) {
            // 发送端停止投屏但保持 TCP 连接 -> 通知前端回到等待页面
            Log.i("CosyLog", "收到 STOP, 通知前端回到等待页面");
            notifyStopShare();
        } else if (line.startsWith("SIGNAL:")) {
            String payload = line.substring(7);
            Log.i("CosyLog", "收到 SIGNAL, 转发给前端");
            JSObject data = new JSObject();
            data.put("payload", payload);
            notifyListeners("signal", data);
        }
    }

    private void notifyConnectionStatus(boolean connected) {
        JSObject data = new JSObject();
        data.put("connected", connected);
        notifyListeners("connectionStatus", data);
    }

    private void notifyStopShare() {
        // 停止投屏但保持 TCP 连接 (不调用 cleanupConnection)
        JSObject data = new JSObject();
        data.put("stop", true);
        notifyListeners("stopShare", data);
    }

    private void cleanupConnection() {
        try { if (activeSocket != null) activeSocket.close(); } catch (Exception e) {}
        activeSocket = null;
        socketOut = null;
        notifyConnectionStatus(false);
    }

    private void stopExistingServer() {
        running = false;
        try { if (tcpServer != null) tcpServer.close(); } catch (Exception e) {}
        try { if (activeSocket != null) activeSocket.close(); } catch (Exception e) {}
        activeSocket = null;
        socketOut = null;
        tcpServer = null;
        releaseMulticastLock();
    }

    private String discoverLocalIp() {
        // 直接遍历网络接口获取局域网 IP（Android TV 无虚拟网卡）
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            for (NetworkInterface iface : Collections.list(interfaces)) {
                if (!iface.isUp() || iface.isLoopback() || iface.isVirtual()) continue;
                Enumeration<InetAddress> addresses = iface.getInetAddresses();
                for (InetAddress addr : Collections.list(addresses)) {
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        return addr.getHostAddress();
                    }
                }
            }
        } catch (Exception e) {}
        return "127.0.0.1";
    }

    private String generateCode(String ip, int port) {
        String[] parts = ip.split("\\.");
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.length; i++) {
            if (i > 0) sb.append("-");
            sb.append(Integer.toHexString(Integer.parseInt(parts[i])));
        }
        sb.append("-").append(Integer.toHexString(port));
        return sb.toString();
    }
}
