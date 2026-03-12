const https = require('https');

// ── KV REST helper (no fetch dependency) ─────────────────────────────────────
function kvRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.KV_REST_API_URL || '';
    const urlObj = new URL(base + path);
    const token  = process.env.KV_REST_API_TOKEN || '';
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 300, body: JSON.parse(data) }); }
        catch(e) { resolve({ ok: false, body: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('KV timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function kvSet(key, value) {
  const r = await kvRequest('POST', `/set/${encodeURIComponent(key)}`, value);
  return r.ok;
}

async function kvGet(key) {
  const r = await kvRequest('GET', `/get/${encodeURIComponent(key)}`);
  return r.ok ? (r.body.result ?? null) : null;
}

async function kvKeys(pattern) {
  const r = await kvRequest('GET', `/keys/${encodeURIComponent(pattern)}`);
  return r.ok ? (r.body.result ?? []) : [];
}

// ── Zendesk helpers ───────────────────────────────────────────────────────────
function zdRequest(subdomain, auth, path) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(`https://${subdomain}.zendesk.com${path}`);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(new Error('JSON parse: ' + body.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function classifySubject(s) {
  s = s.toUpperCase();
  if (/entrega|prazo|atraso|frete/.test(s))     return 'ENTREGA';
  if (/cancel/.test(s))                          return 'CANCELAMENTO';
  if (/garantia/.test(s))                        return 'GARANTIA';
  if (/troca|devolv/.test(s))                    return 'TROCA DE MERCADORIA';
  if (/fatura|nota fiscal|boleto/.test(s))       return 'ERRO FATURAMENTO';
  if (/financ|pagamento|parcelamento/.test(s))   return 'INF. FINANCEIRAS';
  if (/medida|modelo|tamanho/.test(s))           return 'ERRO MEDIDA';
  if (/estoque/.test(s))                         return 'SEM ESTOQUE';
  if (/parceiro/.test(s))                        return 'REDE DE PARCEIROS';
  if (/psmóvel|ps movel|psmov/.test(s))          return 'PSMÓVEL';
  return null;
}

function initDay() {
  return {
    total: 0, byCanal: {}, byStatus: {}, byTipo: {},
    byPrioridade: {}, byAssunto: {}, byTag: {},
    _slaTotal: 0, _slaOkCount: 0,
  };
}

function processTicket(day, t) {
  day.total++;
  const chMap = { web:'Web', email:'E-mail', api:'API', mobile:'Mobile', chat:'Chat',
    voice:'Voz', any_channel:'Omnichannel', instagram_dm:'Instagram',
    twitter_dm:'Twitter', facebook:'Facebook', whatsapp:'WhatsApp' };
  const ch = chMap[t.via?.channel || t.channel || ''] || (t.via?.channel || 'outro');
  day.byCanal[ch] = (day.byCanal[ch] || 0) + 1;
  const stMap = { new:'Novo', open:'Aberto', pending:'Pendente', hold:'Em espera', solved:'Resolvido', closed:'Fechado' };
  const st = stMap[t.status] || t.status || '?';
  day.byStatus[st] = (day.byStatus[st] || 0) + 1;
  const tpMap = { problem:'Problema', incident:'Incidente', question:'Dúvida', task:'Tarefa' };
  day.byTipo[tpMap[t.type] || 'Não classificado'] = (day.byTipo[tpMap[t.type] || 'Não classificado'] || 0) + 1;
  const prMap = { low:'Baixa', normal:'Normal', high:'Alta', urgent:'Urgente' };
  day.byPrioridade[prMap[t.priority] || 'Normal'] = (day.byPrioridade[prMap[t.priority] || 'Normal'] || 0) + 1;
  const subj = (t.subject || '').trim();
  if (subj) {
    const cat = classifySubject(subj);
    const key = cat || (subj.length > 30 ? subj.slice(0, 28) + '…' : subj);
    day.byAssunto[key] = (day.byAssunto[key] || 0) + 1;
  }
  (t.tags || []).forEach(tag => { day.byTag[tag] = (day.byTag[tag] || 0) + 1; });
  if (t.sla_policy) {
    day._slaTotal++;
    if (!((t.sla_policy?.policy_metrics || []).some(m => m.breached))) day._slaOkCount++;
  }
}

async function fetchAndSaveDay(subdomain, auth, date, res) {
  const dayData = initDay();

  // Check count first
  const q0 = encodeURIComponent(`type:ticket created>=${date}T00:00:00Z created<=${date}T23:59:59Z`);
  const { status: cs, data: cd } = await zdRequest(subdomain, auth, `/api/v2/search/count.json?query=${q0}`);
  const count = cs === 200 ? (cd.count || 0) : 0;

  // Decide slicing strategy
  const slices = [];
  if (count <= 900) {
    slices.push([`${date}T00:00:00Z`, `${date}T23:59:59Z`]);
  } else {
    // 6-hour blocks
    for (let h = 0; h < 24; h += 6) {
      const s = `${date}T${String(h).padStart(2,'0')}:00:00Z`;
      const e = `${date}T${String(h+5).padStart(2,'0')}:59:59Z`;
      slices.push([s, e]);
    }
  }

  for (const [s, e] of slices) {
    const q = encodeURIComponent(`type:ticket created>=${s} created<=${e}`);
    let page = 1, hasMore = true;
    while (hasMore) {
      const { status, data } = await zdRequest(subdomain, auth,
        `/api/v2/search.json?query=${q}&sort_by=created_at&sort_order=asc&per_page=100&page=${page}`);
      if (status === 429) { await new Promise(r => setTimeout(r, 61000)); continue; }
      if (status !== 200) throw new Error(`ZD ${status}`);
      (data.results || []).forEach(t => processTicket(dayData, t));
      hasMore = !!data.next_page && page < 10;
      page++;
    }
  }

  // Finalize SLA
  if (dayData._slaTotal > 0) {
    dayData.slaOk = dayData._slaOkCount / dayData._slaTotal;
  } else {
    const solved = (dayData.byStatus['Resolvido'] || 0) + (dayData.byStatus['Fechado'] || 0);
    dayData.slaOk = dayData.total > 0 ? solved / dayData.total : 0;
  }
  dayData.slaViol = 1 - dayData.slaOk;
  delete dayData._slaTotal;
  delete dayData._slaOkCount;

  // Save to KV
  await kvSet(`tickets:${subdomain}:${date}`, JSON.stringify(dayData));
  res.write(`data: ${JSON.stringify({ saved: date, total: dayData.total })}\n\n`);
}

// ── handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ZD-Subdomain');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const subdomain = req.headers['x-zd-subdomain'];
  const auth = req.headers['authorization'];
  if (!subdomain || !auth) return res.status(400).json({ error: 'headers required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  // Generate days
  const days = [];
  let cur = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T23:59:59Z');
  while (cur <= endD) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  try {
    let done = 0;
    for (const day of days) {
      // Skip if already cached
      const cached = await kvGet(`tickets:${subdomain}:${day}`);
      if (cached) {
        done++;
        res.write(`data: ${JSON.stringify({ skipped: day, progress: Math.round(done/days.length*100) })}\n\n`);
        continue;
      }
      await fetchAndSaveDay(subdomain, auth, day, res);
      done++;
      res.write(`data: ${JSON.stringify({ progress: Math.round(done/days.length*100), day })}\n\n`);
    }

    // Save last sync timestamp
    await kvSet(`last_sync:${subdomain}`, new Date().toISOString());
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
};
