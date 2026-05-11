export default async function handler(req, res) {
    // 1. Pega os parâmetros da URL (ex: endpoint, query, page)
    const { endpoint, ...params } = req.query;

    if (!endpoint) {
        return res.status(400).json({ error: 'Endpoint é obrigatório' });
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