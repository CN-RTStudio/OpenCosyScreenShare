package com.rtstu.screenshare.cosy.receiver;

public final class PeerProtocol {

    public static final int MAX_SIGNAL_BYTES = 64 * 1024;
    public static final int MAX_INFO_FIELDS = 4;

    public enum Kind {
        INIT,
        INFO,
        CONNECTED,
        STOP,
        SIGNAL,
        UNKNOWN
    }

    private static final String SIGNAL_PREFIX = "SIGNAL:";

    private PeerProtocol() {
    }

    public static Kind classify(String line) {
        if (line == null) return Kind.UNKNOWN;
        if (Kind.INIT.name().equals(line)) return Kind.INIT;
        if (Kind.INFO.name().equals(line)) return Kind.INFO;
        if (Kind.CONNECTED.name().equals(line)) return Kind.CONNECTED;
        if (Kind.STOP.name().equals(line)) return Kind.STOP;
        if (line.startsWith(SIGNAL_PREFIX)) return Kind.SIGNAL;
        return Kind.UNKNOWN;
    }

    public static String signalPayload(String line) {
        if (line == null || !line.startsWith(SIGNAL_PREFIX)) return null;
        String payload = line.substring(SIGNAL_PREFIX.length());
        if (payload.length() == 0 || payload.length() > MAX_SIGNAL_BYTES) return null;
        return payload;
    }

    public static boolean isAcceptable(String line) {
        if (line == null || line.length() == 0) return false;
        if (line.length() > BoundedLineReader.DEFAULT_MAX_LINE_BYTES) return false;
        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            if (ch < 0x20 && ch != '\t') return false;
        }
        return true;
    }

    public static String infoReply(int sdkVersion, String appVersion, String platform) {
        String sdk = String.valueOf(sdkVersion);
        String app = appVersion == null ? "" : appVersion.replace('|', '/');
        String os = platform == null ? "unknown" : platform.replace('|', '/');
        return "INFO:" + sdk + "|" + app + "|" + os + "\n";
    }
}
