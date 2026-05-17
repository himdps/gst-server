const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'GST Lookup Server Running' }));

// ─── Source 1: GSTN direct ───
async function fetchFromGSTN(pan) {
  try {
    const res = await axios.get(
      `https://services.gst.gov.in/services/api/search/taxpayerByPan/${pan}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://services.gst.gov.in/services/searchtpbypan',
          'Origin': 'https://services.gst.gov.in',
        },
        timeout: 12000
      }
    );
    const list = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    if (!list.length) return null;
    const active = list.find(d => (d.sts||'').toLowerCase()==='active') || list[0];
    if (!active || !active.lgnm) return null;
    return {
      success: true, pan,
      legal_name: active.lgnm,
      trade_name: active.tradeNam || '',
      gstin: active.gstin || '—',
      status: active.sts || '—',
      state: active.pradr?.addr?.stcd || '—'
    };
  } catch(e) { return null; }
}

// ─── Source 2: LegalDev API ───
async function fetchFromLegalDev(pan) {
  // Try multiple possible internal API endpoints LegalDev might use
  const endpoints = [
    { method: 'POST', url: 'https://legaldev.in/api/gst/searchByPan',      data: { pan } },
    { method: 'POST', url: 'https://legaldev.in/api/pan-to-gst',            data: { pan } },
    { method: 'GET',  url: `https://legaldev.in/api/gst/pan/${pan}`,        data: null },
    { method: 'POST', url: 'https://legaldev.in/api/search/pan',            data: { pan } },
    { method: 'GET',  url: `https://legaldev.in/gst-verification?pan=${pan}`, data: null },
  ];

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://legaldev.in/pan-to-gst',
    'Origin': 'https://legaldev.in',
  };

  for (const ep of endpoints) {
    try {
      const cfg = { headers: baseHeaders, timeout: 10000 };
      const r = ep.method === 'POST'
        ? await axios.post(ep.url, ep.data, cfg)
        : await axios.get(ep.url, cfg);
      const d = r.data;
      const lname = d?.legal_name || d?.lgnm || d?.legalName || d?.data?.lgnm || d?.data?.legal_name;
      if (lname && lname.length > 2) {
        return {
          success: true, pan,
          legal_name: lname,
          trade_name: d?.trade_name || d?.tradeNam || d?.tradeName || d?.data?.tradeNam || '',
          gstin: d?.gstin || d?.data?.gstin || '—',
          status: d?.status || d?.sts || d?.data?.sts || '—',
          state: d?.state || d?.data?.state || '—'
        };
      }
    } catch(e) { continue; }
  }
  return null;
}

// ─── Source 3: Scrape LegalDev HTML ───
async function scrapeLegalDev(pan) {
  try {
    const r = await axios.get(`https://legaldev.in/pan-to-gst`, {
      params: { pan },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Referer': 'https://legaldev.in/',
      },
      timeout: 20000
    });
    const $ = cheerio.load(r.data);
    let result = null;

    // Look for GSTN JSON embedded in page JS
    $('script').each((i, el) => {
      const txt = $(el).html() || '';
      const m = txt.match(/"lgnm"\s*:\s*"([^"]+)"/);
      const t = txt.match(/"tradeNam"\s*:\s*"([^"]+)"/);
      const g = txt.match(/"gstin"\s*:\s*"([^"]+)"/);
      const s = txt.match(/"sts"\s*:\s*"([^"]+)"/);
      if (m) {
        result = { success:true, pan, legal_name:m[1], trade_name:t?t[1]:'', gstin:g?g[1]:'—', status:s?s[1]:'—', state:'—' };
        return false;
      }
      // Also look for JSON objects in __NEXT_DATA__ or similar
      const jsonMatch = txt.match(/\{[^{}]*"lgnm"[^{}]*\}/);
      if (jsonMatch) {
        try {
          const obj = JSON.parse(jsonMatch[0]);
          if (obj.lgnm) {
            result = { success:true, pan, legal_name:obj.lgnm, trade_name:obj.tradeNam||'', gstin:obj.gstin||'—', status:obj.sts||'—', state:'—' };
            return false;
          }
        } catch(e) {}
      }
    });
    return result;
  } catch(e) { return null; }
}

// ─── Source 4: Known2GSTN data via public search ───
async function fetchViaKnowGST(pan) {
  try {
    const r = await axios.get(
      `https://www.knowyourgst.com/gst-number-search/by-name-pan/?search=${pan}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,*/*',
        },
        timeout: 15000
      }
    );
    const $ = cheerio.load(r.data);
    // Extract data from tables/structured content
    let legalName = '', tradeName = '', gstin = '';
    $('table tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().toLowerCase();
        const val = $(cells[1]).text().trim();
        if (label.includes('legal') && val) legalName = val;
        if (label.includes('trade') && val) tradeName = val;
        if (label.includes('gstin') || label.includes('gst number')) gstin = val;
      }
    });
    // Also try extracting from any JSON in page
    $('script').each((i, el) => {
      const txt = $(el).html() || '';
      const m = txt.match(/"lgnm"\s*:\s*"([^"]+)"/);
      const t = txt.match(/"tradeNam"\s*:\s*"([^"]+)"/);
      if (m && !legalName) legalName = m[1];
      if (t && !tradeName) tradeName = t[1];
    });
    if (legalName) {
      return { success:true, pan, legal_name:legalName, trade_name:tradeName, gstin, status:'—', state:'—' };
    }
  } catch(e) {}
  return null;
}

// ─── PAN endpoint: tries all sources ───
app.get('/pan/:pan', async (req, res) => {
  const pan = req.params.pan.toUpperCase().trim();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    return res.json({ success: false, error: 'Invalid PAN format' });
  }

  console.log(`Looking up PAN: ${pan}`);

  const result =
    (await fetchFromGSTN(pan)) ||
    (await fetchFromLegalDev(pan)) ||
    (await scrapeLegalDev(pan)) ||
    (await fetchViaKnowGST(pan));

  if (result) {
    console.log(`Found: ${result.legal_name}`);
    return res.json(result);
  }

  return res.json({
    success: false,
    error: 'Could not fetch data. PAN may not be GST registered, or all sources are temporarily unavailable.'
  });
});

// ─── GSTIN endpoint ───
app.get('/gstin/:gstin', async (req, res) => {
  const gstin = req.params.gstin.toUpperCase().trim();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    return res.json({ success: false, error: 'Invalid GSTIN format' });
  }
  try {
    const r = await axios.get(
      `https://services.gst.gov.in/services/api/search/taxpayerByGSTIN/${gstin}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://services.gst.gov.in/services/searchtp',
          'Origin': 'https://services.gst.gov.in',
        },
        timeout: 12000
      }
    );
    const d = r.data;
    if (d && d.lgnm) {
      return res.json({ success:true, gstin, pan:gstin.substring(2,12), legal_name:d.lgnm, trade_name:d.tradeNam||'', status:d.sts||'—', state:d.pradr?.addr?.stcd||'—' });
    }
  } catch(e) {}
  return res.json({ success: false, error: 'GSTIN not found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GST server running on port ${PORT}`));
