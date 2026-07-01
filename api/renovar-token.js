// api/renovar-token.js
// Renova o token de acesso do Instagram antes de expirar (tokens duram 60 dias).
// Chamado automaticamente pelo Cron Job do Vercel todo dia 1 de cada mês às 10h.
// Também pode ser chamado manualmente via GET com ?admin_senha=SUASENHA.

export default async function handler(req, res) {
  // Verifica se é chamada do cron (Vercel injeta esse header) ou manual com senha
  const isCron = req.headers['x-vercel-cron'] === '1';
  const adminSenha = req.query.admin_senha;
  const autorizado = isCron || (adminSenha && adminSenha === process.env.ADMIN_SENHA);

  if (!autorizado) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  try {
    // Lê o token atual — Redis primeiro, depois env var
    const tokenAtual = await lerTokenAtual();
    if (!tokenAtual) {
      console.error('Renovação de token: nenhum token encontrado no Redis nem no env');
      return res.status(500).json({ error: 'Token não encontrado' });
    }

    // Chama a API do Instagram pra renovar
    const response = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${tokenAtual}`
    );
    const data = await response.json();

    if (!response.ok || !data.access_token) {
      console.error('Erro ao renovar token:', JSON.stringify(data));
      await registrarErroRenovacao(JSON.stringify(data));
      return res.status(500).json({ error: 'Falha ao renovar token', detalhe: data });
    }

    // Salva o novo token no Redis
    const novoToken = data.access_token;
    const expiresIn = data.expires_in || 5183944; // ~60 dias em segundos
    const expiraEm = new Date(Date.now() + expiresIn * 1000).toISOString();

    await redisCommand(['SET', 'ig_access_token', novoToken]);
    await redisCommand(['SET', 'ig_token_expira_em', expiraEm]);

    console.log(`Token renovado com sucesso. Expira em: ${expiraEm}`);
    return res.status(200).json({ ok: true, expiraEm });
  } catch (err) {
    console.error('Erro ao renovar token:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
}

async function lerTokenAtual() {
  try {
    // Tenta o token salvo no Redis primeiro (já renovado antes)
    const resultado = await redisCommand(['GET', 'ig_access_token']);
    if (resultado?.result) return resultado.result;
  } catch (err) {
    console.error('Erro ao ler token do Redis:', err);
  }
  // Fallback pro token original da variável de ambiente
  return process.env.IG_ACCESS_TOKEN || null;
}

async function registrarErroRenovacao(detalhe) {
  try {
    const registro = { detalhe, criadoEm: new Date().toISOString() };
    await redisCommand(['SET', 'ig_token_erro_renovacao', JSON.stringify(registro)]);
  } catch (err) {
    console.error('Erro ao registrar falha de renovação:', err);
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
