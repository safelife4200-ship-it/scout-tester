/**
 * Scout Tester — Runner Pipeline
 *
 * Orchestrates test execution: batch runs, fire-all runs, retry rounds,
 * and single-site runs. Owns the active run lifecycle (start → record →
 * finalize), credit polling, and phase broadcasting. Depends on probe for
 * network calls and results for persistence.
 */

import { SCOUT_USER_URL, COUNTRIES_ALL } from '../config/index.js';
import { rawProbe } from '../probe/index.js';
import { getActiveCountries } from '../countries/index.js';
import { getResults, loadSites, saveTestResult, getScoutKey } from '../results/index.js';
import {
  loadRunsIndex, saveRunsIndex,
  saveRunData, clearPausedRun, savePausedRun,
} from '../runs/index.js';
import {
  setTesting, isTesting, setPhase, setSitesProcessed, setSitesTotal,
  getActiveRun, setActiveRun, broadcast,
} from '../state/index.js';
import { getSettings } from './settings.js';
import { logger } from '../logger/index.js';

// ─── Helpers ───

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Active Run Tracking ───

let cachedIndex = null;

function getCachedIndex() {
  if (!cachedIndex) cachedIndex = loadRunsIndex();
  return cachedIndex;
}

function startRun(type) {
  const index = getCachedIndex();
  const runNumber = index.runs.length > 0
    ? Math.max(...index.runs.map((r) => r.number)) + 1
    : 1;

  const run = {
    number: runNumber, type,
    label: `Test #${runNumber}`,
    startedAt: new Date().toISOString(),
    endedAt: null, durationMs: 0,
    creditsStart: null, creditsEnd: null, creditsSpent: null,
    totalProbes: 0, passProbes: 0, failProbes: 0, realBlocks: 0,
    totalBandwidth: 0, sitesTotal: 0, sitesProcessed: 0, siteResults: {},
  };
  setActiveRun(run);

  index.activeRun = runNumber;
  setTimeout(() => { try { saveRunsIndex(index); } catch {} }, 0);

  broadcast('run-start', { id: runNumber, type, startedAt: run.startedAt });
  return run;
}

function continueRun(type) {
  const index = getCachedIndex();
  const lastRun = index.runs.length > 0 ? index.runs[index.runs.length - 1] : null;
  const runNumber = lastRun ? lastRun.number : 1;
  const prevCreditsStart = lastRun?.creditsStart ?? null;

  const run = {
    number: runNumber, type,
    label: `Test #${runNumber}`,
    startedAt: new Date().toISOString(),
    endedAt: null, durationMs: 0,
    creditsStart: prevCreditsStart, creditsEnd: null, creditsSpent: lastRun?.creditsSpent ?? null,
    totalProbes: 0, passProbes: 0, failProbes: 0, realBlocks: 0,
    totalBandwidth: 0, sitesTotal: 0, sitesProcessed: 0, siteResults: {},
  };
  setActiveRun(run);

  index.activeRun = runNumber;
  setTimeout(() => { try { saveRunsIndex(index); } catch {} }, 0);

  broadcast('run-start', { id: runNumber, type, startedAt: run.startedAt });
  return run;
}

function recordProbe(url, nr) {
  const run = getActiveRun();
  if (!run) return;
  run.totalProbes++;
  if (nr.passed) run.passProbes++;
  else run.failProbes++;
  if (!nr.passed && nr.responseTime >= 2000) run.realBlocks++;
  run.totalBandwidth += nr.contentLength || 0;
}

function recordSiteResult(url, verdict) {
  const run = getActiveRun();
  if (!run) return;
  run.siteResults[url] = verdict;
  run.sitesProcessed = Object.keys(run.siteResults).length;
}

function emitRunUpdate() {
  const run = getActiveRun();
  if (!run) return;
  broadcast('run-update', {
    id: run.number,
    totalProbes: run.totalProbes,
    passProbes: run.passProbes,
    failProbes: run.failProbes,
    totalBandwidth: run.totalBandwidth,
    creditsSpent: run.creditsSpent,
  });
}

