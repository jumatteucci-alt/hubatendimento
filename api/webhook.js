// api/webhook.js
// Endpoint que recebe mensagens do Instagram (via Meta) e responde automaticamente.
// Deploy: este arquivo deve ficar na pasta /api na raiz do mesmo projeto Vercel do site.

export default async function handler(req, res) {
  // 1. VERIFICAÇÃO DO WEBHOOK (a Meta chama isso uma vez, via GET, ao cadastrar a URL)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('Webhook verificado com sucesso.');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Token de verificação inválido.');
  }

  // 2. RECEBIMENTO DE MENSAGENS
  if (req.method === 'POST') {
    const body = req.body;

    console.log('PAYLOAD COMPLETO RECEBIDO:', JSON.stringify(body));

    try {
      // FORMATO MANYCHAT: requisição vinda da ação "External Request"
      // Aqui devolvemos a resposta no corpo, o próprio ManyChat envia a mensagem pro usuário.
      if (body.source === 'manychat') {
        const userText = body.text || '';
        const subscriberId = body.subscriber_id || 'desconhecido';

        console.log(`[ManyChat] Mensagem de ${subscriberId}: ${userText}`);

        const { replyText, pedidoFechado } = await processarMensagem(subscriberId, userText);

        if (pedidoFechado) {
          await salvarPedido(subscriberId, pedidoFechado);
          console.log('Pedido salvo:', JSON.stringify(pedidoFechado));
        }

        return res.status(200).json({ reply: replyText });
      }

      // FORMATO META (webhook direto do Instagram/WhatsApp): mantemos como já estava
      const entry = body.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messagingEvent = entry?.messaging?.[0];

      const senderId = value?.sender?.id || messagingEvent?.sender?.id;
      const userText = value?.message?.text || messagingEvent?.message?.text;

      if (senderId && userText) {
        console.log(`Mensagem recebida de ${senderId}: ${userText}`);
        await sendInstagramReply(senderId, `Recebi sua mensagem: "${userText}". Em breve um agente de IA vai responder isso automaticamente.`);
      } else {
        console.log('Nenhuma mensagem de texto encontrada nos formatos conhecidos.');
      }

      return res.status(200).send('EVENT_RECEIVED');
    } catch (err) {
      console.error('Erro ao processar webhook:', err);
      return res.status(200).send('EVENT_RECEIVED');
    }
  }

  return res.status(405).send('Método não permitido');
}

const SYSTEM_PROMPT = `Você é o atendente virtual de um restaurante de delivery, via Instagram.

REGRAS:
- Seja direto e simpático, como um atendente real escreveria, sem formalidade excessiva
- Nunca invente item, preço ou prazo que não está no cardápio abaixo
- Se o cliente pedir algo fora do cardápio, diga que não tem e sugira algo parecido
- Ao montar um pedido, sempre peça nome, endereço de entrega e forma de pagamento antes de confirmar
- Ofereça um item adicional (bebida ou acompanhamento) antes de fechar o pedido
- Se a dúvida for sobre reclamação ou algo fora do seu escopo, diga que vai chamar o responsável
- Quando o cliente já tiver dado todas as informações (itens, nome, endereço, pagamento) e confirmado o pedido, responda normalmente confirmando, e ADICIONE no final da sua resposta um bloco assim, exatamente neste formato, sem nada antes ou depois dele:
###PEDIDO###
{"itens":["Pizza grande de calabresa"],"total":54.90,"nome":"Nome do cliente","endereco":"Endereço completo","pagamento":"forma de pagamento"}
###FIM###
- Se ainda faltar alguma informação, NÃO inclua esse bloco, apenas continue perguntando

CARDÁPIO:
- Pizza grande de calabresa — R$ 54,90
- Pizza grande de mussarela — R$ 49,90
- Refrigerante lata — R$ 6,00
- Borda recheada (catupiry) — R$ 12,00

HORÁRIO: 18h às 23h, todos os dias
TAXA DE ENTREGA: R$ 6,00
TEMPO MÉDIO: 35 a 45 minutos

Responda de forma curta, como em uma conversa real de WhatsApp/Instagram, sem parágrafos longos.`;

async function processarMensagem(subscriberId, mensagemDoCliente) {
  const historico = await buscarHistorico(subscriberId);

  const contents = [
    ...historico,
    { role: 'user', parts: [{ text: mensagemDoCliente }] },
  ];

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro na API do Gemini:', JSON.stringify(data));
      return { replyText: 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?', pedidoFechado: null };
    }

    const textoCompleto = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Desculpa, não consegui entender. Pode reformular?';

    // Extrai o bloco de pedido, se existir, e limpa o texto antes de mandar pro cliente
    let replyText = textoCompleto;
    let pedidoFechado = null;

    const match = textoCompleto.match(/###PEDIDO###([\s\S]*?)###FIM###/);
    if (match) {
      try {
        pedidoFechado = JSON.parse(match[1].trim());
      } catch (e) {
        console.error('Não foi possível parsear o bloco de pedido:', match[1]);
      }
      replyText = textoCompleto.replace(/###PEDIDO###[\s\S]*?###FIM###/, '').trim();
    }

    // Atualiza o histórico (mensagem do cliente + resposta da IA, sem o bloco de pedido) e salva
    const novoHistorico = [
      ...contents,
      { role: 'model', parts: [{ text: textoCompleto }] },
    ];
    await salvarHistorico(subscriberId, novoHistorico);

    return { replyText, pedidoFechado };
  } catch (err) {
    console.error('Erro ao chamar a IA:', err);
    return { replyText: 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?', pedidoFechado: null };
  }
}

// --- Funções de armazenamento via Upstash Redis (REST API) ---

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

async function buscarHistorico(subscriberId) {
  try {
    const resultado = await redisCommand(['GET', `historico:${subscriberId}`]);
    return resultado?.result ? JSON.parse(resultado.result) : [];
  } catch (err) {
    console.error('Erro ao buscar histórico:', err);
    return [];
  }
}

async function salvarHistorico(subscriberId, historico) {
  try {
    // Mantém só as últimas 20 mensagens, pra não crescer demais o contexto
    const recortado = historico.slice(-20);
    await redisCommand(['SET', `historico:${subscriberId}`, JSON.stringify(recortado)]);
  } catch (err) {
    console.error('Erro ao salvar histórico:', err);
  }
}

async function salvarPedido(subscriberId, pedido) {
  try {
    const registro = { ...pedido, subscriberId, criadoEm: new Date().toISOString() };
    await redisCommand(['LPUSH', 'pedidos', JSON.stringify(registro)]);
  } catch (err) {
    console.error('Erro ao salvar pedido:', err);
  }
}

async function sendInstagramReply(recipientId, text) {
  // LOG TEMPORÁRIO DE DEBUG: confirma se a variável chegou, sem expor o valor completo
  const tokenPreview = process.env.IG_ACCESS_TOKEN
    ? `definido, ${process.env.IG_ACCESS_TOKEN.length} caracteres, começa com "${process.env.IG_ACCESS_TOKEN.slice(0, 6)}..."`
    : 'INDEFINIDO (variável não encontrada)';
  console.log('IG_ACCESS_TOKEN:', tokenPreview);

  const url = `https://graph.instagram.com/v21.0/me/messages?access_token=${process.env.IG_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('Erro ao enviar resposta pro Instagram:', errorBody);
  }
}
