// api/clientes.js
// Lista clientes conhecidos de um negócio com estatísticas dos seus pedidos.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Método não permitido');

  const { negocio_id, senha } = req.query;
  const negocioId = negocio_id || 'default';

  const senhaValida = await validarSenha(negocioId, senha);
  if (!senhaValida) return res.status(401).json({ error: 'Senha inválida' });

  try {
    // Busca todos os pedidos pra agregar por subscriber
    const pedidos = (await redisCommand(['LRANGE', `n:${negocioId}:pedidos`, '0', '499']))
      ?.result?.map(b => JSON.parse(b)) || [];

    // Busca perfis de clientes (lista de IDs conhecidos)
    const clienteIds = [...new Set(pedidos.map(p => p.subscriberId).filter(Boolean))];

    const clientes = await Promise.all(clienteIds.map(async (subscriberId) => {
      // Busca perfil salvo
      let perfil = null;
      const resultado = await redisCommand(['GET', `n:${negocioId}:cliente:${subscriberId}`]);
      if (resultado?.result) perfil = JSON.parse(resultado.result);

      // Agrega pedidos desse subscriber
      const pedidosDoCliente = pedidos.filter(p => p.subscriberId === subscriberId);
      const pedidosConfirmados = pedidosDoCliente.filter(p => ['ativo', 'em_entrega', 'finalizado'].includes(p.status));
      const totalGasto = pedidosConfirmados.reduce((acc, p) => acc + (Number(p.total) || 0), 0);
      const ultimoPedido = pedidosDoCliente[0]; // lista já vem com mais recente primeiro

      return {
        subscriberId,
        nome: perfil?.instagramNome || perfil?.nome || ultimoPedido?.nome || 'Desconhecido',
        nomeDelivery: perfil?.nome || ultimoPedido?.nome || null,
        instagramUsername: perfil?.instagramUsername || null,
        instagramFoto: perfil?.instagramFoto || null,
        endereco: perfil?.endereco || null,
        pagamento: perfil?.pagamento || null,
        totalPedidos: pedidosConfirmados.length,
        totalLeads: pedidosDoCliente.filter(p => p.status === 'lead').length,
        totalGasto,
        ultimoContato: ultimoPedido?.criadoEm || null,
      };
    }));

    // Ordena por último contato (mais recente primeiro)
    clientes.sort((a, b) => new Date(b.ultimoContato) - new Date(a.ultimoContato));

    return res.status(200).json({ clientes });
  } catch (err) {
    console.error('Erro ao buscar clientes:', err);
    return res.status(500).json({ error: 'Erro ao buscar clientes' });
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
