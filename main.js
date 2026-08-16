const { app, BrowserWindow, dialog, Menu, Tray, shell, clipboard, nativeImage } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');

// Pastikan PATH berisi direktori Node/NVM jika diluncurkan dari GUI Desktop
if (process.env.HOME) {
  const extraPaths = [
    path.join(process.env.HOME, 'Dev/.nvm/versions/node/v24.2.0/bin'),
    path.join(process.env.HOME, '.nvm/versions/node/v24.2.0/bin'),
    path.join(process.env.HOME, '.local/bin'),
    path.join(process.env.HOME, '.npm-global/bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  process.env.PATH = `${extraPaths.join(':')}:${process.env.PATH || ''}`;
}

app.setName('dsh-desktop');
if (process.platform === 'win32') {
  app.setAppUserModelId('dsh-desktop');
}

let mainWindow = null;
let dshProcess = null;
let serverUrl = null;
let isQuitting = false;
let tray = null;
let remoteVersion = null;

const TARGET_PORTS = [3080, 8080, 3000, 3001, 8081, 5000, 5173];
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

// --- 1. WINDOW STATE MEMORY ---
function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return {
        x: data.x,
        y: data.y,
        width: typeof data.width === 'number' && data.width >= 800 ? data.width : 1280,
        height: typeof data.height === 'number' && data.height >= 600 ? data.height : 860,
        isMaximized: !!data.isMaximized,
      };
    }
  } catch (e) {
    console.warn('[DSH Launcher] Gagal membaca window-state.json:', e);
  }
  return { width: 1280, height: 860, isMaximized: false };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    const bounds = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized,
      }),
      'utf8'
    );
  } catch (e) {
    console.warn('[DSH Launcher] Gagal menyimpan window-state.json:', e);
  }
}

// --- 2. VERSION INSPECTOR (NPM REGISTRY) ---
function fetchLatestNpmVersion() {
  return new Promise((resolve) => {
    const req = https.get('https://registry.npmjs.org/@deepseek-ai/dsh/latest', { timeout: 3500 }, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(data.version || null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function sendStatus(title, detail = '', ready = false, isUpdate = false, version = null) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('status-update', {
      title,
      detail,
      ready,
      isUpdate,
      version: version || remoteVersion,
    });
  }
}

// --- 3. SYSTEM TRAY ---
function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const isOnline = !!serverUrl;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: isOnline ? `● Server Aktif (${serverUrl})` : '○ Menyiapkan Server...',
      enabled: false,
    },
    {
      label: remoteVersion ? `Versi Paket: v${remoteVersion}` : 'DeepSeek Harness Desktop',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Buka DeepSeek Harness',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Buka di Browser Eksternal',
      enabled: isOnline,
      click: () => {
        if (serverUrl) shell.openExternal(serverUrl);
      },
    },
    {
      label: 'Salin URL Server Lokal',
      enabled: isOnline,
      click: () => {
        if (serverUrl) clipboard.writeText(serverUrl);
      },
    },
    { type: 'separator' },
    {
      label: 'Muat Ulang (Reload)',
      click: () => {
        if (serverUrl && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(serverUrl);
        } else if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.reload();
        }
      },
    },
    {
      label: 'Restart Server Backend',
      click: () => {
        serverUrl = null;
        updateTrayMenu();
        stopDshBackend();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadFile(path.join(__dirname, 'loading.html'));
        }
        initDsh();
      },
    },
    { type: 'separator' },
    {
      label: 'Keluar (Quit)',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray) return;
  try {
    const iconPath = path.join(__dirname, 'deepseek.png');
    const image = nativeImage.createFromPath(iconPath);
    const trayIcon = image.resize({ width: 18, height: 18 });
    tray = new Tray(trayIcon);
    tray.setToolTip('DeepSeek Harness Desktop');
    updateTrayMenu();

    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible()) {
        if (mainWindow.isFocused()) {
          mainWindow.hide();
        } else {
          mainWindow.focus();
        }
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn('[DSH Launcher] Pembuatan System Tray dilewati:', err);
  }
}

// --- 4. CREATE BROWSER WINDOW ---
function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'deepseek.png'),
    backgroundColor: '#1c1c1c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  Menu.setApplicationMenu(null);

  // Simpan state saat jendela diubah ukuran atau posisinya
  const debouncedSave = () => {
    saveWindowState();
  };
  mainWindow.on('resize', debouncedSave);
  mainWindow.on('move', debouncedSave);

  // Tangani shortcut keyboard langsung tanpa menu bar
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Ctrl+R atau F5 untuk Reload
    if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      if (serverUrl && mainWindow) {
        mainWindow.loadURL(serverUrl);
      } else if (mainWindow) {
        mainWindow.reload();
      }
    }

    // Ctrl+Shift+I atau F12 untuk DevTools
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }

    // F11 untuk Fullscreen
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Tampilkan splash loading terlebih dahulu
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', () => {
    saveWindowState();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// --- 5. DYNAMIC PORT PROBING & SERVER SCANNING ---
function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}`, (res) => {
      res.resume();
      resolve(`http://127.0.0.1:${port}`);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(400, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function scanForActiveServer() {
  for (const port of TARGET_PORTS) {
    const alive = await probePort(port);
    if (alive) return alive;
  }
  return null;
}

