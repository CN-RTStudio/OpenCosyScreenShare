package com.rtstu.screenshare.cosy.sender;

import android.graphics.Point;

public final class CaptureGuard {

    public static final int MAX_WIDTH = 1920;
    public static final int MAX_HEIGHT = 1080;
    public static final int MAX_PIXELS = MAX_WIDTH * MAX_HEIGHT;
    public static final int MIN_WIDTH = 160;
    public static final int MIN_HEIGHT = 120;
    public static final int MAX_FPS = 30;
    public static final int MIN_FPS = 1;
    public static final int MAX_DIMENSION = 4096;

    private CaptureGuard() {
    }

    public static int clampFrameRate(int fps) {
        if (fps <= 0) {
            return MAX_FPS;
        }
        if (fps < MIN_FPS) {
            return MIN_FPS;
        }
        return Math.min(fps, MAX_FPS);
    }

    public static boolean isUsable(int width, int height) {
        return width >= MIN_WIDTH && height >= MIN_HEIGHT
                && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
    }

    public static Point clampSize(int width, int height) {
        if (width <= 0 || height <= 0) {
            return new Point(MAX_WIDTH, MAX_HEIGHT);
        }
        long pixels = (long) width * (long) height;
        double scale = 1.0;
        if (pixels > MAX_PIXELS) {
            scale = Math.sqrt((double) MAX_PIXELS / (double) pixels);
        }
        if (width > MAX_WIDTH) {
            scale = Math.min(scale, (double) MAX_WIDTH / (double) width);
        }
        if (height > MAX_HEIGHT) {
            scale = Math.min(scale, (double) MAX_HEIGHT / (double) height);
        }
        int targetWidth = (int) Math.floor(width * scale);
        int targetHeight = (int) Math.floor(height * scale);
        targetWidth = clampEven(targetWidth, MIN_WIDTH, MAX_WIDTH);
        targetHeight = clampEven(targetHeight, MIN_HEIGHT, MAX_HEIGHT);
        return new Point(targetWidth, targetHeight);
    }

    public static Point clampSize(Point size) {
        if (size == null) {
            return new Point(MAX_WIDTH, MAX_HEIGHT);
        }
        return clampSize(size.x, size.y);
    }

    private static int clampEven(int value, int min, int max) {
        int bounded = Math.max(min, Math.min(max, value));
        if (bounded % 2 != 0) {
            bounded -= 1;
        }
        return Math.max(min, bounded);
    }
}
