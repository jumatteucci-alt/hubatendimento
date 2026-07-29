// api/exportar-conversas.js
// Exporta todas as conversas dos leads em formato legível para análise.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Metodo nao permitido');

  const { negocio_id, senha } = req.query;
  const negocioId = negocio_id || 'default';

  if (!await validarSenha(negocioId, senha)) return res.status(401).json({ error: 'Senha invalida' });

  try {
    // Busca todos os pedidos/leads
    const brutos = (await redisCommand(['LRANGE', `n:${negocioId}:pedidos`, '0', '499']))?.result || [];
    const pedidos = brutos.map(b => JSON.parse(b));

    const conversas = [];

    for (const pedido of pedidos) {
      const subscriberId = pedido.subscriberId;
      if (!subscriberId) continue;

      // Busca histórico ao vivo
      let historico = [];
      const h = await redisCommand(['GET', `n:${negocioId}:historico:${subscriberId}`]);
      if (h?.result) historico = JSON.parse(h.result);

      // Se não tiver histórico ao vivo, usa o snapshot do pedido
      if (!historico.length && pedido.conversaSnapshot) {
        historico = pedido.conversaSnapshot;
      }

      if (!historico.length) continue;

      // Formata a conversa como texto legível
      const mensagens = historico.map(m => {
        const role = m.role === 'user' ? 'CLIENTE' : 'BOT';
        const texto = (m.parts?.[0]?.text || '')
          .replace(/###PEDIDO###[\s\S]*?###FIM###/g, '')
          .replace(/###LEAD###[\s\S]*?###FIM###/g, '')
          .replace(/###CANCELAR###/g, '')
          .replace(/###CHAMAR_HUMANO###/g, '')
          .trim();
        return texto ? `${role}: ${texto}` : null;
      }).filter(Boolean);

      if (!mensagens.length) continue;

      conversas.push({
        lead: pedido.nome || subscriberId,
        status: pedido.status,
        dados: pedido.dados || {},
        criadoEm: pedido.criadoEm,
        conversa: mensagens,
      });
    }

    // Gera o texto formatado
    let texto = `EXPORTAÇÃO DE CONVERSAS — ${new Date().toLocaleDateString('pt-BR')}\n`;
    texto += `Total de conversas: ${conversas.length}\n`;
    texto += '='.repeat(60) + '\n\n';

    conversas.forEach((c, i) => {
      texto += `LEAD ${i + 1}: ${c.lead}\n`;
      texto += `Status: ${c.status} | Data: ${new Date(c.criadoEm).toLocaleDateString('pt-BR')}\n`;
      if (Object.keys(c.dados).length) {
        texto += `Dados coletados: ${Object.entries(c.dados).map(([k,v]) => `${k}: ${v}`).join(' | ')}\n`;
      }
      texto += '-'.repeat(40) + '\n';
      texto += c.conversa.join('\n') + '\n';
      texto += '='.repeat(60) + '\n\n';
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="conversas-${negocioId}-${new Date().toISOString().slice(0,10)}.txt"`);
    return res.status(200).send(texto);

  } catch (err) {
    console.error('Erro ao exportar conversas:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
}

async function validarSenha(negocioId, senha) {
  if (!senha) return false;
  const r = await redisCommand(['GET', `n:${negocioId}:senha`]);
  if (r?.result) return r.result === senha;
  if (negocioId === 'default') return senha === process.env.PAINEL_SENHA;
  return false;
}

async function redisCommand(cmd) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}
