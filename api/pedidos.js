// api/pedidos.js
// Endpoint que retorna a lista de pedidos salvos, protegido por senha simples.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Método não permitido');
  }

  const senha = req.query.senha;
  if (!senha || senha !== process.env.PAINEL_SENHA) {
    return res.status(401).json({ error: 'Senha inválida' });
  }

  try {
    const response = await fetch(process.env.KV_REST_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['LRANGE', 'pedidos', '0', '99']),
    });

    const data = await response.json();
    const pedidos = (data.result || []).map(item => JSON.parse(item));

    return res.status(200).json({ pedidos });
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    return res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
}
