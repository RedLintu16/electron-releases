#!/usr/bin/env node

const { downloadArtifact } = require('@electron/get');

const extract = require('extract-zip');

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { version } = require('./package');

const platformPath = getPlatformPath();

const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
let arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;

console.log('[electron-install] Platform:', platform);
console.log('[electron-install] Arch:', arch);
console.log('[electron-install] Version:', version);
console.log('[electron-install] Platform path:', platformPath);

if (isInstalled()) {
  console.log('[electron-install] Already installed, exiting');
  process.exit(0);
}

console.log('[electron-install] Not installed, starting download...');

if (
  platform === 'darwin' &&
  process.platform === 'darwin' &&
  arch === 'x64' &&
  process.env.npm_config_arch === undefined
) {
  // When downloading for macOS ON macOS and we think we need x64 we should
  // check if we're running under rosetta and download the arm64 version if appropriate
  try {
    const output = childProcess.execSync('sysctl -in sysctl.proc_translated');
    if (output.toString().trim() === '1') {
      arch = 'arm64';
    }
  } catch {
    // Ignore failure
  }
}

// downloads if not cached
console.log('[electron-install] Downloading artifact with options:', {
  version,
  artifactName: 'electron',
  mirror: "https://github.com/castlabs/electron-releases/releases/download/",
  platform,
  arch,
  force: process.env.force_no_cache === 'true',
  cacheRoot: process.env.electron_config_cache
});

downloadArtifact({
  version,
  artifactName: 'electron',
  mirrorOptions: { mirror: "https://github.com/castlabs/electron-releases/releases/download/" },
  force: process.env.force_no_cache === 'true',
  cacheRoot: process.env.electron_config_cache,
  checksums:
    process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
      ? undefined
      : require('./checksums.json'),
  platform,
  arch
})
  .then((zipPath) => {
    console.log('[electron-install] Download complete, zip at:', zipPath);
    return extractFile(zipPath);
  })
  .then(() => {
    console.log('[electron-install] Extraction complete');
  })
  .catch((err) => {
    console.error('[electron-install] ERROR:', err.stack);
    process.exit(1);
  });

function isInstalled() {
  try {
    const installedVersion = fs.readFileSync(path.join(__dirname, 'dist', 'version'), 'utf-8').replace(/^v/, '');
    console.log('[electron-install] Installed version:', installedVersion, 'Expected:', version);
    if (installedVersion !== version) {
      console.log('[electron-install] Version mismatch');
      return false;
    }

    const installedPath = fs.readFileSync(path.join(__dirname, 'path.txt'), 'utf-8');
    console.log('[electron-install] Installed path:', installedPath, 'Expected:', platformPath);
    if (installedPath !== platformPath) {
      console.log('[electron-install] Path mismatch');
      return false;
    }
  } catch (err) {
    console.log('[electron-install] Version/path check failed:', err.message);
    return false;
  }

  const electronPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(__dirname, 'dist', platformPath);
  console.log('[electron-install] Checking if exists:', electronPath);
  const exists = fs.existsSync(electronPath);
  console.log('[electron-install] Exists:', exists);

  return exists;
}

// unzips and makes path.txt point at the correct executable
function extractFile(zipPath) {
  console.log('[electron-install] Extracting zip from:', zipPath);
  const distPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(__dirname, 'dist');
  const targetDir = path.join(__dirname, 'dist');
  console.log('[electron-install] Extracting to:', targetDir);

  // Check if zip exists and get its size
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Zip file not found: ${zipPath}`);
  }
  const zipStats = fs.statSync(zipPath);
  console.log('[electron-install] Zip file size:', (zipStats.size / 1024 / 1024).toFixed(2), 'MB');

  // Clear dist directory if it exists and has incomplete extraction
  if (fs.existsSync(targetDir)) {
    console.log('[electron-install] Clearing existing dist directory...');
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  console.log('[electron-install] Starting extraction (this may take a minute)...');
  const startTime = Date.now();

  // Try PowerShell extraction on Windows (more reliable than extract-zip for large files)
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      console.log('[electron-install] Using PowerShell Expand-Archive...');
      const psCommand = `Expand-Archive -Path "${zipPath}" -DestinationPath "${targetDir}" -Force`;
      childProcess.exec(psCommand, { shell: 'powershell.exe', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          console.error('[electron-install] PowerShell extraction failed:', err.message);
          console.error('[electron-install] stderr:', stderr);
          reject(err);
          return;
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[electron-install] Extraction successful in ${elapsed}s`);

        // List what was extracted
        const files = fs.readdirSync(targetDir);
        console.log('[electron-install] Extracted files:', files.join(', '));

        // If the zip contains an "electron.d.ts" file, move that up
        const srcTypeDefPath = path.join(distPath, 'electron.d.ts');
        const targetTypeDefPath = path.join(__dirname, 'electron.d.ts');
        const hasTypeDefinitions = fs.existsSync(srcTypeDefPath);

        if (hasTypeDefinitions) {
          console.log('[electron-install] Moving electron.d.ts');
          fs.renameSync(srcTypeDefPath, targetTypeDefPath);
        }

        // Write a "path.txt" file.
        console.log('[electron-install] Writing path.txt with:', platformPath);
        fs.promises.writeFile(path.join(__dirname, 'path.txt'), platformPath).then(resolve).catch(reject);
      });
    });
  }

  // Fallback to extract-zip for non-Windows platforms
  return extract(zipPath, { dir: targetDir }).then(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[electron-install] Extraction successful in ${elapsed}s`);

    // List what was extracted
    const files = fs.readdirSync(targetDir);
    console.log('[electron-install] Extracted files:', files.join(', '));

    // If the zip contains an "electron.d.ts" file, move that up
    const srcTypeDefPath = path.join(distPath, 'electron.d.ts');
    const targetTypeDefPath = path.join(__dirname, 'electron.d.ts');
    const hasTypeDefinitions = fs.existsSync(srcTypeDefPath);

    if (hasTypeDefinitions) {
      console.log('[electron-install] Moving electron.d.ts');
      fs.renameSync(srcTypeDefPath, targetTypeDefPath);
    }

    // Write a "path.txt" file.
    console.log('[electron-install] Writing path.txt with:', platformPath);
    return fs.promises.writeFile(path.join(__dirname, 'path.txt'), platformPath);
  }).catch((err) => {
    console.error('[electron-install] Extraction failed:', err.message);
    throw err;
  });
}

function getPlatformPath() {
  const platform = process.env.npm_config_platform || os.platform();

  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error('Electron builds are not available on platform: ' + platform);
  }
}
