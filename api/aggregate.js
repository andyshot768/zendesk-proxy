const https = require('https');

// ── helpers ───────────────────────────────────────────────────────────────────
function zdRequest(subdomain, auth, path) {
  return new Promise((resolve, reject) => {
    const url = `https://${subdomain}.zendesk.com${path}`;
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { reject(new Error('JSON parse error: ' + body.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function classifySubject(s) {
  s = s.toUpperCase();
  if (/entrega|prazo|atraso|frete/.test(s))        return 'ENTREGA';
  if (/cancel/.test(s))                             return 'CANCELAMENTO';
  if (/garantia/.test(s))                           return 'GARANTIA';
  if (/troca|devolv/.test(s))                       return 'TROCA DE MERCADORIA';
  if (/fatura|nota fiscal|boleto/.test(s))          return 'ERRO FATURAMENTO';
  if (/financ|pagamento|parcelamento/.test(s))      return 'INF. FINANCEIRAS';
  if (/medida|modelo|tamanho/.test(s))              return 'ERRO MEDIDA';
  if (/estoque/.test(s))                            return 'SEM ESTOQUE';
  if (/parceiro/.test(s))                           return 'REDE DE PARCEIROS';
  if (/psmóvel|ps movel|psmov/.test(s))             return 'PSMÓVEL';
  return null;
}

function processTicket(agg, t) {
  agg.total++;

  const d = (t.created_at || '').slice(0, 10);
  if (d) {
    agg.byDate[d]  = (agg.byDate[d]  || 0) + 1;
    const mo = d.slice(0, 7);
    agg.byMonth[mo] = (agg.byMonth[mo] || 0) + 1;
  }

  const chMap = { web:'Web', email:'E-mail', api:'API', mobile:'Mobile', chat:'Chat',
    voice:'Voz', any_channel:'Omnichannel', instagram_dm:'Instagram',
    twitter_dm:'Twitter', facebook:'Facebook', whatsapp:'WhatsApp' };
  const ch = chMap[t.via?.channel || t.channel || ''] || (t.via?.channel || 'outro');
  agg.byCanal[ch] = (agg.byCanal[ch] || 0) + 1;

  const stMap = { new:'Novo', open:'Aberto', pending:'Pendente', hold:'Em espera', solved:'Resolvido', closed:'Fechado' };
  const st = stMap[t.status] || t.status || '?';
  agg.byStatus[st] = (agg.byStatus[st] || 0) + 1;

  const tpMap = { problem:'Problema', incident:'Incidente', question:'Dúvida', task:'Tarefa' };
  const tp = tpMap[t.type] || 'Não classificado';
  agg.byTipo[tp] = (agg.byTipo[tp] || 0) + 1;

  const prMap = { low:'Baixa', normal:'Normal', high:'Alta', urgent:'Urgente' };
  const pr = prMap[t.priority] || 'Normal';
  agg.byPrioridade[pr] = (agg.byPrioridade[pr] || 0) + 1;

  const subj = (t.subject || '').trim();
  if (subj) {
    const cat = classifySubject(subj);
    const key = cat || (subj.length > 30 ? subj.slice(0, 28) + '…' : subj);
    agg.byAssunto[key] = (agg.byAssunto[key] || 0) + 1;
  }

  (t.tags || []).forEach(tag => { agg.byTag[tag] = (agg.byTag[tag] || 0) + 1; });

  if (t.sla_policy) {
    agg._slaTotal++;
    const metrics = t.sla_policy?.policy_metrics || [];
    if (!metrics.some(m => m.breached)) agg._slaOkCount++;
  }
}

function initAgg() {
  return {
    total: 0,
    byDate: {}, byMonth: {}, byCanal: {}, byStatus: {},
    byTipo: {}, byPrioridade: {}, byAssunto: {}, byTag: {},
    _slaTotal: 0, _slaOkCount: 0,
    slaOk: 0, slaViol: 0,
    csat: null,
  };
}

function finalizeAgg(agg) {
  if (agg._slaTotal > 0) {
    agg.slaOk   = agg._slaOkCount / agg._slaTotal;
    agg.slaViol = 1 - agg.slaOk;
  } else {
    const solved = (agg.byStatus['Resolvido'] || 0) + (agg.byStatus['Fechado'] || 0);
    agg.slaOk   = agg.total > 0 ? solved / agg.total : 0;
    agg.slaViol = 1 - agg.slaOk;
  }
  delete agg._slaTotal;
  delete agg._slaOkCount;
  return agg;
}

// ── fetch one day with full pagination ───────────────────────────────────────
async function fetchDay(subdomain, auth, day, agg) {
  const q = encodeURIComponent(`type:ticket created>=${day} created<=${day}`);
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const { status, data } = await zdRequest(
      subdomain, auth,
      `/api/v2/search.json?query=${q}&sort_by=created_at&sort_order=asc&per_page=100&page=${page}`
    );
    if (status === 429) {
      // Rate limit — wait 60s
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    if (status !== 200) throw new Error(`Zendesk ${status}: ${JSON.stringify(data)}`);
    (data.results || []).forEach(t => processTicket(agg, t));
    hasMore = !!data.next_page;
    page++;
  }
}

// ── main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ZD-Subdomain');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end params required' });

  const subdomain = req.headers['x-zd-subdomain'];
  const auth      = req.headers['authorization'];
  if (!subdomain || !auth) return res.status(400).json({ error: 'x-zd-subdomain header required' });

  // Generate list of days
  const days = [];
  let cur = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T23:59:59Z');
  while (cur <= endD) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  if (days.length > 366) return res.status(400).json({ error: 'Max 366 days per request' });

  // Use streaming response so browser gets progress updates
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  const agg = initAgg();
  let done = 0;

  try {
    for (const day of days) {
      await fetchDay(subdomain, auth, day, agg);
      done++;
      // Send progress event
      res.write(`data: ${JSON.stringify({ progress: Math.round(done / days.length * 100), total: agg.total, day })}\n\n`);
    }

    // Fetch satisfaction ratings
    try {
      const startUnix = Math.floor(new Date(start + 'T00:00:00Z').getTime() / 1000);
      const endUnix   = Math.floor(new Date(end   + 'T23:59:59Z').getTime() / 1000);
      const { data: satData } = await zdRequest(
        subdomain, auth,
        `/api/v2/satisfaction_ratings.json?score=all&start_time=${startUnix}&end_time=${endUnix}`
      );
      const ratings = satData.satisfaction_ratings || [];
      if (ratings.length > 0) {
        const good = ratings.filter(r => r.score === 'good').length;
        agg.csat = good / ratings.length;
      }
    } catch(e) { /* optional */ }

    finalizeAgg(agg);

    // Send final result
    res.write(`data: ${JSON.stringify({ done: true, result: agg })}\n\n`);
    res.end();

  } catch(e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
};
