'use strict';
/*
 * moviebox-stream-proxy.js — bounded streaming relay, server-side URLs and headers.
 *
 * Node port of the Python media relay. Upstream CDN URLs and playback headers
 * never leave the server: the player gets tokenized segment links on this host,
 * the relay replays the real request with the right Referer/cookie/UA. That is
 * what stops the 429s, the CDN is hit once, with the headers it wants, under a
 * concurrency cap.
 */

const crypto = require('crypto');
const { URL } = require('url');

const CDN_DOMAINS = ['hakunaymatata.com', 'aoneroom.com', 'zstlab.cyou', 'aisports.mobi'];
const MEDIA_BASE = process.env.MEDIA_BASE || 'http://localhost:8787/media/segment/';
const MAX_STREAMS = parseInt(process.env.MAX_STREAMS || '24', 10);
const MAX_MANIFEST = 4 * 1024 * 1024;
const TARGET_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TARGETS = 20000;

const SAFE_UPSTREAM_HEADERS = new Set([
  'referer', 'origin', 'user-agent', 'cookie', 'accept', 'accept-language',
]);

const targets = new Map();      // token -> {expires, url, headers, key}
const targetKeys = new Map();   // key   -> token
let active = 0;

function allowed(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    if (u.port && u.port !== '443') return false;
    const host = u.hostname || '';
    return CDN_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch (_) {
    return false;
  }
}

function remember(url, headers) {
  if (!allowed(url)) throw new Error('Invalid media target');
  const key = crypto.createHash('sha256')
    .update(JSON.stringify([url, headers || {}]))
    .digest('hex');
  const now = Date.now();
  const existing = targetKeys.get(key);
  if (existing && targets.has(existing) && targets.get(existing).expires > now) {
    return existing;
  }
  if (targets.size >= MAX_TARGETS) {
    for (const [tok, entry] of targets) {
      if (entry.expires <= now) { targets.delete(tok); targetKeys.delete(entry.key); }
    }
  }
  while (targets.size >= MAX_TARGETS) {
    const first = targets.keys().next().value;
    const entry = targets.get(first);
    targets.delete(first);
    if (entry) targetKeys.delete(entry.key);
  }
  const token = crypto.randomBytes(18).toString('base64url');
  targets.set(token, { expires: now + TARGET_TTL_MS, url, headers: { ...headers }, key });
  targetKeys.set(key, token);
  return token;
}

function childUrl(url, headers) {
  const token = remember(url, headers);
  const names = [...new Set([...url.matchAll(/\$(Number|Time|RepresentationID|Bandwidth)(?:%0\d+d)?\$/g)].map(m => m[1]))];
  const qs = names.map(n => `${n}=${n}`).join('&');
  return MEDIA_BASE + token + (qs ? '?' + qs : '');
}

function resolveUrl(base, rel) {
  try { return new URL(rel, base).toString(); } catch (_) { return rel; }
}

function rewriteHls(text, url, headers) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      out.push(line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${childUrl(resolveUrl(url, uri), headers)}"`));
    } else if (line.trim()) {
      out.push(childUrl(resolveUrl(url, line.trim()), headers));
    } else {
      out.push(line);
    }
  }
  return out.join('\n') + '\n';
}

function rewriteDash(xml, url, headers) {
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) throw new Error('Invalid manifest');
  const baseMatch = xml.match(/<BaseURL>([^<]+)<\/BaseURL>/);
  const rootBase = baseMatch ? resolveUrl(url, baseMatch[1].trim()) : url;

  const visit = (chunk, base) => {
    const bm = chunk.match(/<BaseURL>([^<]+)<\/BaseURL>/);
    const localBase = bm ? resolveUrl(base, bm[1].trim()) : base;
    let out = chunk.replace(/<BaseURL>([^<]+)<\/BaseURL>/g,
      (_, rel) => `<BaseURL>${childUrl(resolveUrl(base, rel.trim()), headers)}</BaseURL>`);
    for (const attr of ['media', 'initialization', 'sourceURL']) {
      const re = new RegExp(`(${attr}=")([^"]+)(")`, 'g');
      out = out.replace(re, (_, a, rel, b) => a + childUrl(resolveUrl(localBase, rel), headers) + b);
    }
    if (/<Location>[^<]+<\/Location>/.test(out)) {
      out = out.replace(/<Location>([^<]+<\/Location>/g,
        (_, rel) => `<Location>${childUrl(resolveUrl(base, rel.trim()), headers)}</Location>`);
    }
    return out;
  };

  return visit(xml, rootBase);
}

