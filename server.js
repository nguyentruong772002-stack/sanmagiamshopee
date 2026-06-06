const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const AFFILIATE_ID = process.env.AFFILIATE_ID || '17341350103';
const DEFAULT_SUB_ID = process.env.DEFAULT_SUB_ID || 'Summer';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'conversions.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ conversions: [] }, null, 2));
  }
}

function readDb() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { conversions: [] };
  }
}

function writeDb(db) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function extractFirstUrl(text) {
  if (!text || typeof text !== 'string') return '';
  const match = text.trim().match(/https?:\/\/[^\s"'<>]+/i);
  return match ? match[0] : '';
}

function isShopeeUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)shopee\.vn$/i.test(u.hostname) || /^s\.shopee\.vn$/i.test(u.hostname) || /^shp\.ee$/i.test(u.hostname);
  } catch (_) {
    return false;
  }
}

function cleanShopeeUrl(input) {
  const first = extractFirstUrl(String(input || '')) || String(input || '').trim();
  let url = first;

  try {
    const u = new URL(url);
    const origin = u.searchParams.get('origin_link');
    if (origin) url = decodeURIComponent(origin);
  } catch (_) {}

  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) {
    return url.split('?')[0];
  }
}

function buildAffiliateLink(cleanUrl, subId) {
  const u = new URL(cleanUrl);

  u.searchParams.set('mmp_pid', 'an_' + AFFILIATE_ID);
  u.searchParams.set('utm_source', 'an_' + AFFILIATE_ID);
  u.searchParams.set('utm_medium', 'affiliates');
  u.searchParams.set('utm_content', subId || DEFAULT_SUB_ID);
  u.searchParams.set('utm_campaign', 'id_web');
  u.searchParams.set('utm_term', 'web');

  return u.toString();
}

function makeId() {
  return crypto.randomBytes(5).toString('hex');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = Array.isArray(forwarded) ? forwarded[0] : (forwarded || req.socket.remoteAddress || '');
  return String(ip).split(',')[0].trim();
}

function maskIp(ip) {
  if (!ip) return '';
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.x';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + ':xxxx';
  return ip;
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Basic ') ? header.slice(6) : '';
  const decoded = token ? Buffer.from(token, 'base64').toString('utf8') : '';
  const [user, pass] = decoded.split(':');

  if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();

  res.set('WWW-Authenticate', 'Basic realm="Shopee Admin"');
  return res.status(401).send('Cần đăng nhập admin');
}

app.post('/api/product-info', (req, res) => {
  const raw = req.body?.url || req.body?.content || '';
  const url = extractFirstUrl(raw);

  if (!url) return res.status(400).json({ error: 'Không tìm thấy link hợp lệ.' });
  if (!isShopeeUrl(url)) return res.status(400).json({ error: 'Vui lòng nhập link Shopee.' });

  return res.json({
    title: 'Link Shopee đã sẵn sàng để chuyển đổi',
    image: '',
    description: '',
    productUrl: cleanShopeeUrl(url)
  });
});

app.post('/api/convert', (req, res) => {
  const raw = req.body?.content || req.body?.url || '';
  const originUrl = extractFirstUrl(raw);
  const subId1 = (req.body?.subId1 || DEFAULT_SUB_ID).toString().trim() || DEFAULT_SUB_ID;

  if (!originUrl) return res.status(400).json({ error: 'Không tìm thấy link hợp lệ.' });
  if (!isShopeeUrl(originUrl)) return res.status(400).json({ error: 'Vui lòng nhập link Shopee.' });

  const cleanUrl = cleanShopeeUrl(originUrl);
  const affiliateLink = buildAffiliateLink(cleanUrl, subId1);
  const id = makeId();
  const trackingLink = `${BASE_URL.replace(/\/$/, '')}/go/${id}`;

  const db = readDb();
  db.conversions.unshift({
    id,
    createdAt: new Date().toISOString(),
    originalUrl: originUrl,
    cleanUrl,
    affiliateLink,
    trackingLink,
    subId: subId1,
    userAgent: req.headers['user-agent'] || '',
    ipMasked: maskIp(getClientIp(req)),
    referer: req.headers.referer || '',
    clicks: []
  });
  writeDb(db);

  res.json({
    converted: [affiliateLink],
    convertedText: affiliateLink,
    directAffiliateLink: affiliateLink,
    trackingLink: trackingLink,
    count: 1,
    source: 'direct-affiliate'
  });
});

app.get('/go/:id', (req, res) => {
  const db = readDb();
  const item = db.conversions.find(x => x.id === req.params.id);
  if (!item) return res.status(404).send('Link không tồn tại hoặc đã bị xóa.');

  item.clicks = item.clicks || [];
  item.clicks.push({
    clickedAt: new Date().toISOString(),
    ipMasked: maskIp(getClientIp(req)),
    userAgent: req.headers['user-agent'] || '',
    referer: req.headers.referer || ''
  });
  writeDb(db);

  return res.redirect(item.affiliateLink);
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const db = readDb();
  const conversions = db.conversions || [];
  const totalConversions = conversions.length;
  const totalClicks = conversions.reduce((sum, x) => sum + ((x.clicks || []).length), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayConversions = conversions.filter(x => (x.createdAt || '').slice(0, 10) === today).length;
  const todayClicks = conversions.reduce((sum, x) => {
    return sum + (x.clicks || []).filter(c => (c.clickedAt || '').slice(0, 10) === today).length;
  }, 0);

  const allClicks = [];

conversions.forEach(item => {
  (item.clicks || []).forEach(click => {
    allClicks.push({
      conversionId: item.id,
      clickedAt: click.clickedAt,
      ipMasked: click.ipMasked,
      userAgent: click.userAgent,
      referer: click.referer,
      originalUrl: item.originalUrl,
      affiliateLink: item.affiliateLink,
      trackingLink: item.trackingLink,
      subId: item.subId
    });
  });
});

allClicks.sort((a, b) => new Date(b.clickedAt) - new Date(a.clickedAt));

res.json({
  totalConversions,
  totalClicks,
  todayConversions,
  todayClicks,
  conversions: conversions.slice(0, 300),
  clicks: allClicks.slice(0, 1000)
});
});

app.delete('/api/admin/data', requireAdmin, (req, res) => {
  writeDb({ conversions: [] });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  ensureDataFile();
  console.log(`Shopee converter running at http://localhost:${PORT}`);
  console.log(`Admin page: http://localhost:${PORT}/admin`);
  console.log(`Admin login: ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
});
