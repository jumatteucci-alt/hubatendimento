// api/negocio.js
// Lê e salva a configuração de um negócio específico.

export default async function handler(req, res) {
  const { negocio_id } = req.method === 'GET' ? req.query : req.body || {};
  const senha = req.method === 'GET' ? req.query.senha : req.body?.senha;
  const negocioId = negocio_id || 'default';

  const senhaValida = await validarSenha(negocioId, senha);
  if (!senhaValida) return res.status(401).json({ error: 'Senha inválida' });

  if (req.method === 'GET') {
    try {
      const resultado = await redisCommand(['GET', `n:${negocioId}:config`]);
      // Retrocompatibilidade: busca chave antiga se não tiver a nova
      if (!resultado?.result) {
        const legado = await redisCommand(['GET', 'negocio:config']);
        const negocio = legado?.result ? JSON.parse(legado.result) : NEGOCIO_PADRAO;
        return res.status(200).json({ negocio });
      }
      return res.status(200).json({ negocio: JSON.parse(resultado.result) });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao buscar negócio' });
    }
  }

  if (req.method === 'POST') {
    const { negocio } = req.body;
    if (!negocio) return res.status(400).json({ error: 'Formato inválido' });
    try {
      await redisCommand(['SET', `n:${negocioId}:config`, JSON.stringify(negocio)]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao salvar negócio' });
    }
  }

  return res.status(405).send('Método não permitido');
}

const NEGOCIO_PADRAO = {
  tipo: 'delivery', nome: 'Delivery', horario: '18h às 23h, todos os dias',
  taxaEntrega: 6.0, tempoMedio: '35 a 45 minutos',
  itens: [{ nome: 'Pizza grande de calabresa', preco: 54.9, descricao: '' }],
};

async function validarSenha(negocioId, senha) {
  if (!senha) return false;
  const resultado = await redisCommand(['GET', `n:${negocioId}:senha`]);
  if (resultado?.result) return resultado.result === senha;
  if (negocioId === 'default') return senha === process.env.PAINEL_SENHA;
  return false;
}

async function redisCommand(comando) {
  const response = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  return response.json();
}
