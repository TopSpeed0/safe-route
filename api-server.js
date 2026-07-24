'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3850;
const DATA_DIR = path.join(__dirname, 'data');
const CSV_PATH = path.join(DATA_DIR, 'dleshem-alerts.csv');
const CSV_URL = 'https://raw.githubusercontent.com/dleshem/israel-alerts-data/main/israel-alerts.csv';
const REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

// Category mapping: 1→0 (rockets), 2→5 (UAV intrusion), 5→5 (UAV), 6→2 (infiltration), 10→2 (terrorist infiltration), 14→0 (early warning/Lebanon threat)
const CATEGORY_MAP = { '1': 0, '2': 5, '5': 5, '6': 2, '10': 2, '14': 0 };
const SKIP_CATEGORIES = new Set(['3', '4', '13']);

// In-memory data
let allAlerts = [];
let statsCache = null;
let citiesCache = { data: null, ts: 0 };
let polygonsCache = { data: null, ts: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Live alert state
let lastLiveAlert = null;
let lastLiveAlertRaw = '';
let sseClients = [];

// ========== CSV PARSING ==========

function parseCSVLine(line) {
  // Handle quoted fields with commas inside
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      // Quoted field
      let j = i + 1;
      let val = '';
      while (j < line.length) {
        if (line[j] === '"') {
          if (j + 1 < line.length && line[j + 1] === '"') {
            val += '"';
            j += 2;
          } else {
            j++; // closing quote
            break;
          }
        } else {
          val += line[j];
          j++;
        }
      }
      fields.push(val);
      // Skip comma after closing quote
      if (j < line.length && line[j] === ',') j++;
      i = j;
    } else {
      // Unquoted field
      let j = line.indexOf(',', i);
      if (j === -1) j = line.length;
      fields.push(line.substring(i, j));
      i = j + 1;
    }
  }
  return fields;
}

function parseCSV(csvText) {
  const lines = csvText.split('\n');
  const alerts = [];
  let alertId = 1;

  // Skip header
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    if (fields.length < 5) continue;

    const data = fields[0];        // city names
    const alertDate = fields[3];   // ISO datetime
    const category = fields[4];    // category number

    // Skip unwanted categories
    if (SKIP_CATEGORIES.has(category)) continue;
    const threatType = CATEGORY_MAP[category];
    if (threatType === undefined) continue;

    // Parse cities from data field
    const cities = data.split(',').map(s => s.trim()).filter(Boolean);
    if (cities.length === 0) continue;

    // Parse timestamp — CSV dates are in Israel local time (no TZ marker)
    // Node parses "2026-03-25T10:57:00" as UTC, but it's actually IST
    // We need to convert to real UTC by subtracting Israel's UTC offset
    let ts;
    try {
      const raw = new Date(alertDate);
      if (isNaN(raw.getTime())) continue;
      // Find Israel's offset for this specific date (handles DST automatically)
      // Create a date formatter in Israel timezone, compare with UTC
      const utcMs = raw.getTime();
      const ilStr = raw.toLocaleString('sv-SE', {timeZone: 'Asia/Jerusalem'});
      const ilAsUtc = new Date(ilStr + 'Z');
      const offsetMs = ilAsUtc.getTime() - utcMs;
      // offsetMs = how many ms Israel is ahead of UTC for this date
      // Real UTC = parsed_as_utc - offset
      ts = Math.floor((utcMs - offsetMs) / 1000);
      if (isNaN(ts)) continue;
    } catch (e) {
      continue;
    }

    alerts.push([alertId++, threatType, cities, ts]);
  }

  return alerts;
}

function computeStats(alerts) {
  const cityCounts = {};
  const byHour = new Array(24).fill(0);
  const byDow = new Array(7).fill(0);

  for (const a of alerts) {
    const cities = a[2];
    const ts = a[3];
    const d = new Date(ts * 1000);
    byHour[d.getUTCHours()]++;
    byDow[d.getUTCDay()]++;
    for (const c of cities) {
      cityCounts[c] = (cityCounts[c] || 0) + 1;
    }
  }

  const topCities = Object.entries(cityCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([city, cnt]) => ({ city, cnt }));

  return { total: alerts.length, topCities, byHour, byDow };
}

