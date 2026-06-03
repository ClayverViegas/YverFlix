export default async function handler(req, res) {
  // Apenas POST permitido
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { targetUrl, payload } = req.body;

  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'targetUrl é obrigatório' });
  }

  // Whitelist de domínios permitidos — evita SSRF aberto
  const ALLOWED_HOSTS = [
    'xn--kcksk7a2bl5le7b6doc1h3f.xn--kcksk7a2bl5le7b6doc1h3f.com',
    'superflixapi.fit',
    'superflixapi.best',
  ];

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'targetUrl inválida' });
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).json({ error: 'Domínio não permitido' });
  }

  // Headers que o player exige — injetados server-side
  const spoofedHeaders = {
    'Referer': 'https://nimbu.lat/',
    'Origin': 'https://nimbu.lat',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };

  // Se há payload, é JSON (Content-Type applicável)
  const hasPayload = payload && typeof payload === 'object' && Object.keys(payload).length > 0;

  const fetchOpts = {
    method: 'POST',
    headers: {
      ...spoofedHeaders,
      ...(hasPayload ? { 'Content-Type': 'application/json' } : {}),
    },
  };

  if (hasPayload) {
    fetchOpts.body = JSON.stringify(payload);
  }

  try {
    const upstream = await fetch(targetUrl, fetchOpts);

    // Repassa o status code original caso a API deles falhe
    const contentType = upstream.headers.get('content-type') || '';

    if (!upstream.ok) {
      let errorBody;
      try {
        errorBody = await upstream.text();
      } catch {
        errorBody = null;
      }
      return res.status(upstream.status).json({
        error: 'Upstream retornou HTTP ' + upstream.status,
        upstream_status: upstream.status,
        detail: errorBody ? errorBody.slice(0, 500) : null,
      });
    }

    // Tenta JSON; se upstream não retornar JSON, devolve texto bruto
    if (contentType.includes('application/json')) {
      const data = await upstream.json();
      return res.status(200).json(data);
    }

    const text = await upstream.text();
    return res.status(200).json({ raw: text });
  } catch (err) {
    console.error('[proxy] Erro ao contatar upstream:', err.message);
    return res.status(502).json({ error: 'Falha ao contatar upstream: ' + err.message });
  }
}