function rewriteManifest(buf, url, headers, kind) {
  if (buf.length > MAX_MANIFEST) throw new Error('Manifest too large');
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  if (kind === 'hls') {
    if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Invalid playlist');
    return rewriteHls(text, url, headers);
  }
  return rewriteDash(text, url, headers);
}

function pickHeaders(src, incoming) {
  const out = {};
  for (const [k, v] of Object.entries(src || {})) {
    const lk = k.toLowerCase();
    if (SAFE_UPSTREAM_HEADERS.has(lk) ||
        (/^x-[a-z0-9-]{1,64}$/.test(lk) && !lk.startsWith('x-forwarded-') && !lk.startsWith('x-real-ip'))) {
      out[k] = v;
    }
  }
  out['Accept-Encoding'] = 'identity';
  if (!out['User-Agent'] && !out['user-agent']) out['User-Agent'] = 'Mozilla/5.0';
  for (const name of ['range', 'if-range']) {
    const v = incoming.headers[name];
    if (v) out[name] = v;
  }
  return out;
}

async function fetchUpstream(url, headers, method, redirects = 0) {
  if (!allowed(url)) throw new Error('Invalid redirect');
  const res = await fetch(url, { method, headers, redirect: 'manual' });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirects >= 4) throw new Error('Invalid redirect');
    const loc = res.headers.get('location');
    if (!loc) throw new Error('Invalid redirect');
    const next = resolveUrl(url, loc);
    const nextHeaders = { ...headers };
    try { if (new URL(next).hostname !== new URL(url).hostname) { delete nextHeaders.Cookie; delete nextHeaders.cookie; } } catch (_) {}
    return fetchUpstream(next, nextHeaders, method, redirects + 1);
  }
  return { res, finalUrl: url, finalHeaders: headers };
}