async function finalizeRun() {
  const run = getActiveRun();
  if (!run) return null;

  run.endedAt = new Date().toISOString();
  const thisSegment = Date.now() - new Date(run.resumedAt || run.startedAt).getTime();
  run.durationMs = (run.elapsedBeforePause || 0) + thisSegment;
  clearPausedRun();

  const SCOUT_KEY = getScoutKey();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(SCOUT_USER_URL, { headers: { 'Authorization': SCOUT_KEY } });
      const data = await r.json();
      run.creditsEnd = data.credit_coin ?? null;
      if (run.creditsEnd !== null) {
        if (run.creditsStart === null) run.creditsStart = run.creditsEnd;
        run.creditsSpent = +(run.creditsStart - run.creditsEnd).toFixed(2);
      }
      break;
    } catch (err) {
      logger.warn(`Failed to fetch end credits (attempt ${attempt + 1}): ${err.message}`);
      if (attempt === 0) await sleep(2000);
    }
  }
  if (run.creditsSpent === null) run.creditsSpent = 0;

  const pass = Object.values(run.siteResults).filter((v) => v === 'PASS').length;
  const fail = Object.values(run.siteResults).filter((v) => v === 'FAIL').length;
  run.summary = { pass, fail, tested: pass + fail };

  const meta = {
    number: run.number, type: run.type, label: run.label,
    startedAt: run.startedAt, endedAt: run.endedAt, durationMs: run.durationMs,
    creditsStart: run.creditsStart, creditsEnd: run.creditsEnd, creditsSpent: run.creditsSpent,
    totalProbes: run.totalProbes, passProbes: run.passProbes, failProbes: run.failProbes,
    realBlocks: run.realBlocks, totalBandwidth: run.totalBandwidth,
    sitesTotal: run.sitesTotal, sitesProcessed: run.sitesProcessed,
    summary: run.summary,
  };

  saveRunData(run.number, { meta, siteResults: run.siteResults });

  const index = loadRunsIndex();
  const existingIdx = index.runs.findIndex((r) => r.number === run.number);
  if (existingIdx >= 0) index.runs[existingIdx] = meta;
  else index.runs.push(meta);
  index.activeRun = null;
  saveRunsIndex(index);
  cachedIndex = index;

  broadcast('run-end', { ...meta, siteResults: run.siteResults });
  setActiveRun(null);
  return run;
}

// ─── Single Site Test ───

async function testSite(site, useAllCountries = false) {
  const SCOUT_KEY = getScoutKey();
  const countries = useAllCountries ? COUNTRIES_ALL : getActiveCountries();

  // Validate that all country codes are from the API-fetched list
  const validCountries = countries.filter((c) => COUNTRIES_ALL.includes(c));
  if (validCountries.length < countries.length) {
    const invalid = countries.filter((c) => !COUNTRIES_ALL.includes(c));
    logger.warn(`Skipping ${invalid.length} unsupported country code(s): ${invalid.join(', ')}`);
  }

  const probeResults = await Promise.all(
    validCountries.map((country) => rawProbe(site.url, country, SCOUT_KEY)),
  );

  for (const nr of probeResults) recordProbe(site.url, nr);

  const passed = probeResults.some((nr) => nr.passed);
  const shortUrl = site.url.replace(/^https?:\/\/(www\.)?/, '');
  broadcast('activity', {
    type: 'probe-done',
    message: `${passed ? 'PASS' : 'FAIL'} ${shortUrl}`,
    url: site.url,
  });

  return saveTestResult(site.url, site.category, probeResults, {
    recordSiteResult, broadcast,
  });
}

// ─── Batch Runner ───

