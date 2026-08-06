// Allowlist dos endpoints que o front-end (app.js) realmente usa.
// Evita que este proxy vire um relay aberto para qualquer path da TMDB
// (abuso de cota/custo por terceiros que descubram a URL).
const ALLOWED_ENDPOINTS = [
    /^\/trending\/all\/week$/,
    /^\/search\/multi$/,
    /^\/genre\/movie\/list$/,
    /^\/discover\/movie$/,
    /^\/movie\/\d+$/,
    /^\/movie\/\d+\/credits$/,
    /^\/tv\/\d+$/,
    /^\/tv\/\d+\/credits$/,
    /^\/tv\/\d+\/season\/\d+$/,
];

export default async function handler(req, res) {
    // 1. Pega os parâmetros da URL (ex: endpoint, query, page)
    const { endpoint, ...params } = req.query;

    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint é obrigatório' });
    }

    if (!ALLOWED_ENDPOINTS.some((re) => re.test(endpoint))) {
        return res.status(400).json({ error: 'Endpoint não permitido' });
    }

    // 2. Resgata a chave das variáveis de ambiente da Vercel
    const apiKey = process.env.TMDB_API_KEY;

    // 3. Reconstrói os query params para repassar à TMDB
    const searchParams = new URLSearchParams({
        api_key: apiKey,
        language: 'pt-BR',
        ...params // Repassa busca, página, etc.
    });

    try {
        const url = `https://api.themoviedb.org/3${endpoint}?${searchParams.toString()}`;
        const response = await fetch(url);
        const data = await response.json();

        // 4. Devolve o resultado para o seu frontend
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao consultar a TMDB' });
    }
}