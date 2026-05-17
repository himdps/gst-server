const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => res.json({ status: 'GST Lookup Server Running' }));

// PAN → GSTIN + Legal/Trade Name
app.get('/pan/:pan', async (req, res) => {
  const pan = req.params.pan.toUpperCase().trim();

  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    return res.json({ success: false, error: 'Invalid PAN format' });
  }

  try {
    // Call GSTN public API — search taxpayer by PAN
    const response = await axios.get(
      `https://services.gst.gov.in/services/api/search/taxpayerByPan/${pan}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://services.gst.gov.in/services/searchtp',
          'Origin': 'https://services.gst.gov.in',
        },
        timeout: 15000
      }
    );

    const data = response.data;

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return res.json({ success: false, error: 'No GST registration found for this PAN' });
    }

    const list = Array.isArray(data) ? data : [data];

    // Pick first active, or first overall
    const active = list.find(d => (d.sts || '').toLowerCase() === 'active') || list[0];

    return res.json({
      success: true,
      pan: pan,
      legal_name: active.lgnm || '—',
      trade_name: active.tradeNam || '',
      gstin: active.gstin || '—',
      status: active.sts || '—',
      state: active.pradr?.addr?.stcd || '—',
      all_gstins: list.map(d => ({
        gstin: d.gstin,
        legal_name: d.lgnm,
        trade_name: d.tradeNam,
        status: d.sts,
        state: d.pradr?.addr?.stcd || '—'
      }))
    });

  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 400) {
      return res.json({ success: false, error: 'No GST registration found for this PAN' });
    }
    return res.json({ success: false, error: `Lookup failed: ${err.message}` });
  }
});

// GSTIN → Legal/Trade Name
app.get('/gstin/:gstin', async (req, res) => {
  const gstin = req.params.gstin.toUpperCase().trim();

  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    return res.json({ success: false, error: 'Invalid GSTIN format' });
  }

  try {
    const response = await axios.get(
      `https://services.gst.gov.in/services/api/search/taxpayerByGSTIN/${gstin}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://services.gst.gov.in/services/searchtp',
          'Origin': 'https://services.gst.gov.in',
        },
        timeout: 15000
      }
    );

    const d = response.data;
    if (!d) return res.json({ success: false, error: 'No data returned' });

    return res.json({
      success: true,
      gstin: gstin,
      legal_name: d.lgnm || '—',
      trade_name: d.tradeNam || '',
      status: d.sts || '—',
      state: d.pradr?.addr?.stcd || '—',
      pan: gstin.substring(2, 12)
    });

  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 400) {
      return res.json({ success: false, error: 'GSTIN not found' });
    }
    return res.json({ success: false, error: `Lookup failed: ${err.message}` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GST server running on port ${PORT}`));
