// api/negocio.js
// Endpoint pra ler e salvar o cadastro do negócio (cardápio, horário, taxa de entrega).
// Protegido pela mesma senha do painel de pedidos.

const NEGOCIO_PADRAO = {
  nome: 'Delivery',
  horario: '18h às 23h, todos os dias',
  taxaEntrega: 6.0,
  tempoMedio: '35 a 45 minutos',
  itens: [
    { nome: 'Pizza grande de calabresa', preco: 54.9, descricao: '' },
    { nome: 'Pizza grande de mussarela', preco: 49.9, descricao: '' },
    { nome: 'Refrigerante lata', preco: 6.0, descricao: '' },
    { nome: 'Borda recheada (catupiry)', preco: 12.0, descricao: '' },
  ],
};

export default async function handler(req, res) {
  const senha = req.method === 'GET' ? req.query.senha : req.body?.senha;
  if (!senha || senha !== process.env.PAINEL_SENHA) {
    return res.status(401).json({ error: 'Senha inválida' });
  }

  if (req.method === 'GET') {
    try {
      const resultado = await redisCommand(['GET', 'negocio:config']);
      const negocio = resultado?.result ? JSON.parse(resultado.result) : NEGOCIO_PADRAO;
      return res.status(200).json({ negocio });
    } catch (err) {
      console.error('Erro ao buscar negócio:', err);
      return res.status(500).json({ error: 'Erro ao buscar negócio' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { negocio } = req.body;
      if (!negocio || !Array.isArray(negocio.itens)) {
        return res.status(400).json({ error: 'Formato inválido' });
      }
      await redisCommand(['SET', 'negocio:config', JSON.stringify(negocio)]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Erro ao salvar negócio:', err);
      return res.status(500).json({ error: 'Erro ao salvar negócio' });
    }
  }

  return res.status(405).send('Método não permitido');
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
