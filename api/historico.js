// api/historico.js
// Retorna o histórico de conversa de um subscriber em um negócio.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Método não permitido');

  const { negocio_id, senha, subscriber_id } = req.query;
  const negocioId = negocio_id || 'default';

  const senhaValida = await validarSenha(negocioId, senha);
  if (!senhaValida) return res.status(401).json({ error: 'Senha inválida' });

  if (!subscriber_id) return res.status(400).json({ error: 'subscriber_id é obrigatório' });

  try {
    // Tenta chave com namespace primeiro, depois fallback pra chave legada
    let resultado = await redisCommand(['GET', `n:${negocioId}:historico:${subscriber_id}`]);
    if (!resultado?.result) {
      resultado = await redisCommand(['GET', `historico:${subscriber_id}`]);
    }

    const historico = resultado?.result ? JSON.parse(resultado.result) : [];
    return res.status(200).json({ historico });
  } catch (err) {
    console.error('Erro ao buscar histórico:', err);
    return res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
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
