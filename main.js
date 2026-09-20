const { app, BaseWindow, WebContentsView, dialog, Menu, Tray, shell, clipboard, nativeImage } = require('electron');
const { spawn, spawnSync } = require('child_process');
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
let titleBarView = null;
let contentView = null;
let dshProcess = null;
let serverUrl = null;
let isQuitting = false;
let tray = null;

// Channel backend dsh yang dijalankan & ditampilkan versinya.
// Spec TANPA tag (= npm resolve ke dist-tag `latest`, yaitu rilis resmi stabil/RC).
// Prerelease seperti 0.1.6-alpha.x hidup di tag 'alpha' dan TIDAK otomatis dipakai
// karena harness ini mengeksekusi perintah shell di mesinmu.
// Isi '@deepseek-ai/dsh@alpha' hanya bila sadar risikonya.
const DSH_SPEC = '@deepseek-ai/dsh';
const DSH_TAG = 'latest';
const DSH_PKG = '@deepseek-ai/dsh';

// Versi backend dsh untuk TAMPILAN (splash, title bar, tray).
// Prioritas: versi terukur dari backend yang benar-benar berjalan,
// fallback versi tag registry. Tidak pernah hardcoded.
let dshVersion = null;

// --- 1b. FILE LOG (diagnosis hasil build: packaged app tak punya console) ---
const launcherLog = path.join(app.getPath('userData'), 'launcher.log');
try {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const st = fs.statSync(launcherLog);
  if (st.size > 512 * 1024) fs.writeFileSync(launcherLog, '', 'utf8');
} catch (e) {}
function logToFile(level, msg) {
  try {
    fs.appendFileSync(launcherLog, `[${new Date().toISOString()}] [${level}] ${msg}\n`, 'utf8');
  } catch (e) {}
}

// Direktori kerja backend. HARUS direktori nyata & writable.
// __dirname di hasil build menunjuk ke dalam app.asar (sebuah FILE, bukan
// direktori) sehingga spawn gagal ENOENT -> splash nyangkut selamanya.
const backendCwd = app.getPath('userData');

// Seamless native title bar (Window Controls Overlay). Lihat createWindow().
const SEAMLESS_TITLEBAR = true;

// Tinggi title bar milik kita. Tombol overlay sistem melayang di kanan-atas
// area ini; konten dsh selalu dimulai DI BAWAHNYA sehingga tak tertutup tombol.
const TITLEBAR_HEIGHT = 40;

// webContents konten (splash loading.html / UI dsh), atau null bila tak valid.
function getContentWC() {
  if (mainWindow && !mainWindow.isDestroyed() && contentView && !contentView.webContents.isDestroyed()) {
    return contentView.webContents;
  }
  return null;
}

// webContents title bar (nama app + versi), atau null bila tak valid.
function getTitleWC() {
  if (mainWindow && !mainWindow.isDestroyed() && titleBarView && !titleBarView.webContents.isDestroyed()) {
    return titleBarView.webContents;
  }
  return null;
}

// Status terakhir yang tiba sebelum splash siap + flag kesiapan splash.
// Tanpa antrean ini, status cepat (mis. hasil cek versi npm) hilang karena
// dikirim sebelum renderer loading.html memasang listener.
let pendingStatus = null;
let contentReady = false;

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

