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

let mainWindow = null;
let dshProcess = null;
let serverUrl = null;
let isQuitting = false;

const DEFAULT_URL = 'http://127.0.0.1:3080';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'deepseek.png'),
    backgroundColor: '#0a0f1d',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Tampilkan splash loading terlebih dahulu
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Setup menu minimal dengan shortcut berguna (Reload, DevTools, Fullscreen)
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload App',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (serverUrl && mainWindow) {
              mainWindow.loadURL(serverUrl);
            } else if (mainWindow) {
              mainWindow.reload();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        {
          label: 'Toggle Developer Tools',
          accelerator: process.platform === 'darwin' ? 'Alt+Command+I' : 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.toggleDevTools();
            }
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Cek apakah URL sudah aktif dan merespon request HTTP
function checkUrlAlive(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function loadTarget(url) {
  if (serverUrl === url) return;
  serverUrl = url;
  console.log(`[DSH Launcher] Membuka URL di jendela desktop: ${url}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(url);
  }
}

async function initDsh() {
  // 1. Cek apakah dsh sudah berjalan di http://127.0.0.1:3080
  const isAlreadyRunning = await checkUrlAlive(DEFAULT_URL);
  if (isAlreadyRunning) {
    console.log(`[DSH Launcher] Server dsh terdeteksi sudah aktif di ${DEFAULT_URL}, langsung menghubungkan...`);
    loadTarget(DEFAULT_URL);
    return;
  }

  // 2. Jika belum berjalan, jalankan npx @deepseek-ai/dsh@latest web
  console.log('[DSH Launcher] Memulai background process dsh...');

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const args = ['-y', '@deepseek-ai/dsh@latest', 'web'];

  dshProcess = spawn(cmd, args, {
    shell: true,
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const onDataOutput = (data) => {
    const output = data.toString();
    console.log(`[DSH]: ${output.trim()}`);

    const match = output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):[0-9]+/i);
    if (match) {
      loadTarget(match[0]);
    }
  };

  dshProcess.stdout.on('data', onDataOutput);
  dshProcess.stderr.on('data', onDataOutput);

  dshProcess.on('exit', async (code, signal) => {
    console.log(`[DSH Launcher] Background process keluar (code: ${code}, signal: ${signal})`);
    if (!isQuitting && !serverUrl) {
      const alive = await checkUrlAlive(DEFAULT_URL);
      if (alive) {
        loadTarget(DEFAULT_URL);
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox(
          'Gagal Membuka DeepSeek Harness',
          `Proses npx berhenti sebelum server siap (Exit code: ${code}).\nPastikan koneksi internet aktif.`
        );
      }
    }
  });

  dshProcess.on('error', (err) => {
    console.error('[DSH Launcher] Error saat menjalankan spawn:', err);
  });

  // Polling HTTP aktif setiap 400ms sampai server siap
  const pollInterval = setInterval(async () => {
    if (serverUrl || isQuitting) {
      clearInterval(pollInterval);
      return;
    }
    const alive = await checkUrlAlive(DEFAULT_URL);
    if (alive) {
      clearInterval(pollInterval);
      loadTarget(DEFAULT_URL);
    }
  }, 400);

  setTimeout(() => {
    clearInterval(pollInterval);
  }, 35000);
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
