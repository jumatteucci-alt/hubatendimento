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

  // 2. RECEBIMENTO DE MENSAGENS (a Meta chama isso via POST, a cada mensagem nova)
  if (req.method === 'POST') {
    const body = req.body;

    console.log('PAYLOAD COMPLETO RECEBIDO:', JSON.stringify(body));

    try {
      const entry = body.entry?.[0];

      // Formato real do Instagram: entry.changes[0].value
      const change = entry?.changes?.[0];
      const value = change?.value;

      // Mantemos compatibilidade com o formato entry.messaging[0], usado por outros produtos da Meta
      const messagingEvent = entry?.messaging?.[0];

      const senderId = value?.sender?.id || messagingEvent?.sender?.id;
      const userText = value?.message?.text || messagingEvent?.message?.text;

      if (senderId && userText) {
        console.log(`Mensagem recebida de ${senderId}: ${userText}`);
        await sendInstagramReply(senderId, `Recebi sua mensagem: "${userText}". Em breve um agente de IA vai responder isso automaticamente.`);
      } else {
        console.log('Nenhuma mensagem de texto encontrada nos formatos conhecidos.');
      }

      // A Meta exige resposta 200 rápida, senão ela reenvia o evento
      return res.status(200).send('EVENT_RECEIVED');
    } catch (err) {
      console.error('Erro ao processar webhook:', err);
      return res.status(200).send('EVENT_RECEIVED'); // sempre 200 pra Meta não reenviar em loop
    }
  }

  return res.status(405).send('Método não permitido');
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
