// api/pedido-acao.js
// Ações em pedidos: entregando, finalizar, excluir, resetar_conversa, resolver_alerta.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Método não permitido');

  const { senha, negocio_id, id, acao, subscriberId, alertaId } = req.body || {};
  const negocioId = negocio_id || 'default';

  const senhaValida = await validarSenha(negocioId, senha);
  if (!senhaValida) return res.status(401).json({ error: 'Senha inválida' });

  try {
    if (acao === 'assumir_conversa') {
      if (!subscriberId) return res.status(400).json({ error: 'subscriberId é obrigatório' });
      // Marca o subscriber como assumido por humano no Redis
      await redisCommand(['SET', `n:${negocioId}:humano:${subscriberId}`, '1']);
      // Atualiza o campo no pedido também
      if (id) {
        const chave = `n:${negocioId}:pedidos`;
        const lista = (await redisCommand(['LRANGE', chave, '0', '99']))?.result || [];
        for (let i = 0; i < lista.length; i++) {
          const pedido = JSON.parse(lista[i]);
          if (pedido.id === id) {
            pedido.assumidoPorHumano = true;
            await redisCommand(['LSET', chave, String(i), JSON.stringify(pedido)]);
            break;
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (acao === 'devolver_bot') {
      if (!subscriberId) return res.status(400).json({ error: 'subscriberId é obrigatório' });
      await redisCommand(['DEL', `n:${negocioId}:humano:${subscriberId}`]);
      if (id) {
        const chave = `n:${negocioId}:pedidos`;
        const lista = (await redisCommand(['LRANGE', chave, '0', '99']))?.result || [];
        for (let i = 0; i < lista.length; i++) {
          const pedido = JSON.parse(lista[i]);
          if (pedido.id === id) {
            pedido.assumidoPorHumano = false;
            await redisCommand(['LSET', chave, String(i), JSON.stringify(pedido)]);
            break;
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (acao === 'pausar' || acao === 'retomar') {
      const valor = acao === 'pausar' ? '1' : '0';
      await redisCommand(['SET', `n:${negocioId}:pausado`, valor]);
      return res.status(200).json({ ok: true, pausado: acao === 'pausar' });
    }

    if (acao === 'resetar_conversa') {
      if (!subscriberId) return res.status(400).json({ error: 'subscriberId é obrigatório' });

      // Apaga o histórico de conversa
      await redisCommand(['DEL', `n:${negocioId}:historico:${subscriberId}`]);

      // Limpa os dados coletados do cliente mas preserva o perfil do Instagram
      const clienteRaw = await redisCommand(['GET', `n:${negocioId}:cliente:${subscriberId}`]);
      if (clienteRaw?.result) {
        const cliente = JSON.parse(clienteRaw.result);
        const perfilLimpo = {
          instagramUsername: cliente.instagramUsername || null,
          instagramNome: cliente.instagramNome || null,
          instagramFoto: cliente.instagramFoto || null,
          atualizadoEm: new Date().toISOString(),
        };
        await redisCommand(['SET', `n:${negocioId}:cliente:${subscriberId}`, JSON.stringify(perfilLimpo)]);
      }

      return res.status(200).json({ ok: true });
    }

    if (acao === 'resolver_alerta') {
      if (!alertaId) return res.status(400).json({ error: 'alertaId é obrigatório' });
      const chaveAlerta = `n:${negocioId}:alertas_humano`;
      const listaAlertas = (await redisCommand(['LRANGE', chaveAlerta, '0', '99']))?.result || [];
      for (let i = 0; i < listaAlertas.length; i++) {
        const alerta = JSON.parse(listaAlertas[i]);
        if (alerta.id === alertaId) {
          alerta.status = 'resolvido';
          await redisCommand(['LSET', chaveAlerta, String(i), JSON.stringify(alerta)]);
          break;
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (!id || !['entregando', 'finalizar', 'excluir', 'cancelar'].includes(acao)) {
      return res.status(400).json({ error: 'Parâmetros inválidos' });
    }

    const chave = `n:${negocioId}:pedidos`;
    const lista = (await redisCommand(['LRANGE', chave, '0', '99']))?.result || [];

    let encontrado = null;
    let index = -1;
    for (let i = 0; i < lista.length; i++) {
      const pedido = JSON.parse(lista[i]);
      if (pedido.id === id) { encontrado = pedido; index = i; break; }
    }

    if (!encontrado) return res.status(404).json({ error: 'Pedido não encontrado' });

    if (acao === 'cancelar') {
      encontrado.status = 'cancelado';
      encontrado.canceladoEm = new Date().toISOString();
      encontrado.canceladoPor = 'painel';
      await redisCommand(['LSET', chave, String(index), JSON.stringify(encontrado)]);
    }

    if (acao === 'entregando') {
      encontrado.status = 'em_entrega';
      encontrado.saiuParaEntregaEm = new Date().toISOString();
      await redisCommand(['LSET', chave, String(index), JSON.stringify(encontrado)]);

      const mensagem = encontrado.tipo === 'agendamento'
        ? 'Seu agendamento foi confirmado! ✅'
        : encontrado.tipo === 'produto_digital'
        ? 'Sua compra foi confirmada! ✅ Em breve você recebe o acesso.'
        : 'Seu pedido saiu para entrega! 🛵 Chega em breve.';
      await enviarMensagemManyChat(encontrado.subscriberId, mensagem);
    }

    if (acao === 'finalizar') {
      encontrado.status = 'finalizado';
      encontrado.finalizadoEm = new Date().toISOString();
      await redisCommand(['LSET', chave, String(index), JSON.stringify(encontrado)]);
    }

    if (acao === 'excluir') {
      await redisCommand(['LREM', chave, '1', lista[index]]);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro ao atualizar pedido:', err);
    return res.status(500).json({ error: 'Erro ao atualizar pedido' });
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

async function enviarMensagemManyChat(subscriberId, texto) {
  try {
    const response = await fetch('https://api.manychat.com/fb/sending/sendContent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.MANYCHAT_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscriber_id: subscriberId,
        data: { version: 'v2', content: { type: 'instagram', messages: [{ type: 'text', text: texto }] } },
      }),
    });
    if (!response.ok) console.error('Erro ao notificar cliente:', await response.text());
  } catch (err) {
    console.error('Erro ao notificar cliente:', err);
  }
}
