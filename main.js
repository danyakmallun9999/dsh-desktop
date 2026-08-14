const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

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

const TARGET_PORTS = [3080, 8080, 3000];

function sendStatus(title, detail = '', ready = false) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send('status-update', { title, detail, ready });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'deepseek.png'),
    backgroundColor: '#07090e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function probePort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}`, (res) => {
      res.resume();
      resolve(`http://127.0.0.1:${port}`);
    });
    req.on('error', () => resolve(null));
    req.setTimeout(500, () => {
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
  }, 350);
}

function startBackendProcess() {
  console.log('[DSH Launcher] Memulai background process dsh...');
  sendStatus('Memeriksa pembaruan & memuat dsh...', 'Menjalankan npx @deepseek-ai/dsh web');

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const args = ['-y', '@deepseek-ai/dsh', 'web'];

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

    if (output.includes('dsh web:') || output.includes('http')) {
      sendStatus('Menyiapkan dashboard...', output);
    } else if (output.toLowerCase().includes('download') || output.toLowerCase().includes('fetch') || output.toLowerCase().includes('npm')) {
      sendStatus('Mengunduh pembaruan paket...', output);
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
  // 1. Cek langsung apakah ada server yang sudah hidup
  scanForActiveServer().then((activeUrl) => {
    if (activeUrl) {
      loadTarget(activeUrl);
      return;
    }

    // 2. Jika belum ada, jalankan background process
    startBackendProcess();

    // 3. Polling super cepat (300ms) untuk auto-detect saat server selesai start / update
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

function stopDshBackend() {
  if (!dshProcess) return;

  console.log('[DSH Launcher] Menghentikan background process dsh...');
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', dshProcess.pid.toString(), '/f', '/t']);
    } else {
      try {
        process.kill(-dshProcess.pid, 'SIGTERM');
      } catch (e) {
        dshProcess.kill('SIGTERM');
      }
    }
  } catch (e) {
    console.error('Error saat mematikan child process:', e);
  }
  dshProcess = null;
}

app.whenReady().then(() => {
  createWindow();
  initDsh();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (serverUrl && mainWindow) {
        mainWindow.loadURL(serverUrl);
      }
    }
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  stopDshBackend();
});

app.on('window-all-closed', () => {
  isQuitting = true;
  stopDshBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
