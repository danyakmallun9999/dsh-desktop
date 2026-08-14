#!/usr/bin/env bash
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ENTRY_DIR="$HOME/.local/share/applications"
DESKTOP_DIR="$HOME/Desktop"
ICON_SOURCE="$APP_DIR/deepseek.png"
EXEC_PATH="$APP_DIR/run.sh"

echo "[DeepSeek Harness Desktop Installer]"
echo "Installing dependencies in $APP_DIR..."

cd "$APP_DIR"
npm install

chmod +x "$EXEC_PATH"
chmod +x "$APP_DIR/bin/cli.js"

mkdir -p "$DESKTOP_ENTRY_DIR"

# Install icon to standard freedesktop / GNOME hicolor directories
ICON_DIR_512="$HOME/.local/share/icons/hicolor/512x512/apps"
ICON_DIR_SCALABLE="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$ICON_DIR_512" "$ICON_DIR_SCALABLE"

if [ -f "$ICON_SOURCE" ]; then
  cp "$ICON_SOURCE" "$ICON_DIR_512/deepseek-dsh.png"
  cp "$ICON_SOURCE" "$ICON_DIR_SCALABLE/deepseek-dsh.png"
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi

DESKTOP_CONTENT="[Desktop Entry]
Version=1.0
Type=Application
Name=DeepSeek Harness
GenericName=AI Harness UI
Comment=Community Desktop Wrapper for DeepSeek Harness
Exec=$EXEC_PATH
Icon=deepseek-dsh
Terminal=false
Categories=Development;Utility;
StartupNotify=true
StartupWMClass=dsh-desktop"

echo "$DESKTOP_CONTENT" > "$DESKTOP_ENTRY_DIR/deepseek-dsh.desktop"
chmod +x "$DESKTOP_ENTRY_DIR/deepseek-dsh.desktop"

if [ -d "$DESKTOP_DIR" ]; then
  echo "$DESKTOP_CONTENT" > "$DESKTOP_DIR/deepseek-dsh.desktop"
  chmod +x "$DESKTOP_DIR/deepseek-dsh.desktop"
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESKTOP_DIR/deepseek-dsh.desktop" metadata::trusted true 2>/dev/null || true
  fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_ENTRY_DIR" 2>/dev/null || true
fi

echo "Installation complete! DeepSeek Harness is now available in your Application Menu and Desktop."
