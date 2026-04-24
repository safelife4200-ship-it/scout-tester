/**
 * Scout Tester — Scout API Probe
 *
 * Executes a single Scout block-check request against one (url, country)
 * pair. Handles timeouts, content-type sniffing, and heuristic block-signal
 * detection. Returns a normalised probe result object consumable by the
 * results layer.
 */

import { SCOUT_API, SCOUT_TIMEOUT_MS } from '../config/index.js';

// ─── Fetch With Timeout ───

export function fetchWithTimeout(fetchUrl, options, ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Timeout'));
    }, ms);
    fetch(fetchUrl, { ...options, signal: controller.signal })
      .then((r) => r.json())
      .then((data) => { clearTimeout(timer); resolve(data); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── Content Type Detection ───

export function detectDataType(content) {
  if (!content || content.length === 0) return 'Text';
  const head = content.slice(0, 512).trim();
  const lower = head.toLowerCase();

  if (head.startsWith('\x89PNG')) return 'Image/PNG';
  if (head.startsWith('\xFF\xD8\xFF')) return 'Image/JPEG';
  if (head.startsWith('GIF8')) return 'Image/GIF';
  if (head.startsWith('%PDF')) return 'PDF';
  if (head.startsWith('RIFF') && head.includes('WEBP')) return 'Image/WebP';
  if (head.startsWith('PK')) return 'Archive/ZIP';

  if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) return 'HTML';
  if (lower.startsWith('<?xml') || lower.startsWith('<rss') || lower.startsWith('<feed')) return 'XML';
  if (head.startsWith('{') || head.startsWith('[')) {
    try { JSON.parse(content.slice(0, 2000)); return 'JSON'; } catch {}
    return 'JSON';
  }
  if (lower.includes('<head') || lower.includes('<body') || lower.includes('<div')) return 'HTML';
  if (lower.startsWith('<!doctype')) return 'HTML';

  return 'Text';
}

// ─── Block Signal Detection ───

export function detectBlockSignals(html) {
  if (!html || html.length < 10) return [];
  const l = html.toLowerCase();
  const signals = [];
  if (l.includes('captcha') || l.includes('recaptcha') || l.includes('hcaptcha')) signals.push('CAPTCHA');
  if (l.includes('cloudflare') && (l.includes('challenge') || l.includes('ray id'))) signals.push('CLOUDFLARE');
  if (l.includes('access denied') || l.includes('403 forbidden')) signals.push('ACCESS_DENIED');
  if ((l.includes('robot') || l.includes('bot')) && (l.includes('detect') || l.includes('aren\'t') || l.includes('not a'))) signals.push('BOT_DETECT');
  if (l.includes('challenge') && (l.includes('browser') || l.includes('security') || l.includes('verification'))) signals.push('CHALLENGE');
  if (l.includes('enable javascript') || l.includes('javascript is disabled') || l.includes('javascript is required')) signals.push('JS_REQUIRED');
  if (l.includes('rate') && l.includes('limit')) signals.push('RATE_LIMIT');
  if (l.includes('unusual traffic') || (l.includes('sorry') && l.includes('unusual'))) signals.push('UNUSUAL_TRAFFIC');
  if (l.includes('verify') && (l.includes('human') || l.includes('you are') || l.includes('not a robot'))) signals.push('HUMAN_VERIFY');
  if (l.includes('blocked') && (l.includes('request') || l.includes('ip') || l.includes('access'))) signals.push('IP_BLOCKED');
  return signals;
}

// ─── Raw Probe ───

export async function rawProbe(url, country, scoutKey, opts = {}) {
  const start = Date.now();
  try {
    const data = await fetchWithTimeout(SCOUT_API, {
      method: 'POST',
      headers: { 'Authorization': scoutKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        countryCode: country,
        fallBackRouting: opts.fallBackRouting !== false,
        antiBotScrape: opts.antiBotScrape !== false,
        outputFileExtension: 'EXTENSION_HTML',
      }),
    }, SCOUT_TIMEOUT_MS);
    const elapsed = Date.now() - start;
    const content = data.file_content || '';
    const passed = data.state === 'complete' && content.length > 100;
    const dataType = detectDataType(content);
    const result = {
      passed, country, responseTime: elapsed, contentLength: content.length,
      dataType,
      errorCode: data.code || null, state: data.state || 'unknown',
      blockSignals: passed ? [] : detectBlockSignals(content),
      time: new Date().toISOString(),
    };
    console.log(`[scout] ${url.slice(0, 40)} [${country}] ${elapsed}ms → ${result.passed ? 'PASS' : 'FAIL'} (${result.state})`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`[scout] ${url.slice(0, 40)} [${country}] ${elapsed}ms → ERROR: ${err.message}`);
    return {
      passed: false, country, responseTime: elapsed, contentLength: 0,
      dataType: 'Text',
      errorCode: err.message, state: 'error', blockSignals: [],
      time: new Date().toISOString(),
    };
  }
}
