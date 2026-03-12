// aggregate.js — lê do KV (instantâneo) em vez de buscar no Zendesk

async function kvGet(key) {
  const url = `${process.env.KV_REST_API_URL}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.result ?? null;
}

async function kvKeys(pattern) {
  const url = `${process.env.KV_REST_API_URL}/keys/${encodeURIComponent(pattern)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  });
  if (!res.ok) return [];
  const j = await res.json();
  return j.result ?? [];
}

function mergeDays(days) {
  const result = {
    total: 0, byDate: {}, byMonth: {}, byCanal: {}, byStatus: {},
    byTipo: {}, byPrioridade: {}, byAssunto: {}, byTag: {},
    _slaOkSum: 0, _slaDays: 0, slaOk: 0, slaViol: 0, csat: null,
  };
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  for (const [date, d] of Object.entries(days)) {
    result.total += d.total || 0;
    result.byDate[date] = d.total || 0;
    const mo = months[parseInt(date.slice(5,7))-1] || date.slice(0,7);
    result.byMonth[mo] = (result.byMonth[mo] || 0) + (d.total || 0);

    const merge = (src, dst) => {
      Object.entries(src || {}).forEach(([k,v]) => { dst[k] = (dst[k]||0) + v; });
    };
    merge(d.byCanal,      result.byCanal);
    merge(d.byStatus,     result.byStatus);
    merge(d.byTipo,       result.byTipo);
    merge(d.byPrioridade, result.byPrioridade);
    merge(d.byAssunto,    result.byAssunto);
    merge(d.byTag,        result.byTag);

    if (d.slaOk !== undefined) {
      result._slaOkSum += d.slaOk;
      result._slaDays++;
    }
  }

  result.slaOk  = result._slaDays > 0 ? result._slaOkSum / result._slaDays : 0;
  result.slaViol = 1 - result.slaOk;
  delete result._slaOkSum;
  delete result._slaDays;
  return result;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ZD-Subdomain');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const subdomain = req.headers['x-zd-subdomain'];
  if (!subdomain) return res.status(400).json({ error: 'x-zd-subdomain required' });

  // Generate days in range
  const days = [];
  let cur = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T23:59:59Z');
  while (cur <= endD) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  // Fetch all days from KV in parallel
  const dayData = {};
  const missing = [];

  await Promise.all(days.map(async day => {
    const cached = await kvGet(`tickets:${subdomain}:${day}`);
    if (cached) {
      try { dayData[day] = JSON.parse(cached); }
      catch(e) { missing.push(day); }
    } else {
      missing.push(day);
    }
  }));

  const result = mergeDays(dayData);
  result.missing = missing;
  result.cached = days.length - missing.length;
  result.total_days = days.length;

  // Get last sync info
  const lastSync = await kvGet(`last_sync:${subdomain}`);
  result.last_sync = lastSync;

  return res.status(200).json(result);
};
