// api/admin.js
// Endpoint de administração: cria e lista negócios.
// Protegido pela variável de ambiente ADMIN_SENHA.

export default async function handler(req, res) {
  const adminSenha = req.method === 'GET' ? req.query.admin_senha : req.body?.admin_senha;
  if (!adminSenha || adminSenha !== process.env.ADMIN_SENHA) {
    return res.status(401).json({ error: 'Acesso negado' });
  }

  if (req.method === 'GET') {
    // Lista todos os negócios cadastrados
    try {
      const resultado = await redisCommand(['LRANGE', 'negocios', '0', '-1']);
      const ids = resultado?.result || [];
      const negocios = await Promise.all(ids.map(async id => {
        const config = await redisCommand(['GET', `n:${id}:config`]);
        const negocio = config?.result ? JSON.parse(config.result) : {};
        return { id, nome: negocio.nome || id, tipo: negocio.tipo || 'delivery' };
      }));
      return res.status(200).json({ negocios });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao listar negócios' });
    }
  }

  if (req.method === 'POST') {
    const { id, nome, senha } = req.body || {};
    if (!id || !nome || !senha) return res.status(400).json({ error: 'id, nome e senha são obrigatórios' });
    if (!/^[a-z0-9_-]+$/.test(id)) return res.status(400).json({ error: 'id deve conter apenas letras minúsculas, números, _ ou -' });

    try {
      // Verifica se já existe
      const existe = await redisCommand(['GET', `n:${id}:senha`]);
      if (existe?.result) return res.status(409).json({ error: 'Já existe um negócio com esse id' });

      // Salva a senha e o cadastro inicial
      await redisCommand(['SET', `n:${id}:senha`, senha]);
      await redisCommand(['SET', `n:${id}:config`, JSON.stringify({ nome, tipo: 'delivery', itens: [] })]);
      await redisCommand(['LPUSH', 'negocios', id]);

      return res.status(200).json({ ok: true, id, nome });
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao criar negócio' });
    }
  }

  return res.status(405).send('Método não permitido');
}

async function redisCommand(comando) {
  const response = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  return response.json();
}