// ========== DATA LOADING ==========

function httpsGet(reqUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(reqUrl);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 SafeRouteBot' }
    };
    https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function loadCSV() {
  console.log('[SafeRoute] Downloading CSV from GitHub...');
  try {
    const buf = await httpsGet(CSV_URL);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CSV_PATH, buf);
    const csvText = buf.toString('utf8');
    allAlerts = parseCSV(csvText);
    statsCache = computeStats(allAlerts);
    console.log(`[SafeRoute] Loaded ${allAlerts.length} alerts from CSV`);
  } catch (e) {
    console.error('[SafeRoute] CSV download failed:', e.message);
    // Try local file
    if (fs.existsSync(CSV_PATH)) {
      console.log('[SafeRoute] Using cached CSV...');
      const csvText = fs.readFileSync(CSV_PATH, 'utf8');
      allAlerts = parseCSV(csvText);
      statsCache = computeStats(allAlerts);
      console.log(`[SafeRoute] Loaded ${allAlerts.length} alerts from cache`);
    }
  }
}

async function proxyFetch(proxyUrl, cache) {
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return cache.data;
  }
  const buf = await httpsGet(proxyUrl);
  cache.data = buf;
  cache.ts = Date.now();
  return buf;
}

// ========== LIVE ALERTS (SSE) ==========

let lastTzevaadomId = 0;

function pollOref() {
  // Use tzevaadom.co.il API (oref blocks our IP directly)
  https.get('https://api.tzevaadom.co.il/notifications', (res) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw || raw === '[]') return;
        const items = JSON.parse(raw);
        if (!Array.isArray(items) || items.length === 0) return;

        // Each item: { time, cities: [...], threat, isDrill }
        for (const item of items) {
          // Use time as unique-ish key
          const itemKey = item.time || 0;
          if (itemKey <= lastTzevaadomId) continue;
          lastTzevaadomId = itemKey;

          const cities = Array.isArray(item.cities) ? item.cities : [];
          if (cities.length === 0) continue;

          const ts = item.time || Math.floor(Date.now() / 1000);
          const alert = { id: ts, threatType: item.threat || 0, cities, ts };
          lastLiveAlert = alert;

          // Also add to allAlerts so heatmap/stats reflect live data
          addLiveToAllAlerts(cities, item.threat || 0, ts);

          const msg = JSON.stringify({ type: 'alert', alert, ts });
          broadcast(msg);
          console.log(`[SafeRoute] Live alert (tzevaadom): ${cities.join(', ')}`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    });
  }).on('error', () => {});
}

// Also poll alerts-history for batched alerts
let lastHistoryId = 0;

function pollHistory() {
  https.get('https://api.tzevaadom.co.il/alerts-history', (res) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw || raw === '[]') return;
        const groups = JSON.parse(raw);
        if (!Array.isArray(groups) || groups.length === 0) return;

        // On first load (startup), process ALL groups to fill gaps
        // On subsequent polls, only process new groups
        const isStartup = lastHistoryId === 0;
        let newCount = 0;

        for (const group of groups) {
          if (!group || !group.id) continue;
          if (!isStartup && group.id <= lastHistoryId) continue;

          if (Array.isArray(group.alerts)) {
            for (const item of group.alerts) {
              const cities = Array.isArray(item.cities) ? item.cities : [];
              if (cities.length === 0) continue;

              const rawTime = item.time || Math.floor(Date.now() / 1000);
              const ts = rawTime;

              const alert = { id: ts, threatType: item.threat || 0, cities, ts };
              lastLiveAlert = alert;

              // Also add to allAlerts
              addLiveToAllAlerts(cities, item.threat || 0, ts);

              if (!isStartup) {
                const msg = JSON.stringify({ type: 'alert', alert, ts });
                broadcast(msg);
                // Notify monitored cities
                notifyTelegram(cities, ts);
                notifyWhatsApp(cities, ts);
              }
              newCount++;
            }
          }
        }

        // Update lastHistoryId to newest
        if (groups[0] && groups[0].id) lastHistoryId = groups[0].id;
        if (newCount > 0 && !isStartup) {
          console.log(`[SafeRoute] Live alert (history): ${newCount} new alerts from ${groups.length} groups`);
        } else if (isStartup && newCount > 0) {
          console.log(`[SafeRoute] Startup: loaded ${newCount} alerts from alerts-history`);
        }
      } catch (e) {}
    });
  }).on('error', () => {});
}