// --- 2. VERSION INSPECTOR (REGISTRY TAG + PENGUKURAN BACKEND) ---
// Versi tag registry (cepat; tampilan awal + info ketersediaan update).
function fetchLatestNpmVersion() {
  return new Promise((resolve) => {
    const req = https.get(`https://registry.npmjs.org/${DSH_PKG}/${DSH_TAG}`, { timeout: 3500 }, (res) => {
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

// Versi backend yang BENAR-BENAR berjalan (otoritatif, ~2 detik, cache hangat).
// Registry hanya tahu versi tag; pengukuran ini yang memastikan tampilan versi
// tak pernah basi/salah — termasuk bila tag registry bergeser atau backend
// berasal dari cache offline. Fail-soft ke null bila offline/gagal.
function measureBackendVersion() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npx.cmd' : 'npx';
    let child;
    try {
      child = spawn(cmd, ['-y', DSH_SPEC, '--version'], {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: backendCwd,
      });
    } catch (e) {
      done(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (e) {}
      done(null);
    }, 20000);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', () => done(null));
    child.on('close', () => {
      const m = out.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
      done(m ? m[1] : null);
    });
  });
}

function sendStatus(title, detail = '', ready = false, isUpdate = false, version = null) {
  const payload = {
    title,
    detail,
    ready,
    isUpdate,
    version: version || dshVersion,
  };
  // Title bar selalu live (hanya memakai teks versi).
  const twc = getTitleWC();
  if (twc) twc.send('status-update', payload);
  // Splash mungkin belum siap: antrekan status terakhir, flush saat did-finish-load.
  const cwc = getContentWC();
  if (cwc && contentReady) {
    cwc.send('status-update', payload);
  } else {
    pendingStatus = payload;
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
      label: dshVersion ? `Versi Paket: v${dshVersion}` : 'DeepSeek Harness Desktop',
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
        const wc = getContentWC();
        if (serverUrl && wc) {
          wc.loadURL(serverUrl);
        } else if (wc) {
          wc.reload();
        }
      },
    },
    {
      label: 'Restart Server Backend',
      click: () => {
        serverUrl = null;
        updateTrayMenu();
        stopDshBackend();
        const wc = getContentWC();
        if (wc) {
          contentReady = false; // antrekan status sampai splash baru siap
          wc.loadFile(path.join(__dirname, 'loading.html'));
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

// --- 4. CREATE WINDOW (BaseWindow + 2 WebContentsView bertumpuk) ---
// Solusi overlap tombol caption: tombol Window Controls Overlay melayang di
// kanan-atas [titleBarView 40px] milik kita (drag region + nama app + versi),
// sedangkan UI dsh hidup di [contentView] yang dimulai DI BAWAH bar tersebut.
// Karena keduanya view terpisah (bukan satu halaman), overlap mustahil terjadi
// apa pun isi DOM dsh — tahan terhadap update backend.
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed() || !contentView) return;
  const [w, h] = mainWindow.getContentSize();
  if (titleBarView) {
    titleBarView.setBounds({ x: 0, y: 0, width: w, height: TITLEBAR_HEIGHT });
  }
  const top = titleBarView ? TITLEBAR_HEIGHT : 0;
  contentView.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
}

function viewWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  };
}

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BaseWindow({
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
    // Seamless native look: title bar bawaan OS disembunyikan, diganti
    // Window Controls Overlay (tombol min/max/close tetap native) yang
    // warnanya (#1c1c1c) menyatu dengan title bar kita. Set SEAMLESS_TITLEBAR
    // false untuk kembali ke frame native satu-view (tanpa title bar custom).
    titleBarStyle: SEAMLESS_TITLEBAR ? 'hidden' : 'default',
    ...(SEAMLESS_TITLEBAR && process.platform !== 'darwin'
      ? { titleBarOverlay: { color: '#1c1c1c', symbolColor: '#e2e8f0' } }
      : {}),
    ...(SEAMLESS_TITLEBAR && process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 12 } }
      : {}),
  });

  if (SEAMLESS_TITLEBAR) {
    titleBarView = new WebContentsView({ webPreferences: viewWebPreferences() });
    titleBarView.setBackgroundColor('#1c1c1c');
    mainWindow.contentView.addChildView(titleBarView);
    titleBarView.webContents.loadFile(path.join(__dirname, 'titlebar.html'));
  }

  contentView = new WebContentsView({ webPreferences: viewWebPreferences() });
  contentView.setBackgroundColor('#1c1c1c');
  mainWindow.contentView.addChildView(contentView);

  layoutViews();

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  Menu.setApplicationMenu(null);

  // Jaga layout dua view saat resize/maximize/fullscreen + simpan state
  const relayout = () => {
    layoutViews();
    saveWindowState();
  };
  mainWindow.on('resize', relayout);
  mainWindow.on('move', () => saveWindowState());
  mainWindow.on('maximize', relayout);
  mainWindow.on('unmaximize', relayout);
  mainWindow.on('enter-full-screen', relayout);
  mainWindow.on('leave-full-screen', relayout);
  // Ukuran konten final baru valid setelah window benar-benar di-show
  // (maximize/restore saat hidden tidak selalu memicu event susulan,
  // sehingga layout awal bisa tertinggal sekecil ukuran restore).
  mainWindow.on('show', () => layoutViews());

  // Tangani shortcut keyboard langsung tanpa menu bar (di view konten)
  contentView.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Ctrl+R atau F5 untuk Reload
    if ((input.control && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      const wc = getContentWC();
      if (serverUrl && wc) {
        wc.loadURL(serverUrl);
      } else if (wc) {
        wc.reload();
      }
    }

    // Ctrl+Shift+I atau F12 untuk DevTools
    if ((input.control && input.shift && input.key.toLowerCase() === 'i') || input.key === 'F12') {
      const wc = getContentWC();
      if (wc) wc.toggleDevTools();
    }

    // F11 untuk Fullscreen
    if (input.key === 'F11') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  // Tampilkan splash loading terlebih dahulu di view konten
  contentView.webContents.loadFile(path.join(__dirname, 'loading.html'));

  let windowShown = false;
  contentView.webContents.on('did-finish-load', () => {
    contentReady = true;
    // Flush status yang tiba sebelum splash siap (mis. hasil cek versi npm).
    if (pendingStatus) {
      const wc = getContentWC();
      if (wc) wc.send('status-update', pendingStatus);
      pendingStatus = null;
    }
    if (!windowShown) {
      windowShown = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
      }
    }
  });
  // Pengaman: jangan sampai window tak terlihat selamanya bila event di atas gagal.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 10000);

  mainWindow.on('close', () => {
    saveWindowState();
  });

  mainWindow.on('closed', () => {
    // BaseWindow TIDAK menghancurkan webContents view otomatis; tutup manual anti memory-leak.
    try { titleBarView?.webContents.close(); } catch (e) {}
    try { contentView?.webContents.close(); } catch (e) {}
    mainWindow = null;
    titleBarView = null;
    contentView = null;
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

// Cek apakah server di URL bare meminta autentikasi token sesi.
// dsh web menjawab 401 "authentication required" untuk URL tanpa ?token=,
// jadi URL bare TIDAK boleh di-load langsung (harus tunggu URL bertoken dari stdout).
function serverNeedsAuth(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 401) {
        res.resume();
        resolve(false);
        return;
      }
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => resolve(raw.includes('authentication required')));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sameOrigin(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

function urlHasToken(u) {
  try {
    return new URL(u).searchParams.has('token');
  } catch {
    return false;
  }
}

let loadGeneration = 0;

function loadTarget(url) {
  if (serverUrl === url) return;
  // Jangan downgrade URL bertoken (?token=...) ke URL bare untuk origin yang sama.
  // URL bare tanpa token selalu dijawab 401 "authentication required" oleh dsh web.
  if (serverUrl && sameOrigin(serverUrl, url) && urlHasToken(serverUrl) && !urlHasToken(url)) {
    console.log(`[DSH Launcher] Mengabaikan URL bare (butuh token): ${url}`);
    return;
  }
  serverUrl = url;
  const myGeneration = ++loadGeneration;
  console.log(`[DSH Launcher] Membuka URL di jendela desktop: ${url}`);
  logToFile('INFO', `loadTarget: ${url}`);
  updateTrayMenu();
  sendStatus('Server siap! Membuka antarmuka...', `Terhubung ke ${url}`, true);

  setTimeout(() => {
    if (myGeneration !== loadGeneration) return; // sudah ada navigasi lebih baru, jangan ganggu
    const wc = getContentWC();
    if (wc) {
      wc.loadURL(url).catch((err) => {
        if (myGeneration !== loadGeneration) return; // abort akibat navigasi baru (mis. upgrade bare->token) bukan error beneran
        console.warn('loadURL gagal, mencoba lagi...', err);
        setTimeout(() => {
          if (myGeneration !== loadGeneration) return;
          const wc2 = getContentWC();
          if (wc2) {
            wc2.loadURL(url).catch(() => {});
          }
        }, 400);
      });
    }
  }, 300);
}

// --- 6. BACKGROUND PROCESS & ROBUST SHUTDOWN ---
function startBackendProcess() {
  console.log('[DSH Launcher] Memulai background process dsh...');
  sendStatus('Memeriksa pembaruan & memuat dsh...', `Menjalankan npx ${DSH_SPEC} web --no-open`);

  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  // --no-open: jangan biarkan dsh membuka browser eksternal sendiri;
  // autentikasi dilakukan di dalam jendela Electron via URL bertoken.
  const args = ['-y', DSH_SPEC, 'web', '--no-open'];
  logToFile('INFO', `spawn: ${cmd} ${args.join(' ')} (cwd=${backendCwd})`);

  const errorLogs = [];

  dshProcess = spawn(cmd, args, {
    shell: true,
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    cwd: backendCwd,
  });

  // Buffer per-baris: satu baris log 'dsh web: <url>' bisa terbelah
  // menjadi beberapa chunk stdout, jadi rakit dulu sampai newline.
  let stdoutBuffer = '';

  // dsh web mencetak URL lengkap dengan token sesi satu-kali, mis.:
  //   dsh web: http://127.0.0.1:3080/?token=xxxx
  // Token WAJIB dipertahankan: URL bare tanpa ?token= selalu dijawab
  // 401 "dsh web authentication required; reopen the URL printed by dsh web."
  function extractTargetUrl(output) {
    const dshLine = output.match(/dsh web:\s*(https?:\/\/(?:localhost|127\.0\.0\.1):[0-9]+[^\s"'<>]*)/i);
    const generic = dshLine || output.match(/https?:\/\/(?:localhost|127\.0\.0\.1):[0-9]+[^\s"'<>]*/i);
    if (!generic) return null;
    // dshLine punya capture group [1]; fallback generic hanya [0].
    const raw = generic[1] ?? generic[0];
    // Buang tanda baca trailing yang ikut tercapture dari log, mis. ")" pada "(LAN: ...)".
    return raw.replace(/[).,;:'"]+$/, '');
  }

  const handleBackendLine = (output, isPartial = false) => {
    if (!output) return;
    if (!isPartial) {
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
    }

    const found = extractTargetUrl(output);
    if (found) {
      loadTarget(found);
    }
  };

  const onDataOutput = (data) => {
    stdoutBuffer += data.toString();
    const parts = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = parts.pop();
    for (const line of parts) {
      handleBackendLine(line.trim());
    }
    // Baris 'dsh web:' yang belum diakhiri newline tetap dicoba (kasus flush tanpa newline).
    if (stdoutBuffer.includes('dsh web:')) {
      handleBackendLine(stdoutBuffer.trim(), true);
    }
  };

  dshProcess.stdout.on('data', onDataOutput);
  dshProcess.stderr.on('data', (data) => {
    const errText = data.toString().trim();
    console.warn(`[DSH stderr]: ${errText}`);
    logToFile('STDERR', errText.split('\n')[0]);
    errorLogs.push(errText);
    onDataOutput(data);
  });

  dshProcess.on('exit', async (code, signal) => {
    console.log(`[DSH Launcher] Background process keluar (code: ${code}, signal: ${signal})`);
    logToFile('INFO', `backend exit: code=${code} signal=${signal}`);
    if (!isQuitting && !serverUrl) {
      const active = await scanForActiveServer();
      if (active && !(await serverNeedsAuth(active))) {
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
    const msg = `Gagal menjalankan backend: ${err.message || err} (pastikan Node.js/npx terinstall & ada di PATH; perintah: ${cmd} ${args.join(' ')}, cwd: ${backendCwd})`;
    console.error('[DSH Launcher]', msg);
    logToFile('ERROR', msg);
    // Jangan pernah bisu: di packaged app tak ada console untuk melihat error ini.
    if (!isQuitting && !serverUrl && mainWindow && !mainWindow.isDestroyed()) {
      sendStatus('Gagal menjalankan backend', String(err.message || err));
      dialog.showErrorBox('Gagal Menjalankan Backend', msg);
    }
  });
}

function initDsh() {
  // 0a. Versi tag registry (cepat; tampilan awal + info ketersediaan update).
  fetchLatestNpmVersion().then((ver) => {
    if (ver && !dshVersion) {
      dshVersion = ver;
      logToFile('INFO', `registry ${DSH_TAG} version: ${ver}`);
      updateTrayMenu();
      sendStatus('Memeriksa pembaruan & memuat dsh...', `Versi paket: ${DSH_SPEC}@${ver}`);
    }
  });

  // 0b. Versi backend yang benar-benar berjalan (otoritatif, paralel).
  // Mengoreksi tampilan bila berbeda dari tag registry.
  measureBackendVersion().then((ver) => {
    if (ver && ver !== dshVersion) {
      dshVersion = ver;
      console.log(`[DSH Launcher] Versi backend terukur: ${ver}`);
      logToFile('INFO', `measured backend version: ${ver}`);
      updateTrayMenu();
      sendStatus('Memeriksa pembaruan & memuat dsh...', `Backend berjalan: ${DSH_SPEC}@${ver}`);
    }
  });

  // 1. Cek langsung apakah ada server yang sudah hidup
  scanForActiveServer().then(async (activeUrl) => {
    if (activeUrl) {
      if (await serverNeedsAuth(activeUrl)) {
        // Server lama terdeteksi tapi mengunci token sesi milik proses lain.
        // Jangan load URL bare (pasti 401); lanjut spawn backend sendiri
        // yang akan mencetak URL bertoken miliknya via stdout.
        console.log(`[DSH Launcher] Server di ${activeUrl} butuh token sesi, menunggu URL bertoken dari backend...`);
        sendStatus(
          'Menyiapkan sesi terautentikasi...',
          'Server lama terdeteksi, meminta URL bertoken baru dari backend'
        );
      } else {
        loadTarget(activeUrl);
        return;
      }
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
        // Server fresh selalu 401 sampai URL bertoken dari stdout di-load;
        // jangan menangkan race dengan URL bare.
        if (await serverNeedsAuth(aliveUrl)) {
          return;
        }
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
      // Sinkron: taskkill HARUS tuntas sebelum proses Electron keluar,
      // kalau tidak backend tertinggal sebagai zombie yang mengunci port
      // (terjadi saat kill eksternal seperti SIGTERM/timeout).
      spawnSync('taskkill', ['/pid', pid.toString(), '/f', '/t']);
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
  logToFile('INFO', `=== session start: electron=${process.versions.electron} node=${process.version} spec=${DSH_SPEC} cwd=${backendCwd} ===`);
  createWindow();
  createTray();
  initDsh();

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) {
      createWindow();
      const wc = getContentWC();
      if (serverUrl && wc) {
        wc.loadURL(serverUrl);
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