async function runBatch(siteList, label, startOffset = 0, useAllCountries = false) {
  const SCOUT_KEY = getScoutKey();
  const { batchSize, batchGap } = getSettings();
  logger.info(`batch=${batchSize} gap=${batchGap}ms allCountries=${useAllCountries} sites=${siteList.length}`);

  let completed = 0;
  for (let i = 0; i < siteList.length; i += batchSize) {
    if (!isTesting()) break;
    const batch = siteList.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(siteList.length / batchSize);
    broadcast('activity', {
      type: 'batch',
      message: `Batch ${batchNum}/${totalBatches} — ${batch.length} sites (${startOffset + completed}/${getActiveRun()?.sitesTotal ?? siteList.length} done)`,
    });

    await Promise.all(batch.map(async (site) => {
      await testSite(site, useAllCountries);
      completed++;
      setSitesProcessed(startOffset + completed);
      emitRunUpdate();
    }));

    const run = getActiveRun();
    if (run) {
      emitRunUpdate();
      fetch(SCOUT_USER_URL, { headers: { 'Authorization': SCOUT_KEY } })
        .then((r) => r.json())
        .then((data) => {
          const current = getActiveRun();
          if (data.credit_coin != null && current) {
            if (current.creditsStart === null) current.creditsStart = data.credit_coin;
            current.creditsSpent = +(current.creditsStart - data.credit_coin).toFixed(2);
            broadcast('run-update', { id: current.number, creditsSpent: current.creditsSpent });
          }
        })
        .catch(() => {});
    }

    if (i + batchSize < siteList.length && isTesting() && batchGap > 0) await sleep(batchGap);
  }
}

// ─── Fire All Runner ───

async function runFireAll(siteList, label, startOffset = 0, useAllCountries = false) {
  const SCOUT_KEY = getScoutKey();
  broadcast('activity', {
    type: 'fire-all',
    message: `${label} — firing ALL ${siteList.length} sites simultaneously`,
  });

  let completed = 0;
  await Promise.all(siteList.map(async (site) => {
    await testSite(site, useAllCountries);
    completed++;
    setSitesProcessed(startOffset + completed);
    emitRunUpdate();
  }));

  const run = getActiveRun();
  if (run) {
    try {
      const r = await fetch(SCOUT_USER_URL, { headers: { 'Authorization': SCOUT_KEY } });
      const data = await r.json();
      const currentCredits = data.credit_coin ?? null;
      if (run.creditsStart !== null && currentCredits !== null) {
        run.creditsSpent = +(run.creditsStart - currentCredits).toFixed(2);
        broadcast('credits-update', { credits: currentCredits, spent: run.creditsSpent });
      }
    } catch {}
  }
}

async function runSites(siteList, label, startOffset = 0, useAllCountries = false) {
  const { fireAllMode } = getSettings();
  if (fireAllMode) await runFireAll(siteList, label, startOffset, useAllCountries);
  else await runBatch(siteList, label, startOffset, useAllCountries);
}

// ─── Finish ───

async function finish() {
  setTesting(false);
  setPhase('idle');
  setSitesProcessed(0);
  setSitesTotal(0);

  const finishedRun = await finalizeRun();

  const sites = loadSites();
  const results = getResults();
  const pass = sites.filter((s) => results[s.url]?.verdict === 'PASS').length;
  const fail = sites.filter((s) => results[s.url]?.verdict === 'FAIL').length;
  const untested = sites.filter((s) => !results[s.url]).length;

  broadcast('done', { pass, fail, untested, run: finishedRun });
  broadcast('phase', {
    phase: 'idle',
    message: `Done — ${pass} pass, ${fail} fail, ${untested} untested`,
  });
}

// ─── Auto Run ───