function mount(app, resolveResources, resolveSports) {
  const mediaHandler = async (req, res) => {

    if (active >= MAX_STREAMS) {
      return res.status(503).set('Retry-After', '10').json({ ok: false, error: 'Media service is busy' });
    }
    active += 1;
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; } };

    try {
      const p = req.body || {};
      let candidates = [];

      if (p.token) {
        const entry = targets.get(p.token);
        if (!entry || entry.expires <= Date.now()) {
          release();
          return res.status(410).json({ ok: false, error: 'Media link expired; request a fresh stream' });
        }
        let url = entry.url;
        const headers = { ...entry.headers };
        for (const [name, value] of Object.entries(p.substitutions || {})) {
          if (!['Number', 'Time', 'RepresentationID', 'Bandwidth'].includes(name) ||
              !/^[A-Za-z0-9_-]{1,128}$/.test(String(value))) {
            throw new Error('Invalid segment');
          }
          url = url.replace(new RegExp('\\$' + name + '(?:%0(\\d{1,2})d)?\\$', 'g'),
            (_, pad) => pad ? String(parseInt(value, 10)).padStart(parseInt(pad, 10), '0') : String(value));
        }
        candidates = [[url, headers]];
      } else if (p.upstreamUrl) {
        candidates = [[p.upstreamUrl, { ...(p.upstreamHeaders || {}) }]];
      } else {
        let rows;
        if (p.sportId && resolveSports) {
          if (!/^[A-Za-z0-9_-]+$/.test(p.sportId)) throw new Error('Invalid match');
          if (p.clipId && !/^[A-Za-z0-9_-]+$/.test(p.clipId)) throw new Error('Invalid clip');
          rows = await resolveSports(p.sportId, p.sportKind || 'auto', p.clipId || '', p.sportType || 'football');
        } else if (p.subjectId && /^\d+$/.test(p.subjectId) && resolveResources) {
          rows = await resolveResources(p.subjectId, p.season || 0, p.episode || 0);
        } else {
          throw new Error('Invalid content');
        }
        candidates = (rows || [])
          .filter(r => r && r.url && (!p.resolution || r.resolution === p.resolution))
          .slice(0, 8)
          .map(r => [r.url, { ...(r.headers || {}) }]);
        if (!candidates.length && !p.resolution && rows && rows.length) {
          candidates = [[rows[0].url, { ...(rows[0].headers || {}) }]];
        }
        if (!candidates.length) {
          release();
          return res.status(404).json({ ok: false, error: 'Media not found' });
        }
      }

      const method = p.head ? 'HEAD' : 'GET';
      const retryable = new Set([408, 429, 500, 502, 503, 504]);
      const accepted = new Set([200, 206, 416]);
      const failures = [];
      let picked = null;

      for (const [candidateUrl, rawHeaders] of candidates) {
        if (!allowed(candidateUrl)) { failures.push(0); continue; }
        const baseHeaders = pickHeaders(rawHeaders, req);
        for (let retry = 0; retry < 2; retry += 1) {
          try {
            const { res: up, finalUrl, finalHeaders } = await fetchUpstream(candidateUrl, baseHeaders, method);
            if (accepted.has(up.status)) { picked = { up, finalUrl, finalHeaders }; break; }
            failures.push(up.status);
            try { await up.arrayBuffer(); } catch (_) {}
            if (retryable.has(up.status) && retry === 0) { await new Promise(r => setTimeout(r, 200)); continue; }
            break;
          } catch (err) {
            failures.push(0);
            if (retry === 0) { await new Promise(r => setTimeout(r, 200)); continue; }
            break;
          }
        }
        if (picked) break;
      }

      if (!picked) {
        release();
        const last = failures.length ? failures[failures.length - 1] : 0;
        if (failures.length && failures.every(s => s === 404 || s === 410)) {
          return res.status(404).json({ ok: false, error: 'Media not found' });
        }
        return res.status(502).set('Retry-After', '10').json({
          ok: false,
          error: 'Media is temporarily unavailable',
          code: last === 429 ? 'UPSTREAM_RATE_LIMITED' : 'MEDIA_UNAVAILABLE',
        });
      }

      const { up, finalUrl, finalHeaders } = picked;
      const status = up.status;
      const pass = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = up.headers.get(h);
        if (v) pass[h] = v;
      }
      res.set('Cache-Control', 'private, no-store');
      for (const [k, v] of Object.entries(pass)) res.set(k, v);

      const ctype = (up.headers.get('content-type') || '').toLowerCase();
      const path = (() => { try { return new URL(finalUrl).pathname; } catch (_) { return ''; } })();
      const kind = (ctype.includes('mpegurl') || path.endsWith('.m3u8')) ? 'hls'
        : (ctype.includes('dash+xml') || path.endsWith('.mpd')) ? 'dash' : '';

      if (p.head || status === 416) {
        const len = pass['content-length'];
        if (p.head && len) res.set('X-Media-Content-Length', len);
        res.removeHeader('content-length');
        release();
        return res.status(status).end();
      }

      if (kind) {
        const buf = Buffer.from(await up.arrayBuffer());
        const rewritten = rewriteManifest(buf, finalUrl, finalHeaders, kind);
        res.removeHeader('content-length');
        res.removeHeader('content-range');
        res.set('content-type', kind === 'hls' ? 'application/vnd.apple.mpegurl' : 'application/dash+xml');
        release();
        return res.status(200).send(rewritten);
      }

      res.status(status);
      if (!up.body) { release(); return res.end(); }
      const reader = up.body.getReader();
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
              await new Promise(r => res.once('drain', r));
            }
          }
        } catch (_) {
        } finally {
          try { reader.releaseLock(); } catch (_) {}
          release();
          res.end();
        }
      };
      req.on('close', () => { try { reader.cancel(); } catch (_) {} });
      await pump();
    } catch (err) {
      release();
      if (!res.headersSent) {
        res.status(502).json({ ok: false, error: 'Media is temporarily unavailable' });
      } else {
        try { res.end(); } catch (_) {}
      }
    }
  };

  const segmentHandler = async (req, res) => {
    const subs = {};
    for (const [k, v] of Object.entries(req.query || {})) {
      if (['Number', 'Time', 'RepresentationID', 'Bandwidth'].includes(k)) subs[k] = String(v);
    }
    req.body = { token: req.params.token, substitutions: subs, head: req.method === 'HEAD' };
    return mediaHandler(req, res);
  };

  return { mediaHandler, segmentHandler };
}

module.exports = { mount, remember, rewriteManifest, allowed, MEDIA_BASE, MAX_STREAMS };
