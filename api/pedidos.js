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
    const brutos = data.result || [];
    const pedidos = [];

    // Migração automática: pedidos antigos não tinham campo "id".
    // Aqui a gente detecta e corrige isso na primeira leitura, salvando de volta.
    for (let i = 0; i < brutos.length; i++) {
      const pedido = JSON.parse(brutos[i]);
      if (!pedido.id) {
        pedido.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '-' + i;
        await redisCommand(['LSET', 'pedidos', String(i), JSON.stringify(pedido)]);
      }
      pedidos.push(pedido);
    }

    return res.status(200).json({ pedidos });
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    return res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
}

async function redisCommand(comando) {
  const response = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(comando),
  });
  return response.json();
}
