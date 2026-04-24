/**
 * Scout Tester — Configuration
 *
 * Loads environment variables from .env and exposes all runtime constants.
 * This module is imported for side effects (env loading, directory creation)
 * and for its named exports. It is the single source of truth for paths,
 * Scout API endpoints, country lists, and batch defaults.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Root ───

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = join(__dirname, '..', '..');

// ─── Environment Loader ───

export function loadEnv() {
  const envPath = join(ROOT_DIR, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

// ─── Server ───

export const PORT = parseInt(process.env.PORT || '3004', 10);

// ─── Scout API ───

export const SCOUT_API = 'https://api.scout.sentinel.co/api/v1/probe/sync';
export const SCOUT_USER_URL = 'https://api.scout.sentinel.co/api/v1/user';
export const SCOUT_TIMEOUT_MS = 45000;

// ─── Countries ───

const FALLBACK_COUNTRIES_ALL = [
  'US', 'GB', 'DE', 'FR', 'CA', 'AU', 'NL', 'SE', 'NO', 'DK', 'FI',
  'CH', 'AT', 'BE', 'IE', 'ES', 'IT', 'PT', 'PL', 'CZ', 'RO', 'HU',
  'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'GR', 'CY', 'MT', 'LU',
  'JP', 'KR', 'SG', 'HK', 'TW', 'IN', 'ID', 'TH', 'MY', 'PH', 'VN',
  'BR', 'MX', 'AR', 'CL', 'CO', 'PE', 'ZA', 'NG', 'KE', 'EG',
  'IL', 'AE', 'TR', 'SA', 'RU', 'UA', 'NZ',
];

export let COUNTRIES_ALL = [...FALLBACK_COUNTRIES_ALL];
export let COUNTRIES_DEFAULT = [];

export const SCOUT_COUNTRIES_API = 'https://api.scout.sentinel.co/api/v1/generic/countries';

/**
 * Fetches countries from Scout API and updates COUNTRIES_ALL and COUNTRIES_DEFAULT.
 * Falls back to hardcoded list if API is unavailable.
 * COUNTRIES_DEFAULT is randomly selected 3 countries from COUNTRIES_ALL.
 */
export async function initCountries() {
  try {
    const response = await fetch(SCOUT_COUNTRIES_API, { timeout: 10000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const countries = data.countries || [];
    const codes = countries.map((c) => c.code).filter((code) => code);

    if (codes.length > 0) {
      COUNTRIES_ALL = codes;
      // Randomly pick 3 from COUNTRIES_ALL for COUNTRIES_DEFAULT
      const shuffled = [...codes].sort(() => Math.random() - 0.5);
      COUNTRIES_DEFAULT = shuffled.slice(0, Math.min(3, shuffled.length));
      return;
    }
  } catch (err) {
    console.warn(`[scout] Failed to fetch countries from API: ${err.message}`);
  }

  // Fallback: use hardcoded list
  COUNTRIES_ALL = [...FALLBACK_COUNTRIES_ALL];
  const shuffled = [...FALLBACK_COUNTRIES_ALL].sort(() => Math.random() - 0.5);
  COUNTRIES_DEFAULT = shuffled.slice(0, 3);
}

// ─── Batch Settings ───

export const BATCH_SIZE = 5;
export const BATCH_GAP = 500;
export const REAL_BLOCK_MS = 2000;

// ─── Data Paths ───

export const DATA_DIR = join(ROOT_DIR, 'data');
export const PAUSED_RUN_FILE = join(DATA_DIR, 'paused-run.json');
export const RESULTS_FILE = join(DATA_DIR, 'results.json');
export const SITES_FILE = join(DATA_DIR, 'sites.json');
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
export const RUNS_DIR = join(DATA_DIR, 'runs');
export const RUNS_INDEX = join(RUNS_DIR, 'index.json');

// ─── Ensure Directories ───

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
