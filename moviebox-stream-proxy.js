'use strict';
const crypto = require('crypto');
const { URL } = require('url');

const CDN_DOMAINS = ['hakunaymatata.com', 'aoneroom.com', 'zstlab.cyou', 'aisports.mobi', 'bcdnxw.hakunaymatata.com', 'sbcdnw.hakunaymatata.com'];
const TARGET_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TARGETS = 20000;

const targets = new Map();
const targetKeys = new Map();

function allowed(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname || '';
    return CDN_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

function remember(url, headers) {
  if (!allowed(url)) throw new Error('Invalid media target');
  const key = crypto.createHash('sha256').update(JSON.stringify([url, headers || {}])).digest('hex');
  const now = Date.now();
  const existing = targetKeys.get(key);
  if (existing && targets.has(existing) && targets.get(existing).expires > now) {
    return existing;
  }
  const token = crypto.randomBytes(18).toString('base64url');
  targets.set(token, { expires: now + TARGET_TTL_MS, url, headers: { ...headers }, key });
  targetKeys.set(key, token);
  return token;
}

async function fetchUpstream(url, headers, method, redirects = 0) {
  const res = await fetch(url, { method, headers, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirects >= 4) throw new Error('Invalid redirect');
    const loc = res.headers.get('location');
    if (!loc) throw new Error('Invalid redirect');
    return fetchUpstream(new URL(loc, url).toString(), headers, method, redirects + 1);
  }
  return { res, finalUrl: url, finalHeaders: headers };
}

function mount(app, resolveResources, resolveSports) {
  const segmentHandler = async (req, res) => {
    try {
      const token = req.params.token;
      const entry = targets.get(token);
      if (!entry || entry.expires <= Date.now()) {
        return res.status(410).json({ ok: false, error: 'Link expired' });
      }

      const isDownload = req.query.download === '1';
      const baseHeaders = { ...(entry.headers || {}) };
      baseHeaders['User-Agent'] = baseHeaders['User-Agent'] || 'Mozilla/5.0';

      const { res: up } = await fetchUpstream(entry.url, baseHeaders, req.method);
      
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = up.headers.get(h);
        if (v) res.set(h, v);
      }

      // اگر ڈاؤن لوڈ لنک ہے تو براؤزر اسے ڈائریکٹ فائل کے طور पर ڈاؤن لوڈ کرے گا
      if (isDownload) {
        res.set('Content-Disposition', 'attachment; filename="movie-download.mp4"');
      } else {
        res.set('Content-Disposition', 'inline');
      }

      res.status(up.status);
      if (!up.body) return res.end();

      const reader = up.body.getReader();
      for (;;) {
        const { done, value } = await reader.end || await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) res.status(502).json({ ok: false, error: 'Stream error' });
      else res.end();
    }
  };

  return { segmentHandler };
}

module.exports = { mount, remember, allowed };