function loadTarget(url) {
  if (serverUrl === url) return;
  serverUrl = url;
  console.log(`[DSH Launcher] Membuka URL di jendela desktop: ${url}`);
  updateTrayMenu();
  sendStatus('Server siap! Membuka antarmuka...', `Terhubung ke ${url}`, true);

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(url).catch((err) => {
        console.warn('loadURL gagal, mencoba lagi...', err);
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(url);
          }
        }, 400);
      });
    }
  }, 300);
}

// --- 6. BACKGROUND PROCESS & ROBUST SHUTDOWN ---
function startBackendProcess() {
  console.log('[DSH Launcher] Memulai background process dsh...');
  sendStatus('Memeriksa pembaruan & memuat dsh...', 'Menjalankan npx @deepseek-ai/dsh@latest web');

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const args = ['-y', '@deepseek-ai/dsh@latest', 'web'];

  const errorLogs = [];

  dshProcess = spawn(cmd, args, {
    shell: true,
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    cwd: process.env.HOME || __dirname,
  });

  const onDataOutput = (data) => {
    const output = data.toString().trim();
    console.log(`[DSH]: ${output}`);
    const lower = output.toLowerCase();

    if (
      lower.includes('need to install') ||
      lower.includes('download') ||
      lower.includes('fetch') ||
      lower.includes('reified') ||
      lower.includes('added') ||
      lower.includes('npm http fetch') ||
      lower.includes('packages in')
    ) {
      sendStatus('Pembaruan Ditemukan!', `Mengunduh & memasang: ${output}`, false, true);
    } else if (output.includes('dsh web:') || output.includes('http')) {
      sendStatus('Menyiapkan dashboard...', output);
    } else if (lower.includes('ready') || lower.includes('started') || lower.includes('listening')) {
      sendStatus('Server siap! Membuka antarmuka...', output, true);
    } else {
      sendStatus('Memuat komponen DeepSeek...', output);
    }

    const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):[0-9]+/i);
    if (match) {
      loadTarget(match[0]);
    }
  };

  dshProcess.stdout.on('data', onDataOutput);
  dshProcess.stderr.on('data', (data) => {
    const errText = data.toString().trim();
    console.warn(`[DSH stderr]: ${errText}`);
    errorLogs.push(errText);
    onDataOutput(data);
  });

  dshProcess.on('exit', async (code, signal) => {
    console.log(`[DSH Launcher] Background process keluar (code: ${code}, signal: ${signal})`);
    if (!isQuitting && !serverUrl) {
      const active = await scanForActiveServer();
      if (active) {
        loadTarget(active);
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        const detailError = errorLogs.length > 0 ? errorLogs.slice(-3).join('\n').trim() : `Exit code: ${code}`;
        dialog.showErrorBox(
          'Gagal Membuka DeepSeek Harness',
          `Proses server dsh terhenti.\n\nDetail:\n${detailError}`
        );
      }
    }
  });

  dshProcess.on('error', (err) => {
    console.error('[DSH Launcher] Error saat menjalankan spawn:', err);
  });
}

function initDsh() {
  // Cek versi terbaru di background secara simultan
  fetchLatestNpmVersion().then((ver) => {
    if (ver) {
      remoteVersion = ver;
      updateTrayMenu();
      sendStatus('Memeriksa pembaruan & memuat dsh...', `Versi paket: @deepseek-ai/dsh@${ver}`);
    }
  });

  // 1. Cek langsung apakah ada server yang sudah hidup
  scanForActiveServer().then((activeUrl) => {
    if (activeUrl) {
      loadTarget(activeUrl);
      return;
    }

    // 2. Jika belum ada, jalankan background process
    startBackendProcess();

    // 3. Polling cepat (300ms) untuk auto-detect saat server selesai start
    const pollInterval = setInterval(async () => {
      if (serverUrl || isQuitting) {
        clearInterval(pollInterval);
        return;
      }
      const aliveUrl = await scanForActiveServer();
      if (aliveUrl) {
        clearInterval(pollInterval);
        loadTarget(aliveUrl);
      }
    }, 300);

    setTimeout(() => {
      clearInterval(pollInterval);
    }, 90000);
  });
}

// Anti-Zombie child process termination
function stopDshBackend() {
  if (!dshProcess) return;

  console.log('[DSH Launcher] Menghentikan background process dsh...');
  const pid = dshProcess.pid;
  dshProcess = null;

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', pid.toString(), '/f', '/t']);
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch (e) {}
        }, 1200);
      } catch (e) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch (e2) {}
      }
    }
  } catch (e) {
    console.error('[DSH Launcher] Error saat mematikan child process:', e);
  }
}

// --- APP LIFECYCLE HOOKS ---
app.whenReady().then(() => {
  createWindow();
  createTray();
  initDsh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (serverUrl && mainWindow) {
        mainWindow.loadURL(serverUrl);
      }
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
  stopDshBackend();
});

app.on('will-quit', () => {
  isQuitting = true;
  stopDshBackend();
});

app.on('window-all-closed', () => {
  isQuitting = true;
  saveWindowState();
  stopDshBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('SIGINT', () => {
  stopDshBackend();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopDshBackend();
  process.exit(0);
});
