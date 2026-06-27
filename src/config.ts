import fs from 'fs';
import path from 'path';

export interface ReverseChargeSupplier {
  pattern: string;
  region: 'EU' | 'NON_EU';
  name: string;
}

export interface ElsterConfig {
  auth: {
    pfxPath: string;
    password: string;
  };
  taxpayer: {
    taxNumber: string;
    stateCode: string;
    name: string;
    firstName: string;
    street: string;
    houseNumber: string;
    zip: string;
    city: string;
    country: string;
  };
  runtime: {
    downloadDir: string;
    screenshotDir: string;
    headless: boolean;
    browserArgs: string[];
  };
  ustva: {
    reverseChargeSuppliers: ReverseChargeSupplier[];
  };
  est: {
    skipEurPreHook: boolean;
  };
}

const DEFAULTS: ElsterConfig = {
  auth: { pfxPath: '', password: '' },
  taxpayer: {
    taxNumber: '', stateCode: '', name: '', firstName: '',
    street: '', houseNumber: '', zip: '', city: '', country: 'DE',
  },
  runtime: {
    downloadDir: './downloads',
    screenshotDir: './screenshots',
    headless: true,
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,1024',
    ],
  },
  ustva: { reverseChargeSuppliers: [] },
  est: { skipEurPreHook: false },
};

function readJson(file: string): Partial<ElsterConfig> {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function envOr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null) return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

let cached: ElsterConfig | null = null;

export function loadConfig(): ElsterConfig {
  if (cached) return cached;

  const configPath = envOr('ELSTER_CONFIG_PATH', './config.json');
  const fromFile = readJson(path.resolve(configPath));

  const merged: ElsterConfig = {
    auth: {
      pfxPath: envOr('ELSTER_PFX_PATH', fromFile.auth?.pfxPath ?? DEFAULTS.auth.pfxPath),
      password: envOr('ELSTER_PASSWORD', fromFile.auth?.password ?? DEFAULTS.auth.password),
    },
    taxpayer: {
      taxNumber: envOr('ELSTER_TAX_NUMBER', fromFile.taxpayer?.taxNumber ?? ''),
      stateCode: envOr('ELSTER_STATE_CODE', fromFile.taxpayer?.stateCode ?? ''),
      name: envOr('ELSTER_NAME', fromFile.taxpayer?.name ?? ''),
      firstName: envOr('ELSTER_FIRST_NAME', fromFile.taxpayer?.firstName ?? ''),
      street: envOr('ELSTER_STREET', fromFile.taxpayer?.street ?? ''),
      houseNumber: envOr('ELSTER_HOUSE_NUMBER', fromFile.taxpayer?.houseNumber ?? ''),
      zip: envOr('ELSTER_ZIP', fromFile.taxpayer?.zip ?? ''),
      city: envOr('ELSTER_CITY', fromFile.taxpayer?.city ?? ''),
      country: envOr('ELSTER_COUNTRY', fromFile.taxpayer?.country ?? 'DE'),
    },
    runtime: {
      downloadDir: envOr('ELSTER_DOWNLOAD_DIR', fromFile.runtime?.downloadDir ?? DEFAULTS.runtime.downloadDir),
      screenshotDir: envOr('ELSTER_SCREENSHOT_DIR', fromFile.runtime?.screenshotDir ?? DEFAULTS.runtime.screenshotDir),
      headless: envBool('ELSTER_HEADLESS', fromFile.runtime?.headless ?? DEFAULTS.runtime.headless),
      browserArgs: fromFile.runtime?.browserArgs ?? DEFAULTS.runtime.browserArgs,
    },
    ustva: {
      reverseChargeSuppliers: fromFile.ustva?.reverseChargeSuppliers ?? DEFAULTS.ustva.reverseChargeSuppliers,
    },
    est: {
      skipEurPreHook: envBool('ELSTER_EST_SKIP_EUR', fromFile.est?.skipEurPreHook ?? DEFAULTS.est.skipEurPreHook),
    },
  };

  for (const dir of [merged.runtime.downloadDir, merged.runtime.screenshotDir]) {
    try {
      const abs = path.resolve(dir);
      if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
    } catch { /* best effort */ }
  }

  cached = merged;
  return merged;
}

export function resetConfigCache(): void {
  cached = null;
}