// Merge live alert into allAlerts array (same format as CSV rows)
let liveAlertNextId = 999000;
// Telegram alert for monitored cities
const MONITOR_CITIES = ['פתח תקווה'];
const TG_BOT = '8527137683:AAGBby_e3GHr6DVKPvItx4nmpaU2YPlVEUw';
const TG_CHAT = '783238524';
const _alertedTs = new Set();

// WhatsApp alert via OpenClaw gateway
const { execFile } = require('child_process');
function notifyWhatsApp(cities, ts) {
  const matched = cities.filter(c => MONITOR_CITIES.some(m => c.includes(m)));
  if (!matched.length) return;
  const d = new Date(ts * 1000);
  const timeStr = d.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  const msg = `🚨 אזעקה בפתח תקווה!\n⏰ ${timeStr}\n🏙️ ${cities.length} ערים בגל הזה\n\nהיכנס לממ״ד!`;
  // Try openclaw CLI - may fail due to bug, but worth trying each time
  execFile('openclaw', ['message', 'send', '--channel', 'whatsapp', '--target', '+972523649873', '--message', msg], 
    { timeout: 10000 }, (err) => {
      if (err) console.log('[SafeRoute] WhatsApp send failed (known bug):', err.message?.substring(0, 60));
      else console.log('[SafeRoute] WhatsApp alert sent');
    });
}

function notifyTelegram(cities, ts) {
  const matched = cities.filter(c => MONITOR_CITIES.some(m => c.includes(m)));
  if (!matched.length) return;
  const key = ts + ':' + matched[0];
  if (_alertedTs.has(key)) return;
  _alertedTs.add(key);
  // Cleanup old keys
  if (_alertedTs.size > 200) {
    const arr = [..._alertedTs];
    arr.splice(0, 100);
    _alertedTs.clear();
    arr.forEach(k => _alertedTs.add(k));
  }
  const d = new Date(ts * 1000);
  const timeStr = d.toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
  const msg = `🚨 אזעקה בפתח תקווה!\n⏰ ${timeStr}\n🏙️ ${cities.length} ערים בגל הזה\n\nהיכנס לממ״ד!`;
  const url = `https://api.telegram.org/bot${TG_BOT}/sendMessage`;
  const body = JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' });
  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.end(body);
}

function addLiveToAllAlerts(cities, threatType, ts) {
  // Check if already exists (by timestamp)
  if (allAlerts.some(a => a[3] === ts && a[2].length === cities.length)) return;
  allAlerts.push([liveAlertNextId++, threatType, cities, ts]);
  statsCache = null; // invalidate stats cache
  // Notify on monitored cities
  notifyTelegram(cities, ts);
  notifyWhatsApp(cities, ts);
}

function broadcast(msg) {
  const data = `data: ${msg}\n\n`;
  sseClients = sseClients.filter(res => {
    try {
      res.write(data);
      return true;
    } catch {
      return false;
    }
  });
}

function sendHeartbeats() {
  const msg = JSON.stringify({ type: 'heartbeat', ts: Math.floor(Date.now() / 1000) });
  broadcast(msg);
}

