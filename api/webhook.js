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

        const replyText = await gerarRespostaIA(userText);

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

async function gerarRespostaIA(mensagemDoCliente) {
  const systemPrompt = `Você é o atendente virtual de um restaurante de delivery, via Instagram.

REGRAS:
- Seja direto e simpático, como um atendente real escreveria, sem formalidade excessiva
- Nunca invente item, preço ou prazo que não está no cardápio abaixo
- Se o cliente pedir algo fora do cardápio, diga que não tem e sugira algo parecido
- Ao montar um pedido, sempre peça nome, endereço de entrega e forma de pagamento antes de confirmar
- Ofereça um item adicional (bebida ou acompanhamento) antes de fechar o pedido
- Se a dúvida for sobre reclamação ou algo fora do seu escopo, diga que vai chamar o responsável

CARDÁPIO:
- Pizza grande de calabresa — R$ 54,90
- Pizza grande de mussarela — R$ 49,90
- Refrigerante lata — R$ 6,00
- Borda recheada (catupiry) — R$ 12,00

HORÁRIO: 18h às 23h, todos os dias
TAXA DE ENTREGA: R$ 6,00
TEMPO MÉDIO: 35 a 45 minutos

Responda de forma curta, como em uma conversa real de WhatsApp/Instagram, sem parágrafos longos.`;

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
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: mensagemDoCliente }] }],
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro na API do Gemini:', JSON.stringify(data));
      return 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?';
    }

    const textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return textoResposta || 'Desculpa, não consegui entender. Pode reformular?';
  } catch (err) {
    console.error('Erro ao chamar a IA:', err);
    return 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?';
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
