package com.rtstu.screenshare.cosy.sender;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public final class BoundedLineReader {

    public static final int DEFAULT_MAX_LINE_BYTES = 64 * 1024;

    private final BufferedReader reader;
    private final int maxLineBytes;

    public BoundedLineReader(InputStream input, int maxLineBytes) {
        if (input == null) throw new IllegalArgumentException("input 为 null");
        if (maxLineBytes <= 0) throw new IllegalArgumentException("maxLineBytes 必须为正");
        this.reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8));
        this.maxLineBytes = maxLineBytes;
    }

    public BoundedLineReader(InputStream input) {
        this(input, DEFAULT_MAX_LINE_BYTES);
    }

    public String readLine() throws IOException {
        StringBuilder sb = null;
        int pending = 0;
        boolean any = false;
        while (true) {
            int ch = reader.read();
            if (ch < 0) {
                if (!any) return null;
                break;
            }
            any = true;
            if (ch == '\n') break;
            if (ch == '\r') continue;
            if (ch < 0x20 && ch != '\t') {
                throw new IOException("控制字符被拒绝");
            }
            pending += 1;
            if (pending > maxLineBytes) {
                throw new IOException("单行超过上限 " + maxLineBytes + " 字节");
            }
            if (sb == null) sb = new StringBuilder(Math.min(maxLineBytes, 4096));
            sb.append((char) ch);
        }
        return sb == null ? "" : sb.toString();
    }

    public int maxLineBytes() {
        return maxLineBytes;
    }
}