// ========== HTTP SERVER ==========

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, data) {
  cors(res);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function sendError(res, code, msg) {
  cors(res);
  res.writeHead(code);
  res.end(JSON.stringify({ error: msg }));
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // GET /api/threat — live threat score from Twitter monitor + alert boost
    if (pathname === '/api/threat') {
      cors(res);
      try {
        const raw = require('fs').readFileSync('/home/topspeed/threat-monitor/threat-state.json', 'utf8');
        const data = JSON.parse(raw);
        
        // Alert-based boost: per-region based on where alerts actually fired
        const now = Math.floor(Date.now() / 1000);
        const regionBoost = { north: 0, center: 0, south: 0 };
        let recentAlertCount = 0;
        let recentCityCount = 0;
        
        // Load cities for lat lookup
        const citiesData = global._citiesCache || {};
        
        for (const a of allAlerts) {
          const ts = a[3];
          const age = now - ts;
          if (age > 900) continue; // only last 15 min
          recentAlertCount++;
          const cities = a[2] || [];
          recentCityCount += cities.length;
          
          // Determine region from alert size + city names
          let alertRegions = new Set();
          
          // Large alert (30+ cities) = ballistic = all regions
          if (cities.length >= 30) {
            alertRegions = new Set(['north', 'center', 'south']);
          } else {
            // Small alert: guess region from known city names
            const northKw = ['קריית שמונה','מטולה','נהריה','עכו','חיפה','שלומי','חניתה','גורן','יערה','גליל','גולן','צפת','כפר גלעדי'];
            const southKw = ['אשקלון','שדרות','אילת','באר שבע','נגב','נתיב העשרה','ניר עם','איבים','עוטף'];
            const cityStr = cities.join(' ');
            if (northKw.some(k => cityStr.includes(k))) alertRegions.add('north');
            if (southKw.some(k => cityStr.includes(k))) alertRegions.add('south');
            // If still empty, check for center keywords
            const centerKw = ['תל אביב','רמת גן','פתח תקווה','ראשון לציון','חולון','בני ברק','נתניה','הרצליה'];
            if (centerKw.some(k => cityStr.includes(k))) alertRegions.add('center');
            // Fallback: small unknown alert = don't boost any region
            // Only boost regions we can identify. Unknown small alerts shouldn't
            // inflate risk for the entire country.
            // (alertRegions stays empty = no boost)
          }
          
          const boost = Math.min(60, 15 + Math.floor(cities.length * 0.3));
          for (const r of alertRegions) {
            regionBoost[r] = Math.max(regionBoost[r], boost);
          }
        }
        
        const alertBoost = Math.max(regionBoost.north, regionBoost.center, regionBoost.south);
        const twitterScore = data.score || 0;
        data.alert_boost = alertBoost;
        data.alert_boost_regions = regionBoost;
        data.recent_alerts = recentAlertCount;
        data.recent_cities = recentCityCount;
        data.twitter_score = twitterScore;
        
        // Region scores from threat monitor + region-specific alert boost
        const rs = data.region_scores || {};
        data.region_scores = {
          north: Math.min(100, (rs.north || 0) + regionBoost.north),
          center: Math.min(100, (rs.center || 0) + regionBoost.center),
          south: Math.min(100, (rs.south || 0) + regionBoost.south),
        };
        
        // Pass through ceasefire status from monitor
        if (!data.ceasefire_status) {
          data.ceasefire_status = { active: false, since: 0, sources: [], confidence: 0, tweets: 0 };
        }
        
        // Ceasefire dampening: reduce Iran-direct component but keep proxy threats
        // Ceasefire with Iran does NOT reduce: Hezbollah (north), Houthis (south+center)
        // It reduces the "all regions" Iran-direct component by confidence %
        const cf = data.ceasefire_status;
        if (cf && cf.active && cf.confidence > 0) {
          const dampFactor = cf.confidence * 0.4; // max 40% reduction at 100% confidence
          // Only dampen the Iran-direct "all regions" portion
          // North stays high (Hezbollah), South/Center stay (Houthis)
          // We reduce global score slightly to reflect ceasefire, but regions stay
          // No dampening on alert_boost (real sirens override ceasefire status)
        }
        
        // Smart global = average of regions + alert boost (trend already applied by monitor)
        const avgRegion = (data.region_scores.north + data.region_scores.center + data.region_scores.south) / 3;
        data.score = Math.min(100, Math.round(avgRegion));
        
        // Build breakdown for frontend bars
        const sr = data.strikeradar || {};
        const srScore = data.strikeradar_score || 0;
        
        // Categorize active tweets by cluster
        const clusterScores = {};
        const clusterLabels = {
          blockade_hormuz: { label: '🚢 מצור ימי / הורמוז', icon: '🚢' },
          hezbollah: { label: '🇱🇧 חיזבאללה / לבנון', icon: '🇱🇧' },
          iran_direct: { label: '🇮🇷 איראן ישיר', icon: '🇮🇷' },
          ceasefire: { label: '🕊️ הפסקת אש', icon: '🕊️' },
          negotiations: { label: '🤝 משא ומתן', icon: '🤝' },
        };
        for (const tw of (data.active_tweets || [])) {
          // Simple cluster detection from keywords
          const kws = (tw.keywords || []).map(k => k.toLowerCase()).join(' ');
          let cluster = 'other';
          if (/blockade|hormuz|naval|siege|מצור|חסימה/.test(kws)) cluster = 'blockade_hormuz';
          else if (/hezbollah|חיזבאללה|lebanon|litani/.test(kws)) cluster = 'hezbollah';
          else if (/ballistic|irgc|revolutionary|tehran|enrichment|nuclear/.test(kws)) cluster = 'iran_direct';
          else if (/ceasefire|truce|הפסקת אש/.test(kws)) cluster = 'ceasefire';
          else if (/negotiations|talks|deal|agreement|diplomatic|summit/.test(kws)) cluster = 'negotiations';
          if (!clusterScores[cluster]) clusterScores[cluster] = 0;
          clusterScores[cluster] += tw.raw_score || 0;
        }
        
        data.breakdown = {
          clusters: Object.entries(clusterScores)
            .map(([k, v]) => ({ id: k, ...(clusterLabels[k] || { label: k, icon: '📌' }), score: Math.round(v) }))
            .sort((a, b) => Math.abs(b.score) - Math.abs(a.score)),
          strikeradar: {
            score: srScore,
            signals: [
              { id: 'oil', label: '🛢️ נפט', value: sr.oil_price || 0, unit: '$', risk: sr.energy || 0, detail: sr.energy_detail || '' },
              { id: 'flight', label: '✈️ תעופה', value: `${sr.airlines_present||0}/${sr.airlines_expected||0}`, unit: 'חברות', risk: sr.flight || 0, detail: sr.flight_detail || '' },
              { id: 'internet', label: '🌐 אינטרנט איראן', value: sr.connectivity || 0, unit: '%', risk: sr.connectivity || 0, detail: sr.connectivity_detail || '' },
              { id: 'tanker', label: '🚜 מתדלקים', value: sr.tanker || 0, unit: '', risk: sr.tanker || 0, detail: sr.tanker_detail || '' },
            ]
          },
          alert_boost: data.alert_boost_regions || { north: 0, center: 0, south: 0 },
        };
        
        // Remove heavy fields from response
        delete data.seen_ids;
        delete data.active_tweets;
        delete data.matched_keywords;
        delete data.history;
        
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      } catch (e) {
        sendJSON(res, { score: 0, last_scan: 0, error: 'No threat data' });
      }
      return;
    }

    // GET /api/tweets — sanitized latest monitor items for the public dashboard
    if (pathname === '/api/tweets') {
      cors(res);
      try {
        const raw = require('fs').readFileSync('/home/topspeed/threat-monitor/threat-state.json', 'utf8');
        const state = JSON.parse(raw);
        const tweets = (state.active_tweets || [])
          .map((tw) => ({
            ts: Number(tw.ts) || 0,
            raw_score: Number(tw.raw_score) || 0,
            ...(Object.prototype.hasOwnProperty.call(tw, 'final_score') ? { final_score: Number(tw.final_score) || 0 } : {}),
            ...(tw.relevance && typeof tw.relevance === 'object' ? { relevance: {
              status: String(tw.relevance.status || ''),
              topic: String(tw.relevance.topic || ''),
              confidence: Number(tw.relevance.confidence) || 0,
              reason_he: String(tw.relevance.reason_he || '').slice(0, 180),
            }} : {}),
            handle: String(tw.handle || ''),
            name: String(tw.name || tw.handle || 'מקור לא ידוע'),
            flag: String(tw.flag || '📰'),
            text: String(tw.text || ''),
            keywords: Array.isArray(tw.keywords) ? tw.keywords.map(String).slice(0, 12) : [],
          }))
          .filter((tw) => tw.text)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 100);
        sendJSON(res, { updated_at: Number(state.last_scan) || 0, tweets });
      } catch (e) {
        sendJSON(res, { updated_at: 0, tweets: [], error: 'No tweet data' });
      }
      return;
    }

    // GET /api/alerts
    if (pathname === '/api/alerts') {
      cors(res);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(allAlerts));
      return;
    }

    // GET /api/stats
    if (pathname === '/api/stats') {
      if (!statsCache) statsCache = computeStats(allAlerts);
      sendJSON(res, statsCache);
      return;
    }

    // GET /api/cities
    if (pathname === '/api/cities') {
      try {
        const data = await proxyFetch('https://www.tzevaadom.co.il/static/cities.json', citiesCache);
        cors(res);
        res.setHeader('Content-Type', 'application/json');
        res.end(data);
      } catch (e) {
        sendError(res, 502, 'Failed to fetch cities: ' + e.message);
      }
      return;
    }

    // GET /api/polygons
    if (pathname === '/api/polygons') {
      try {
        const data = await proxyFetch('https://www.tzevaadom.co.il/static/polygons.json', polygonsCache);
        cors(res);
        res.setHeader('Content-Type', 'application/json');
        res.end(data);
      } catch (e) {
        sendError(res, 502, 'Failed to fetch polygons: ' + e.message);
      }
      return;
    }

    // GET /api/live (SSE)
    if (pathname === '/api/live') {
      cors(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      // Send connected event
      res.write(`data: ${JSON.stringify({ type: 'connected', ts: Math.floor(Date.now() / 1000) })}\n\n`);

      sseClients.push(res);

      req.on('close', () => {
        sseClients = sseClients.filter(c => c !== res);
      });
      return;
    }

    // GET /api/live-recent
    if (pathname === '/api/live-recent') {
      sendJSON(res, lastLiveAlert || { type: 'none', ts: Math.floor(Date.now() / 1000) });
      return;
    }

    // GET /api/shelter?lat=X&lng=Y
    if (pathname === '/api/shelter') {
      const lat = parsed.query.lat;
      const lng = parsed.query.lng;
      if (!lat || !lng) {
        sendError(res, 400, 'Missing lat/lng');
        return;
      }
      const shelterUrl = `https://www.oref.org.il/Shared/Ajax/GetShelters.aspx?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&radius=2000`;
      try {
        const data = await httpsGet(shelterUrl);
        cors(res);
        res.setHeader('Content-Type', 'application/json');
        res.end(data);
      } catch (e) {
        sendError(res, 502, 'Failed to fetch shelters: ' + e.message);
      }
      return;
    }

    // 404
    sendError(res, 404, 'Not found');

  } catch (e) {
    console.error('[SafeRoute] Request error:', e.message);
    sendError(res, 500, 'Internal error');
  }
});

// ========== STARTUP ==========

async function start() {
  console.log('[SafeRoute] Starting API server...');
  await loadCSV();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[SafeRoute] API server listening on 127.0.0.1:${PORT}`);
  });

  // Refresh CSV every 6 hours
  setInterval(loadCSV, REFRESH_INTERVAL);

  // Load recent history on startup to fill gaps
  lastTzevaadomId = 0; // allow all history to merge
  pollHistory();
  setTimeout(() => { lastTzevaadomId = Math.floor(Date.now() / 1000) - 60; }, 5000);

  // Poll tzevaadom notifications every 3 seconds
  setInterval(pollOref, 3000);
  // Also poll alerts-history every 5 seconds (catches grouped alerts)
  setInterval(pollHistory, 5000);

  // Heartbeat every 5 seconds
  setInterval(sendHeartbeats, 5000);
}

start().catch(e => {
  console.error('[SafeRoute] Fatal:', e);
  process.exit(1);
});
