// api/pacote.js
// Cria, atualiza e serve pacotes de viagem.
// GET /api/pacote?id=CODIGO — público, sem autenticação (pra página pública do pacote)
// GET /api/pacote?negocio_id=X&senha=Y — lista pacotes do negócio (painel)
// POST /api/pacote — cria ou atualiza pacote (requer senha)
// DELETE /api/pacote?id=CODIGO&negocio_id=X&senha=Y — remove pacote

export default async function handler(req, res) {
  // GET público: busca um pacote pelo ID
  if (req.method === 'GET' && req.query.id && !req.query.senha) {
    try {
      const resultado = await redisCommand(['GET', `pacote:${req.query.id}`]);
      if (!resultado?.result) return res.status(404).json({ error: 'Pacote não encontrado' });
      return res.status(200).json({ pacote: JSON.parse(resultado.result) });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao buscar pacote' });
    }
  }

  // GET autenticado: lista pacotes do negócio
  if (req.method === 'GET' && req.query.senha) {
    const negocioId = req.query.negocio_id || 'default';
    if (!await validarSenha(negocioId, req.query.senha)) return res.status(401).json({ error: 'Senha inválida' });
    try {
      const ids = (await redisCommand(['LRANGE', `n:${negocioId}:pacotes`, '0', '99']))?.result || [];
      const pacotes = await Promise.all(ids.map(async id => {
        const r = await redisCommand(['GET', `pacote:${id}`]);
        return r?.result ? JSON.parse(r.result) : null;
      }));
      return res.status(200).json({ pacotes: pacotes.filter(Boolean) });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao listar pacotes' });
    }
  }

  // POST: cria ou atualiza pacote
  if (req.method === 'POST') {
    const { negocio_id, senha, pacote } = req.body || {};
    const negocioId = negocio_id || 'default';
    if (!await validarSenha(negocioId, senha)) return res.status(401).json({ error: 'Senha inválida' });
    if (!pacote) return res.status(400).json({ error: 'Dados do pacote são obrigatórios' });

    try {
      // Gera ID se for novo
      const id = pacote.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const registro = { ...pacote, id, negocioId, atualizadoEm: new Date().toISOString() };

      await redisCommand(['SET', `pacote:${id}`, JSON.stringify(registro)]);

      // Adiciona à lista do negócio se for novo
      if (!pacote.id) {
        await redisCommand(['LPUSH', `n:${negocioId}:pacotes`, id]);
      }

      return res.status(200).json({ ok: true, id, pacote: registro });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao salvar pacote' });
    }
  }

  // DELETE: remove pacote
  if (req.method === 'DELETE') {
    const { id, negocio_id, senha } = req.query;
    const negocioId = negocio_id || 'default';
    if (!await validarSenha(negocioId, senha)) return res.status(401).json({ error: 'Senha inválida' });
    if (!id) return res.status(400).json({ error: 'ID é obrigatório' });

    try {
      await redisCommand(['DEL', `pacote:${id}`]);
      await redisCommand(['LREM', `n:${negocioId}:pacotes`, '1', id]);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao remover pacote' });
    }
  }

  return res.status(405).send('Método não permitido');
}

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
