import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const defaultDataDir = resolve(process.cwd(), ".data");

export function createDurableStore(name, seedFactory) {
  const dataDir = resolve(process.env.DATA_DIR || defaultDataDir);
  const filePath = resolve(dataDir, `${name}.json`);
  const backupPath = `${filePath}.bak`;
  let state = loadState(filePath, backupPath, seedFactory);

  return {
    get state() {
      return state;
    },
    save() {
      atomicWriteJson(filePath, backupPath, state);
      return state;
    },
    reset() {
      state = seedFactory();
      atomicWriteJson(filePath, backupPath, state);
      return state;
    },
    update(mutator) {
      const result = mutator(state);
      atomicWriteJson(filePath, backupPath, state);
      return result ?? state;
    }
  };
}

function loadState(filePath, backupPath, seedFactory) {
  if (existsSync(filePath)) {
    try {
      return JSON.parse(readFileSync(filePath, "utf8"));
    } catch (error) {
      console.error(JSON.stringify({
        at: new Date().toISOString(),
        event: "store_load_failed",
        filePath,
        message: error.message
      }));
      const recovered = tryRestoreFromBackup(filePath, backupPath);
      if (recovered) return recovered;
      // Never crash-loop on a corrupt state file: quarantine it for forensics and reseed.
      // Under `restart: unless-stopped` orchestration, throwing here would restart forever
      // with the same corrupt file on disk.
      quarantine(filePath);
      const seeded = seedFactory();
      atomicWriteJson(filePath, backupPath, seeded);
      return seeded;
    }
  }
  const state = seedFactory();
  atomicWriteJson(filePath, backupPath, state);
  return state;
}

function tryRestoreFromBackup(filePath, backupPath) {
  if (!existsSync(backupPath)) return null;
  try {
    const state = JSON.parse(readFileSync(backupPath, "utf8"));
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "store_restored_from_backup",
      filePath,
      backupPath
    }));
    return state;
  } catch {
    return null;
  }
}

function quarantine(filePath) {
  try {
    const quarantinePath = `${filePath}.corrupt.${Date.now()}.json`;
    copyFileSync(filePath, quarantinePath);
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "store_quarantined",
      filePath,
      quarantinePath
    }));
  } catch (error) {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "store_quarantine_failed",
      filePath,
      message: error.message
    }));
  }
}

function atomicWriteJson(filePath, backupPath, value) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  if (existsSync(filePath)) {
    try {
      copyFileSync(filePath, backupPath);
    } catch {
      // Best-effort backup; do not block a save on it.
    }
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(tmpPath, payload);
  fsyncPath(tmpPath);
  renameSync(tmpPath, filePath);
  fsyncDir(dir);
}

function fsyncPath(path) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir) {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is unsupported on some platforms (notably Windows); skip silently.
  }
}
