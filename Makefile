# OpenCosyScreenShare Android Build Makefile
# make        → sync + build both sender & receiver
# make sender → sync + build android-sender only
# make receiver → sync + build android-receiver only
# make sync   → only sync frontend files, no build

.PHONY: all sender receiver sync clean

ANDROID_SENDER = android-sender
ANDROID_RECEIVER = android-receiver
ANDROID_SENDER_PROJ = android-sender/android
ANDROID_RECEIVER_PROJ = android-receiver/android

# ---- Default: build both ----
all: sender receiver

# ---- Sync android-sender Capacitor project ----
sync-sender:
	@echo "=== Syncing android-sender ==="
	cd "$(ANDROID_SENDER)" && npx cap sync android
	@echo "sender sync done."
	cd ..
# ---- Sync android-receiver Capacitor project ----
sync-receiver:
	@echo "=== Syncing android-receiver ==="
	cd "$(ANDROID_RECEIVER)" && npx cap sync android
	@echo "receiver sync done."
	cd ..
# ---- Sync both ----
sync: sync-sender sync-receiver

# ---- Build android-sender ----
sender: sync-sender
	@echo "=== Building android-sender (debug) ==="
	cd "$(ANDROID_SENDER_PROJ)" && gradlew.bat assembleDebug
	@echo "android-sender build done."
	@echo "APK: $(ANDROID_SENDER_PROJ)/app/build/outputs/apk/debug/app-debug.apk"
	cd ..

# ---- Build android-receiver ----
receiver: sync-receiver
	@echo "=== Building android-receiver (debug) ==="
	cd "$(ANDROID_RECEIVER_PROJ)" && gradlew.bat assembleDebug
	@echo "android-receiver build done."
	@echo "APK: $(ANDROID_RECEIVER_PROJ)/app/build/outputs/apk/debug/app-debug.apk"
	cd ..

# ---- Clean build outputs ----
clean:
	@echo "=== Cleaning android build outputs ==="
	cd "$(ANDROID_SENDER_PROJ)" && gradlew.bat clean
	cd "$(ANDROID_RECEIVER_PROJ)" && gradlew.bat clean
	@echo "Clean done."
