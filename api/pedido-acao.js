// api/pedido-acao.js
// Endpoint que o painel de pedidos chama quando o dono clica em "Saiu para entrega" ou "Finalizar".

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Método não permitido');
  }

  const { senha, id, acao, subscriberId, alertaId } = req.body || {};

  if (!senha || senha !== process.env.PAINEL_SENHA) {
    return res.status(401).json({ error: 'Senha inválida' });
  }

  try {
    // AÇÃO: resetar a memória da conversa de um cliente específico (não depende de um pedido)
    if (acao === 'resetar_conversa') {
      if (!subscriberId) return res.status(400).json({ error: 'subscriberId é obrigatório' });
      await redisCommand(['DEL', `historico:${subscriberId}`]);
      return res.status(200).json({ ok: true });
    }

    // AÇÃO: marcar um alerta de "chamar humano" como resolvido
    if (acao === 'resolver_alerta') {
      if (!alertaId) return res.status(400).json({ error: 'alertaId é obrigatório' });
      const resultadoAlertas = await redisCommand(['LRANGE', 'alertas_humano', '0', '99']);
      const listaAlertas = resultadoAlertas?.result || [];
      for (let i = 0; i < listaAlertas.length; i++) {
        const alerta = JSON.parse(listaAlertas[i]);
        if (alerta.id === alertaId) {
          alerta.status = 'resolvido';
          await redisCommand(['LSET', 'alertas_humano', String(i), JSON.stringify(alerta)]);
          break;
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (!id || !['entregando', 'finalizar', 'excluir'].includes(acao)) {
      return res.status(400).json({ error: 'Parâmetros inválidos' });
    }

    const resultado = await redisCommand(['LRANGE', 'pedidos', '0', '99']);
    const lista = resultado?.result || [];

    let encontrado = null;
    let index = -1;

    for (let i = 0; i < lista.length; i++) {
      const pedido = JSON.parse(lista[i]);
      if (pedido.id === id) {
        encontrado = pedido;
        index = i;
        break;
      }
    }

    if (!encontrado) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    if (acao === 'entregando') {
      encontrado.status = 'em_entrega';
      encontrado.saiuParaEntregaEm = new Date().toISOString();
      await redisCommand(['LSET', 'pedidos', String(index), JSON.stringify(encontrado)]);

      // Avisa o cliente, sem bloquear a resposta ao painel se isso falhar
      const mensagem = encontrado.tipo === 'agendamento'
        ? 'Seu agendamento foi confirmado! ✅'
        : 'Seu pedido saiu para entrega! 🛵 Chega em breve.';
      await enviarMensagemManyChat(encontrado.subscriberId, mensagem);
    }

    if (acao === 'finalizar') {
      encontrado.status = 'finalizado';
      encontrado.finalizadoEm = new Date().toISOString();
      await redisCommand(['LSET', 'pedidos', String(index), JSON.stringify(encontrado)]);
    }

    if (acao === 'excluir') {
      // Remove a entrada exata da lista (usa o valor bruto já armazenado, pra garantir match perfeito)
      await redisCommand(['LREM', 'pedidos', '1', lista[index]]);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao atualizar pedido:', err);
    return res.status(500).json({ error: 'Erro ao atualizar pedido' });
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

async function enviarMensagemManyChat(subscriberId, texto) {
  try {
    const response = await fetch('https://api.manychat.com/fb/sending/sendContent', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.MANYCHAT_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        data: {
          version: 'v2',
          content: {
            type: 'instagram',
            messages: [{ type: 'text', text: texto }],
          },
        },
      }),
    });
    if (!response.ok) {
      console.error('Erro ao notificar cliente:', await response.text());
    }
  } catch (err) {
    console.error('Erro ao notificar cliente:', err);
  }
}
