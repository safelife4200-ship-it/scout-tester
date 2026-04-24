/**
 * Scout Tester — Country Mode
 *
 * In-memory selection of which country codes Scout probes target. Mode
 * `default` uses FR/DE/GB; mode `all` expands to the full 61-country list.
 */

import { COUNTRIES_DEFAULT, COUNTRIES_ALL } from '../config/index.js';

let activeCountries = [];

// ─── Getters / Setters ───

export function getActiveCountries() {
  // Lazy init: if activeCountries is empty but COUNTRIES_DEFAULT is populated, use defaults
  if (activeCountries.length === 0 && COUNTRIES_DEFAULT.length > 0) {
    activeCountries = [...COUNTRIES_DEFAULT];
  }
  return activeCountries;
}

export function setCountryMode(mode) {
  if (mode === 'all') {
    activeCountries = [...COUNTRIES_ALL];
  } else {
    // default mode: use COUNTRIES_DEFAULT (from API)
    if (COUNTRIES_DEFAULT.length > 0) {
      activeCountries = [...COUNTRIES_DEFAULT];
    }
  }
  return activeCountries;
}

export function getCountryMode() {
  return activeCountries.length > COUNTRIES_DEFAULT.length ? 'all' : 'default';
}

export { COUNTRIES_DEFAULT, COUNTRIES_ALL };
