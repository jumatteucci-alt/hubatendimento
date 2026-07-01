// api/pedidos.js
// Retorna pedidos, alertas e erros de um negócio específico.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Método não permitido');

  const { negocio_id, senha } = req.query;
  const negocioId = negocio_id || 'default';

  // Valida senha do negócio
  const senhaValida = await validarSenha(negocioId, senha);
  if (!senhaValida) return res.status(401).json({ error: 'Senha inválida' });

  try {
    const chave = `n:${negocioId}:pedidos`;

    // Busca pedidos
    const brutos = (await redisCommand(['LRANGE', chave, '0', '99']))?.result || [];
    const pedidos = [];
    for (let i = 0; i < brutos.length; i++) {
      const pedido = JSON.parse(brutos[i]);
      // Migração automática: garante campo id
      if (!pedido.id) {
        pedido.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '-' + i;
        await redisCommand(['LSET', chave, String(i), JSON.stringify(pedido)]);
      }
      pedidos.push(pedido);
    }

    // Alertas pendentes
    const brutoAlertas = (await redisCommand(['LRANGE', `n:${negocioId}:alertas_humano`, '0', '49']))?.result || [];
    const alertas = brutoAlertas.map(a => JSON.parse(a)).filter(a => a.status === 'pendente');

    // Erros recentes
    const brutoErros = (await redisCommand(['LRANGE', `n:${negocioId}:erros_sistema`, '0', '4']))?.result || [];
    const erros = brutoErros.map(e => JSON.parse(e));

    // Verifica se o token do Instagram está próximo de expirar (menos de 15 dias)
    let avisoToken = null;
    const tokenExpira = (await redisCommand(['GET', 'ig_token_expira_em']))?.result;
    if (tokenExpira) {
      const diasRestantes = Math.floor((new Date(tokenExpira) - Date.now()) / (1000 * 60 * 60 * 24));
      if (diasRestantes <= 15) {
        avisoToken = `Token do Instagram expira em ${diasRestantes} dia(s). Acesse /api/renovar-token?admin_senha=SUA_SENHA pra renovar agora.`;
      }
    }

    // Estado de pausa
    const pausado = (await redisCommand(['GET', `n:${negocioId}:pausado`]))?.result === '1';

    return res.status(200).json({ pedidos, alertas, erros, avisoToken, pausado });
  } catch (err) {
    console.error('Erro ao buscar pedidos:', err);
    return res.status(500).json({ error: 'Erro ao buscar pedidos' });
  }
}

async function validarSenha(negocioId, senha) {
  if (!senha) return false;
  // Busca a senha do negócio no Redis
  const resultado = await redisCommand(['GET', `n:${negocioId}:senha`]);
  if (resultado?.result) return resultado.result === senha;
  // Retrocompatibilidade: negocio "default" usa a variável de ambiente
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
