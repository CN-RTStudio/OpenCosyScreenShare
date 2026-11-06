# OpenCosyScreenShare (OpenCSS) 1.0

**OpenCosyScreenShare**（简称 **OpenCSS**）是一个开源的无线投屏应用，支持跨设备的实时屏幕共享，基于 [RTStudio](https://www.rtstu.com) 官方版 **CosyScreenShare 1.0.0-beta.4** 修改并开源发布，版本号 **OpenCSS 1.0**。

- 官方版网站：[css.rtstu.com](https://css.rtstu.com)
- 许可证：Apache-2.0

## 项目简介

OpenCSS 实现「发送端 → 接收端」的局域网无线投屏：

- **发送端（Sender）**：捕获本机屏幕画面，输入接收端上的「传屏码」即可发起投屏。
- **接收端（Receiver）**：启动后自动生成传屏码并监听网络，接收并全屏播放发送端的画面。

底层使用 **WebRTC** 完成音视频传输，通过局域网 TCP 连接交换信令（Signaling），并使用 UDP 广播进行设备发现，无需任何外网服务器，数据全部在本地网络内传输。

## 项目结构

| 目录 | 说明 |
| --- | --- |
| `sender/` | 桌面端（Electron）发送端 |
| `receiver/` | 桌面端（Electron）接收端 |
| `android-sender/` | Android 发送端（Capacitor 封装） |
| `android-receiver/` | Android 接收端（Capacitor 封装） |
| `dist/` | 打包输出目录 |
| `Makefile` | Android 端同步与构建脚本 |

## 技术栈

- **桌面端**：Electron 28 + 原生 HTML/CSS/JS
- **Android 端**：Capacitor + 原生 Java 插件（网络/屏幕采集）
- **传输**：WebRTC（媒体流）+ TCP（信令，端口 25555–25565）+ UDP 广播（设备发现，端口 30001）

## 构建与运行

### 桌面端（Electron）

```bash
# 安装依赖
npm install

# 开发运行
npm run start:sender    # 启动发送端
npm run start:receiver  # 启动接收端

# 打包（Windows：nsis + portable）
npm run build
```

### Android 端

依赖 Node.js、JDK 与 Android SDK（Gradle）。

```bash
# 同步前端资源并构建两端 APK
make

# 仅构建 android-sender / android-receiver
make sender
make receiver

# 仅同步前端文件
make sync
```

构建产物位于 `android-sender/android/app/build/outputs/apk/debug/app-debug.apk` 和 `android-receiver/android/app/build/outputs/apk/debug/app-debug.apk`。

## 使用方法

1. 在接收设备（电脑或 Android 电视/手机）上启动 **接收端**，界面会显示 6 位传屏码。
2. 在发送设备上启动 **发送端**，输入传屏码完成配对。
3. 点击开始共享，即可将发送端屏幕实时投到接收端。

## 与官方版的关系

本项目基于 RTStudio 官方版 [CosyScreenShare](https://css.rtstu.com) `1.0.0-beta.4` 的代码修改而来，以 Apache-2.0 协议开源：

- 项目更名为 **OpenCosyScreenShare**，简称 **OpenCSS**，当前版本 **OpenCSS 1.0**。
- 感谢 RTStudio 的原始工作。

## License

[Apache-2.0](LICENSE)
