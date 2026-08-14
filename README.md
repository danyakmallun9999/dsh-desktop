# DeepSeek Harness Desktop (Community Edition)

> Disclaimer: This is an unofficial, community-driven open-source project and is not affiliated with, maintained, or endorsed by DeepSeek. It is built for developers and enthusiasts who want a standalone desktop app experience.

An open-source Electron wrapper around `@deepseek-ai/dsh web` that turns DeepSeek's CLI and web interface into a dedicated desktop application.

---

## Installation and Running

Choose whichever method fits your setup best.

### Method 1: Linux One-Line Installer Script

On Ubuntu and other Linux distributions, you can clone and set up the desktop shortcut and application menu entry in one step:

```bash
git clone https://github.com/danyakmallun9999/dsh-desktop.git
cd dsh-desktop
./install.sh
```

This installs dependencies, marks desktop shortcuts as trusted, and registers the app in your system Application Menu (Super key search) and Desktop.

---

### Method 2: Run from Source

If you prefer cloning and running directly with npm:

```bash
git clone https://github.com/danyakmallun9999/dsh-desktop.git
cd dsh-desktop
npm install
npm start
```

Or run the shell launcher:

```bash
./run.sh
```

---

### Method 3: Build Standalone Binaries (AppImage, Deb, Exe, DMG)

You can package the app into a standalone installer or portable binary (AppImage on Linux, EXE on Windows, DMG on macOS) using electron-builder:

```bash
npm run dist
```

Packaged files will be generated inside the `dist/` directory.

---

## Key Features

- Always Up to Date: Executes `npx -y @deepseek-ai/dsh@latest web` in the background. Whenever DeepSeek releases an update on npm, your desktop app automatically runs the latest version on launch.
- Smart Auto-Connect: If you already have `dsh web` running on `http://127.0.0.1:3080`, the desktop window connects to it instantly. If not, it spawns and manages the background server for you.
- Clean Process Teardown: When you close the desktop window, any background server processes spawned by the app are terminated cleanly to prevent orphaned background tasks.
- Dedicated Desktop Experience: Built-in splash screen, custom window title and icon, system menu shortcuts, and zero browser tab clutter.

---

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl + R / Cmd + R | Reload the app |
| F11 | Toggle Fullscreen |
| Ctrl + Shift + I | Toggle Developer Tools |
| Ctrl + Q / Cmd + Q | Quit the application |

---

## Contributing

Contributions, feedback, and pull requests are welcome. Feel free to open an issue or submit improvements.

---

## License

This project is licensed under the MIT License.
