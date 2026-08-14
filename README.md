# DeepSeek Harness Desktop (Community Edition)

> **Disclaimer**: This is an unofficial, community-driven open-source project and is not affiliated with, maintained, or endorsed by DeepSeek. It is built for developers and enthusiasts who want a standalone desktop app experience.

An open-source Electron desktop wrapper around `@deepseek-ai/dsh web` that turns DeepSeek's CLI and web interface into a dedicated desktop application with an Adobe-inspired splash screen and full offline packaging support.

---

## 📥 Download & Installation

Choose whichever method fits your operating system:

### 🪟 Windows Users (No Setup Required)

1. Download the latest **`DeepSeek-Harness-Setup.exe`** (Installer) or **`DeepSeek-Harness-Portable.exe`** from the [GitHub Releases](https://github.com/danyakmallun9999/dsh-desktop/releases) page.
2. Double-click the downloaded file to run.
3. *Note: No need to install Node.js, npm, or Electron — the runtime is already bundled!*

---

### 🐧 Linux Users

#### Option A: One-Line Setup Script
On Ubuntu, Debian, and Arch-based distributions:
```bash
git clone https://github.com/danyakmallun9999/dsh-desktop.git
cd dsh-desktop
./install.sh
```
This automatically installs dependencies, configures system desktop shortcuts, and registers the app in your Application Menu (Super key search).

#### Option B: Standalone AppImage / Deb
Download the `.AppImage` or `.deb` package directly from [GitHub Releases](https://github.com/danyakmallun9999/dsh-desktop/releases).

---

### 🍎 macOS Users

Download the `.dmg` file from [GitHub Releases](https://github.com/danyakmallun9999/dsh-desktop/releases), open it, and drag `DeepSeek Harness` into your `Applications` folder.

---

## 💻 Run from Source (Developers)

If you prefer cloning and running directly with Node.js & npm:

```bash
git clone https://github.com/danyakmallun9999/dsh-desktop.git
cd dsh-desktop
npm install
npm start
```

Or run via the CLI launcher:
```bash
npx .
```

---

## 🔨 Building Standalone Executables

You can package the application into standalone installers for any platform using `electron-builder`:

```bash
# Build for current OS
npm run dist

# Target specific platforms
npm run dist:win      # Windows (.exe installer & portable)
npm run dist:linux    # Linux (.AppImage & .deb)
npm run dist:mac      # macOS (.dmg & .zip)
```

Generated packages will be placed inside the `dist/` directory.

---

## ✨ Key Features

- **Standalone Desktop Experience**: Full window control, taskbar integration, and Adobe-inspired aesthetic splash screen featuring the DeepSeek blue whale motif.
- **Always Up to Date**: Spawns `@deepseek-ai/dsh web` in the background. Whenever DeepSeek releases updates on npm, your desktop app can fetch the latest version automatically.
- **Smart Auto-Connect**: If `dsh web` is already running on ports `3080`, `8080`, or `3000`, the app detects and connects instantly.
- **Clean Process Management**: Cleanly terminates any child background processes when closing the application.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl + R` / `Cmd + R` | Reload application |
| `F11` | Toggle Fullscreen |
| `Ctrl + Shift + I` / `F12` | Toggle Developer Tools |
| `F5` | Refresh view |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
