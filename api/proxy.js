export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });

  const zdUrl = decodeURIComponent(url);

  try {
    const zdRes = await fetch(zdUrl, {
      headers: {
        'Authorization': req.headers['authorization'],
        'Content-Type': 'application/json',
      }
    });
    const data = await zdRes.json();
    return res.status(zdRes.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
```

4. Clique em **"Commit changes"**

---

### Passo 4 — Conecte ao Vercel

1. No **Vercel**, clique em **"Add New Project"**
2. Selecione o repositório `zendesk-proxy`
3. Clique em **"Deploy"** — sem mudar nada
4. Aguarde o deploy (menos de 1 minuto)
5. Ao finalizar, copie a URL gerada. Será algo como:
```
https://zendesk-proxy-seunome.vercel.app
