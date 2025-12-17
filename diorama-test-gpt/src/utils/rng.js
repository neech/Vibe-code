export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const WORLD_SEED_KEY = "diorama-test-gpt:seed";

export function hashStringToUint32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function parseSeed(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t) >>> 0;
  if (/^0x[0-9a-f]+$/i.test(t)) return Number(t) >>> 0;
  return hashStringToUint32(t);
}

export function resolveWorldSeed({ search = location.search, storage = sessionStorage } = {}) {
  const params = new URLSearchParams(search);
  const urlSeed = parseSeed(params.get("seed") ?? "");
  if (urlSeed != null) {
    try {
      storage.setItem(WORLD_SEED_KEY, String(urlSeed));
    } catch {
      // ignore
    }
    return urlSeed;
  }

  const stored = (() => {
    try {
      return parseSeed(storage.getItem(WORLD_SEED_KEY) ?? "");
    } catch {
      return null;
    }
  })();
  if (stored != null) return stored;

  const seedArr = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(seedArr);
  else seedArr[0] = (Math.random() * 0xffffffff) >>> 0;
  const seed = seedArr[0] >>> 0;
  try {
    storage.setItem(WORLD_SEED_KEY, String(seed));
  } catch {
    // ignore
  }
  return seed;
}