export async function autoRun(type = 'full') {
  setTesting(true);
  setSitesProcessed(0);
  const sites = loadSites();
  const results = getResults();
  const SCOUT_KEY = getScoutKey();
  const { fireAllMode, batchSize, autoRetestEnabled, autoRetestMax, expandCountriesAfter } = getSettings();

  logger.info(`Starting ${type} test run with ${sites.length} sites`);
  const run = startRun(type);
  run.elapsedBeforePause = 0;
  run.resumedAt = run.startedAt;

  for (const r of Object.values(results)) {
    run.totalProbes += r.totalProbes || 0;
    run.passProbes += r.passedProbes || 0;
    run.failProbes += (r.totalProbes || 0) - (r.passedProbes || 0);
    for (const nr of Object.values(r.nodeResults || {})) {
      run.totalBandwidth += nr.contentLength || 0;
    }
    run.siteResults[r.url] = r.verdict;
  }

  try {
    const cr = await fetch(SCOUT_USER_URL, { headers: { 'Authorization': SCOUT_KEY } });
    const cData = await cr.json();
    run.creditsStart = cData.credit_coin ?? null;
  } catch (err) {
    logger.warn(`Failed to fetch start credits: ${err.message}`);
  }

  const mode = fireAllMode ? 'fire-all' : `batch ${batchSize}`;

  if (type === 'retry') {
    const failed = sites.filter((s) => results[s.url]?.verdict === 'FAIL');
    run.sitesTotal = sites.length;
    setSitesTotal(sites.length);
    setSitesProcessed(sites.length - failed.length);
    setPhase('retrying');
    broadcast('phase', {
      phase: 'retrying', count: failed.length,
      message: `Test #${run.number} — Retrying ${failed.length} failed sites (${mode})...`,
    });
    await runSites(failed, `Test #${run.number} retry`, sites.length - failed.length);
  } else {
    const untested = sites.filter((s) => !results[s.url]);
    const failed = sites.filter((s) => results[s.url]?.verdict === 'FAIL');
    const alreadyPassed = sites.filter((s) => results[s.url]?.verdict === 'PASS').length;
    const allTargets = [...untested, ...failed];
    run.sitesTotal = sites.length;
    setSitesTotal(sites.length);
    setSitesProcessed(alreadyPassed);

    setPhase('scanning');
    broadcast('phase', {
      phase: 'scanning', count: allTargets.length,
      message: `Test #${run.number} — Testing ${allTargets.length} remaining of ${sites.length} sites (${mode})...`,
    });
    await runSites(allTargets, `Test #${run.number}`, alreadyPassed);
  }

  logger.info(`auto-retest check: testing=${isTesting()} enabled=${autoRetestEnabled} max=${autoRetestMax}`);
  if (isTesting() && autoRetestEnabled) {
    for (let retryRound = 1; retryRound <= autoRetestMax; retryRound++) {
      if (!isTesting()) break;
      const freshResults = getResults();
      const stillFailed = sites.filter((s) => freshResults[s.url]?.verdict === 'FAIL');
      if (stillFailed.length === 0) break;

      const useAll = retryRound >= expandCountriesAfter;
      const countryLabel = useAll ? 'all 61 countries' : `${getActiveCountries().length} countries`;

      setPhase('auto-retest');
      const retestCountries = useAll ? COUNTRIES_ALL : getActiveCountries();
      broadcast('phase', {
        phase: 'auto-retest', count: stillFailed.length, round: retryRound, maxRounds: autoRetestMax,
        countries: retestCountries,
        message: `Test #${run.number} — Retest ${retryRound}/${autoRetestMax}: ${stillFailed.length} sites (${countryLabel})...`,
      });
      await runSites(stillFailed, `Retest ${retryRound}/${autoRetestMax}`, sites.length - stillFailed.length, useAll);
    }
  }

  finish();
}

// ─── Retry Run ───

