import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const defaultDataDir = resolve(process.cwd(), ".data");

export function createDurableStore(name, seedFactory) {
  const dataDir = resolve(process.env.DATA_DIR || defaultDataDir);
  const filePath = resolve(dataDir, `${name}.json`);
  let state = loadState(filePath, seedFactory);

  return {
    get state() {
      return state;
    },
    save() {
      atomicWriteJson(filePath, state);
      return state;
    },
    reset() {
      state = seedFactory();
      atomicWriteJson(filePath, state);
      return state;
    },
    update(mutator) {
      const result = mutator(state);
      atomicWriteJson(filePath, state);
      return result ?? state;
    }
  };
}

function loadState(filePath, seedFactory) {
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  }
  const state = seedFactory();
  atomicWriteJson(filePath, state);
  return state;
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmpPath, filePath);
}

