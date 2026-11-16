'use strict';

/**
 * Name : YT Downloader
 * Creator : Razeerh & Integrated for Zaidi API Hub
 * Source : https://whatsapp.com/channel/0029vbCN4sQLo4hhDCk0HX1m
 * Base Web : https://www.snapyt.app/id/
 * Type : Scraper
 */

const axios = require("axios");
const cheerio = require("cheerio");

const BASE = "https://www.snapyt.app";
const AJAX = `${BASE}/wp-admin/admin-ajax.php`;
const HOME_ID = `${BASE}/id/`;
const TIMEOUT_MS = 45000;
const RETRIES = 3;

const UA = "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/json,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
};

const SUPPORTED_URL_PATTERNS = [
  "https://www.youtube.com/watch?v=<VIDEO_ID>",
  "https://youtube.com/watch?v=<VIDEO_ID>",
  "https://youtu.be/<VIDEO_ID>",
  "https://www.youtube.com/shorts/<VIDEO_ID>",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isYouTubeUrl(raw) {
  if (typeof raw !== "string") return false;
  let s = raw.trim();
  if (!s) return false;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    const host = (u.hostname || "").toLowerCase();
    if (host === "youtu.be" && u.pathname.length > 1) return true;
    if (/(^|\.)youtube\.com$/.test(host) || /(^|\.)m\.youtube\.com$/.test(host)) {
      const p = u.pathname || "";
      if (p === "/watch" && u.searchParams.get("v")) return true;
      if (/^\/(shorts|embed|live|v)\/[^/]+/.test(p)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function extractVideoId(raw) {
  let s = String(raw || "").trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, "").toLowerCase();
    if (host === "youtu.be") return u.pathname.split("/").filter(Boolean)[0] || null;
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
    if (m) return m[2];
    return u.searchParams.get("v");
  } catch {
    const m = String(raw).match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/|v\/)([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  }
}

function normalizeYouTubeUrl(raw) {
  const id = extractVideoId(raw);
  if (!id) return String(raw || "").trim();
  return `https://www.youtube.com/watch?v=${id}`;
}

function contentTypeOf(raw) {
  return /\/shorts\//i.test(String(raw || "")) ? "shorts" : "video";
}

function parseDuration(text) {
  const m = String(text || "").match(/(\d{1,2}:)?(\d{1,2}):(\d{2})/);
  if (!m) return { text: null, seconds: null };
  const parts = m[0].split(":").map((n) => parseInt(n, 10));
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return { text: m[0], seconds: sec };
}

function parseResolution(label) {
  const m = String(label || "").match(/(\d{3,4})p/);
  return m ? `${m[1]}p` : null;
}

function parseBitrateKbps(label) {
  const m = String(label || "").match(/(\d{2,3})\s*kbps/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseSizeToBytes(size) {
  if (!size) return null;
  const m = String(size).match(/([\d.]+)\s*(KB|MB|GB|kB)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = unit === "GB" ? 1024 ** 3 : unit === "MB" ? 1024 ** 2 : 1024;
  return Math.round(n * mult);
}

function errResult(input, stage, message, extra = {}) {
  return {
    success: false,
    input,
    status: "error",
    error_stage: stage,
    error_message: message,
    supported_url_formats: SUPPORTED_URL_PATTERNS,
    ...extra,
  };
}

async function httpPostForm(fields, opts = {}) {
  let lastErr = null;
  const body = new URLSearchParams(fields).toString();
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await axios.post(AJAX, body, {
        timeout: TIMEOUT_MS,
        headers: {
          ...HEADERS,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: HOME_ID,
          Origin: BASE,
          "X-Requested-With": "XMLHttpRequest",
          ...(opts.headers || {}),
        },
        validateStatus: (s) => s >= 200 && s < 500,
      });
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await sleep(1000 * attempt);
    }
  }
  throw new Error(`Request ke ${AJAX} gagal: ${lastErr ? lastErr.message : "unknown"}`);
}

async function httpGet(url, opts = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: { ...HEADERS, ...(opts.headers || {}) },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      return res.data;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await sleep(1200 * attempt);
    }
  }
  throw new Error(`Gagal GET ${url}: ${lastErr ? lastErr.message : "unknown"}`);
}

async function getFreshNonce() {
  const res = await httpPostForm({ action: "vd_fresh_nonce" });
  const j = res.data;
  if (j && j.success && j.data && j.data.nonce) return j.data.nonce;
  const html = await httpGet(HOME_ID);
  const m = html.match(/"nonce"\s*:\s*"([a-f0-9]+)"/);
  if (m) return m[1];
  throw new Error("Nonce tidak ditemukan.");
}

async function requestPreviewUrl(ytUrl, nonce) {
  const res = await httpPostForm({
    action: "process_video_url",
    video_url: ytUrl,
    security: nonce || "",
  });
  const status = res.status;
  const j = res.data;

  if ((status === 403 || (j === -1 || j === "-1")) && !requestPreviewUrl._retried) {
    requestPreviewUrl._retried = true;
    const fresh = await getFreshNonce();
    return requestPreviewUrl(ytUrl, fresh);
  }

  if (j && j.success && j.data && j.data.redirect) {
    return { redirect: j.data.redirect, raw: j };
  }
  const msg = j && typeof j.data === "string" ? j.data : `Respons tidak valid (HTTP ${status}).`;
  const e = new Error(msg);
  e.apiResponse = j;
  throw e;
}

function parsePreviewHtml(html, inputUrl) {
  const $ = cheerio.load(html);
  const title = $("h1.title").first().text().trim() || null;
  const chip = $(".chip").first().text().replace(/\s+/g, " ").trim() || null;
  const thumbEl = $("img#vd-image").first();
  const thumbnail = thumbEl.attr("src") || (($("#vd-thumb-dl").attr("data-srcs") || "").split("|")[0] || "") || null;

  const formats = [];
  $("#fmt-select optgroup").each((_, og) => {
    const groupLabel = $(og).attr("label") || "";
    const groupClean = groupLabel.replace(/^[^\w]*\s*/, "").trim() || groupLabel;
    $(og).find("option").each((__, opt) => {
      const $o = $(opt);
      const label = ($o.attr("data-label") || $o.text()).replace(/\s+/g, " ").trim();
      const text = $o.text().replace(/\s+/g, " ").trim();
      const kind = $o.attr("data-kind") || null;
      const ext = $o.attr("data-ext") || null;
      const size = $o.attr("data-size") || null;
      const bytesAttr = $o.attr("data-bytes");
      const mp3 = $o.attr("data-mp3");
      const force = $o.attr("data-force") || null;
      const stream = $o.attr("data-url") || null;

      formats.push({
        group: groupClean,
        value: $o.attr("value") || null,
        label: label || text || null,
        kind,
        extension: ext || null,
        resolution: parseResolution(label || text),
        bitrate_kbps: mp3 ? parseInt(mp3, 10) : parseBitrateKbps(label || text),
        is_mp3: Boolean(mp3) || /mp3/i.test(label || text),
        size_display: size || null,
        size_bytes: bytesAttr ? parseInt(bytesAttr, 10) : parseSizeToBytes(size),
        download_url: force,
        stream_url: stream,
      });
    });
  });

  const videoId = extractVideoId(inputUrl) || (() => {
    const m = (thumbnail || "").match(/\/vi\/([^/]+)\//);
    return m ? m[1] : null;
  })();

  return {
    video_id: videoId,
    title,
    status_chip: chip,
    thumbnail_url: thumbnail,
    formats,
  };
}

async function scrapeVideo(inputUrl) {
  if (!inputUrl || !isYouTubeUrl(inputUrl)) {
    return errResult(inputUrl, "validation", "URL YouTube tidak valid.");
  }
  try {
    const nonce = await getFreshNonce();
    let redirect;
    try {
      ({ redirect } = await requestPreviewUrl(inputUrl, nonce));
    } catch {
      const nonce2 = await getFreshNonce();
      requestPreviewUrl._retried = false;
      ({ redirect } = await requestPreviewUrl(inputUrl, nonce2));
    }

    const previewHtml = await httpGet(redirect);
    const parsed = parsePreviewHtml(previewHtml, inputUrl);

    return {
      success: true,
      status: "ok",
      video: {
        id: parsed.video_id,
        title: parsed.title,
        thumbnail_url: parsed.thumbnail_url,
        content_type: contentTypeOf(inputUrl),
      },
      formats: parsed.formats,
    };
  } catch (e) {
    return errResult(inputUrl, "request", e.message || "Unknown error");
  }
}

module.exports = { scrapeVideo, isYouTubeUrl };