export async function retryRun(sites, failed) {
  setTesting(true);
  setSitesProcessed(0);
  const results = getResults();
  const SCOUT_KEY = getScoutKey();
  const { fireAllMode, batchSize, retryAllCountries, autoRetestEnabled, autoRetestMax, expandCountriesAfter } = getSettings();

  const run = continueRun('retry');

  for (const r of Object.values(results)) {
    run.totalProbes += r.totalProbes || 0;
    run.passProbes += r.passedProbes || 0;
    run.failProbes += (r.totalProbes || 0) - (r.passedProbes || 0);
    for (const nr of Object.values(r.nodeResults || {})) run.totalBandwidth += nr.contentLength || 0;
    run.siteResults[r.url] = r.verdict;
  }

  try {
    const cr = await fetch(SCOUT_USER_URL, { headers: { 'Authorization': SCOUT_KEY } });
    const cData = await cr.json();
    if (cData.credit_coin != null) run.creditsStart = cData.credit_coin;
  } catch (err) {
    logger.warn(`Failed to fetch start credits: ${err.message}`);
  }

  const useAll = retryAllCountries;
  const mode = fireAllMode ? 'fire-all' : `batch ${batchSize}`;
  const countryLabel = useAll ? 'all countries' : `${getActiveCountries().length} countries`;

  run.sitesTotal = sites.length;
  setSitesTotal(sites.length);
  setSitesProcessed(sites.length - failed.length);
  const retryCountries = useAll ? COUNTRIES_ALL : getActiveCountries();
  setPhase('retrying');
  broadcast('phase', {
    phase: 'retrying', count: failed.length,
    countries: retryCountries,
    message: `Test #${run.number} — Retrying ${failed.length} failed sites (${mode}, ${countryLabel})...`,
  });
  await runSites(failed, `Test #${run.number} retry`, sites.length - failed.length, useAll);

  if (isTesting() && autoRetestEnabled) {
    for (let retryRound = 1; retryRound <= autoRetestMax; retryRound++) {
      if (!isTesting()) break;
      const freshResults = getResults();
      const stillFailed = sites.filter((s) => freshResults[s.url]?.verdict === 'FAIL');
      if (stillFailed.length === 0) break;

      const useAllR = retryRound >= expandCountriesAfter;
      const cLabel = useAllR ? 'all 61 countries' : `${getActiveCountries().length} countries`;
      const retestCountriesR = useAllR ? COUNTRIES_ALL : getActiveCountries();

      setPhase('auto-retest');
      broadcast('phase', {
        phase: 'auto-retest', count: stillFailed.length, round: retryRound, maxRounds: autoRetestMax,
        countries: retestCountriesR,
        message: `Test #${run.number} — Retest ${retryRound}/${autoRetestMax}: ${stillFailed.length} sites (${cLabel})...`,
      });
      await runSites(stillFailed, `Retest ${retryRound}/${autoRetestMax}`, sites.length - stillFailed.length, useAllR);
    }
  }

  finish();
}

// ─── Test Single Site ───

export function testOneSite(site) {
  setTesting(true);
  setPhase('single');
  const SCOUT_KEY = getScoutKey();
  const run = startRun('single');
  run.sitesTotal = 1;

  (async () => {
    try {
      const r = await fetch(SCOUT_USER_URL, { headers: { 'Authorization': SCOUT_KEY } });
      const data = await r.json();
      run.creditsStart = data.credit_coin ?? null;
    } catch (err) {
      logger.warn(`Failed to fetch start credits: ${err.message}`);
    }

    if (isTesting()) await testSite(site);
    setTesting(false);
    setPhase('idle');
    await finalizeRun();
    broadcast('phase', { phase: 'idle', message: 'Single test complete' });
  })();

  return run;
}

// ─── Stop ───

export function stopRun() {
  setTesting(false);
  setPhase('idle');
  const run = getActiveRun();
  if (run) {
    run.pausedAt = new Date().toISOString();
    run.elapsedBeforePause = (run.elapsedBeforePause || 0) +
      (Date.now() - new Date(run.resumedAt || run.startedAt).getTime());
    savePausedRun(run);
    setActiveRun(null);
  }
  broadcast('phase', { phase: 'idle', message: 'Stopped — Resume to continue' });
}
