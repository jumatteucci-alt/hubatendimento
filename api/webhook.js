// api/webhook.js
// Endpoint que recebe mensagens do Instagram (via Meta) e responde automaticamente.
// Multi-tenant: cada negócio tem seu próprio negocio_id, que namespeia todos os dados no Redis.

export default async function handler(req, res) {
  // 1. VERIFICAÇÃO DO WEBHOOK (GET — Meta chama uma vez ao cadastrar a URL)
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

  // 2. RECEBIMENTO DE MENSAGENS (POST)
  if (req.method === 'POST') {
    const body = req.body;
    console.log('PAYLOAD COMPLETO RECEBIDO:', JSON.stringify(body));

    try {
      console.log('EVENT:', JSON.stringify(body.event), '| SOURCE:', body.source, '| HAS DATA:', !!body.data);

      // FORMATO EVOLUTION API (WhatsApp via Baileys)
      if (body.event === 'messages.upsert' && body.data) {
        const msg = body.data;

        // Ignora mensagens enviadas pelo próprio bot e mensagens de grupo
        if (msg.key?.fromMe) return res.status(200).send('OK');
        const remoteJid = msg.key?.remoteJid || '';
        if (remoteJid.endsWith('@g.us')) return res.status(200).send('OK');

        // Extrai o texto da mensagem no formato real do Evolution API
        const userText = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || '';

        if (!userText.trim()) return res.status(200).send('OK');

        const instanceName = body.instance || 'hubatendimento';
        const negocioId = await buscarNegocioPorInstancia(instanceName);
        const subscriberId = remoteJid;
        const nomeContato = msg.pushName || null;

        console.log(`[Evolution][${negocioId}] Mensagem de ${subscriberId} (${nomeContato}): ${userText}`);

        // Log do histórico pra diagnóstico
        const historicoDebug = await buscarHistorico(negocioId, subscriberId);
        console.log(`[Evolution] Histórico encontrado: ${historicoDebug.length} mensagens`);

        const pausado = await estaAtendimentoPausado(negocioId);
        if (pausado) {
          await sendWhatsAppReply(instanceName, subscriberId, 'Estamos temporariamente fora do ar. Em breve voltamos! 🙏');
          return res.status(200).send('OK');
        }

        const negocio = await buscarNegocio(negocioId);
        if (!verificarHorario(negocio)) {
          await sendWhatsAppReply(instanceName, subscriberId, montarMensagemFechado(negocio));
          return res.status(200).send('OK');
        }

        if (negocio.tipo === 'produto_digital') {
          await criarLeadInicialSeNaoExistir(negocioId, subscriberId, negocio);
        }

        const { replyText, pedidoFechado, leadCapturado, pedidoCancelado, tipoNegocio } =
          await processarMensagem(negocioId, subscriberId, userText, negocio);

        if (leadCapturado) await registrarOuAtualizarLead(negocioId, subscriberId, leadCapturado, tipoNegocio);
        if (pedidoFechado) await confirmarCompraLead(negocioId, subscriberId, pedidoFechado, tipoNegocio);
        if (pedidoCancelado) await cancelarUltimoPedido(negocioId, subscriberId);

        await sendWhatsAppReply(instanceName, subscriberId, replyText);
        return res.status(200).send('OK');
      }

      // FORMATO MANYCHAT
      if (body.source === 'manychat') {
        const userText     = body.text || '';
        const subscriberId = body.subscriber_id || 'desconhecido';
        const negocioId    = body.negocio_id || 'default';

        console.log(`[ManyChat][${negocioId}] Mensagem de ${subscriberId}: ${userText}`);

        // Enriquece o perfil do Instagram na primeira interação e cria lead inicial
        enriquecerPerfilInstagram(negocioId, subscriberId).catch(() => {});

        // Verifica se o negócio está pausado
        const pausado = await estaAtendimentoPausado(negocioId);
        if (pausado) {
          console.log(`[${negocioId}] Atendimento pausado — mensagem não processada`);
          return res.status(200).json({ reply: 'Estamos temporariamente fora do ar. Em breve voltamos ao atendimento! 🙏' });
        }

        // Verifica se está dentro do horário de funcionamento
        const negocio = await buscarNegocio(negocioId);
        if (!verificarHorario(negocio)) {
          console.log(`[${negocioId}] Fora do horário de funcionamento`);
          const msgFechado = montarMensagemFechado(negocio);
          return res.status(200).json({ reply: msgFechado });
        }

        // Se for produto digital e for a primeira mensagem, cria lead inicial com nome do Instagram
        if (negocio.tipo === 'produto_digital') {
          await criarLeadInicialSeNaoExistir(negocioId, subscriberId, negocio);
        }

        const { replyText, pedidoFechado, leadCapturado, pedidoCancelado, tipoNegocio } =
          await processarMensagem(negocioId, subscriberId, userText, negocio);

        if (leadCapturado) {
          await registrarOuAtualizarLead(negocioId, subscriberId, leadCapturado, tipoNegocio);
          console.log(`[${negocioId}] Lead registrado/atualizado`);
        }
        if (pedidoFechado) {
          await confirmarCompraLead(negocioId, subscriberId, pedidoFechado, tipoNegocio);
          console.log(`[${negocioId}] Compra confirmada`);
        }
        if (pedidoCancelado) {
          await cancelarUltimoPedido(negocioId, subscriberId);
          console.log(`[${negocioId}] Pedido cancelado para ${subscriberId}`);
        }

        return res.status(200).json({ reply: replyText });
      }

      // FORMATO META DIRETO (Instagram sem intermediário)
      // A Meta envia os eventos em dois formatos dependendo da versão da API:
      // 1. entry[0].messaging[0] (formato Messenger/Instagram antigo)
      // 2. entry[0].changes[0].value (formato Instagram Business atual)
      const entry = body.entry?.[0];
      const messagingEvent = entry?.messaging?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;

      // Extrai remetente e texto nos dois formatos
      const senderId = messagingEvent?.sender?.id || value?.sender?.id;
      const userText = messagingEvent?.message?.text || value?.message?.text;
      const isEcho = messagingEvent?.message?.is_echo || value?.message?.is_echo;

      // Ignora mensagens enviadas pelo próprio bot (echo)
      if (isEcho) {
        console.log('Echo ignorado');
        return res.status(200).send('EVENT_RECEIVED');
      }

      if (senderId && userText) {
        console.log(`[Meta Direto] Mensagem de ${senderId}: ${userText}`);

        // Usa o negocio_id configurado no ambiente, ou 'default'
        const negocioId = process.env.NEGOCIO_ID_DIRETO || 'default';

        // Verifica pausa e horário
        const pausado = await estaAtendimentoPausado(negocioId);
        if (pausado) {
          await sendInstagramReply(senderId, 'Estamos temporariamente fora do ar. Em breve voltamos! 🙏');
          return res.status(200).send('EVENT_RECEIVED');
        }

        const negocio = await buscarNegocio(negocioId);
        if (!verificarHorario(negocio)) {
          await sendInstagramReply(senderId, montarMensagemFechado(negocio));
          return res.status(200).send('EVENT_RECEIVED');
        }

        if (negocio.tipo === 'produto_digital') {
          await criarLeadInicialSeNaoExistir(negocioId, senderId, negocio);
        }

        const { replyText, pedidoFechado, leadCapturado, pedidoCancelado, tipoNegocio } =
          await processarMensagem(negocioId, senderId, userText, negocio);

        if (leadCapturado) await registrarOuAtualizarLead(negocioId, senderId, leadCapturado, tipoNegocio);
        if (pedidoFechado) await confirmarCompraLead(negocioId, senderId, pedidoFechado, tipoNegocio);
        if (pedidoCancelado) await cancelarUltimoPedido(negocioId, senderId);

        // Payload de teste da Meta usa IDs fictícios (12334/23245) — processa mas não tenta enviar
        const isTestPayload = senderId === '12334' || senderId === '23245';
        if (isTestPayload) {
          console.log(`[Meta Direto] Payload de teste detectado — resposta seria: "${replyText}"`);
        } else {
          await sendInstagramReply(senderId, replyText);
        }
      } else {
        console.log('[Meta Direto] Evento sem mensagem de texto (reação, sticker, etc) — ignorado');
      }

      return res.status(200).send('EVENT_RECEIVED');
    } catch (err) {
      console.error('Erro ao processar webhook:', err);
      return res.status(200).send('EVENT_RECEIVED');
    }
  }

  return res.status(405).send('Método não permitido');
}

// ─── Helpers de namespace ────────────────────────────────────────────────────

// Gera chave Redis com o negocio_id como prefixo
function ns(negocioId, chave) {
  return `n:${negocioId}:${chave}`;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const PROMPT_COMUM = `Seja direto e simpático, como um atendente real escreveria, sem formalidade excessiva.
Nunca invente serviço, item, preço ou prazo que não está listado abaixo.
Se o cliente pedir algo que não está na lista, diga que não tem e sugira algo parecido.
Responda de forma curta, como em uma conversa real de WhatsApp/Instagram, sem parágrafos longos.
Se o cliente pedir explicitamente pra falar com uma pessoa/humano/responsável, OU fizer uma pergunta fora do seu escopo (reclamação, negociação de preço fora do padrão, pedido muito específico que você não tem informação pra responder), diga que vai chamar o responsável pra continuar, e ADICIONE no final da resposta este bloco, exatamente assim:
###CHAMAR_HUMANO###`;

const PROMPT_DELIVERY = `Você é o atendente virtual de um negócio de delivery, via Instagram.

${PROMPT_COMUM}

REGRAS DO PEDIDO:
- Ao montar um pedido, sempre peça nome, endereço de entrega e forma de pagamento antes de confirmar
- Se você já souber o nome, endereço ou forma de pagamento do cliente (informado abaixo em "DADOS JÁ CONHECIDOS DESTE CLIENTE"), NÃO pergunte de novo, apenas confirme rapidamente (ex: "Vai pro mesmo endereço de sempre, Rua X?") antes de fechar o pedido
- Ofereça um item adicional (bebida ou acompanhamento) antes de fechar o pedido
- Quando o cliente já tiver dado todas as informações (itens, nome, endereço, pagamento) e confirmado o pedido, responda normalmente confirmando, e ADICIONE no final da sua resposta um bloco assim, exatamente neste formato, sem nada antes ou depois dele:
###PEDIDO###
{"itens":["nome do item"],"total":0,"nome":"Nome do cliente","endereco":"Endereço completo","pagamento":"forma de pagamento"}
###FIM###
- Se ainda faltar alguma informação, NÃO inclua esse bloco, apenas continue perguntando
- Se o cliente pedir o cardápio, responda listando os itens em texto mesmo, direto na conversa
- Se o cliente pedir pra CANCELAR um pedido que já foi confirmado antes (você vai ver isso no histórico da conversa), responda confirmando o cancelamento de forma simpática, e ADICIONE no final da resposta este bloco, exatamente assim:
###CANCELAR###
- Se o cliente disser "cancelar" mas ainda não tinha confirmado nenhum pedido na conversa, apenas confirme que não há nada pra cancelar, sem incluir nenhum bloco`;

const PROMPT_AGENDAMENTO = `Você é o atendente virtual de um profissional que presta serviços por agendamento, via Instagram.

${PROMPT_COMUM}

REGRAS DO AGENDAMENTO:
- Você recebe abaixo, em "HORÁRIOS JÁ OCUPADOS", a agenda real do profissional, e em "DIAS BLOQUEADOS", os dias em que ele não atende (folga, viagem, etc). NUNCA sugira ou aceite um horário que esteja ocupado, nem nenhum horário num dia bloqueado
- Se o cliente pedir um horário ocupado ou um dia bloqueado, diga que não está disponível e sugira 2-3 horários livres próximos, dentro do horário de atendimento
- Ao confirmar um agendamento, sempre peça nome, data/horário desejado e forma de pagamento (ou valor de sinal, se houver) antes de confirmar
- Se você já souber o nome ou forma de pagamento do cliente (informado abaixo em "DADOS JÁ CONHECIDOS DESTE CLIENTE"), NÃO pergunte de novo, apenas confirme rapidamente
- Considere a sessão com duração de 1 hora, salvo se a descrição do serviço indicar outra duração
- Quando o cliente já tiver escolhido o serviço, dado nome, data/horário desejado (livre na agenda) e forma de pagamento, responda confirmando o agendamento, e ADICIONE no final da sua resposta um bloco assim, exatamente neste formato, sem nada antes ou depois dele:
###PEDIDO###
{"itens":["nome do serviço"],"total":0,"nome":"Nome do cliente","endereco":"Descrição legível da data/horário, ex: terça-feira 10/07 às 14h","dataHoraISO":"2026-07-10T14:00:00-03:00","pagamento":"forma de pagamento ou sinal"}
###FIM###
- O campo "dataHoraISO" é OBRIGATÓRIO nesse bloco, no formato ISO 8601 com fuso de São Paulo (-03:00)
- Se ainda faltar alguma informação, NÃO inclua esse bloco, apenas continue perguntando
- Se o cliente pedir pra CANCELAR um agendamento já confirmado antes, responda confirmando o cancelamento de forma simpática, e ADICIONE no final da resposta este bloco, exatamente assim:
###CANCELAR###
- Se o cliente disser "cancelar" mas ainda não tinha confirmado nenhum agendamento na conversa, apenas confirme que não há nada pra cancelar, sem incluir nenhum bloco`;

const PROMPT_PRODUTO_DIGITAL = `Você é o atendente virtual de venda de um produto ou serviço, via Instagram.

${PROMPT_COMUM}

REGRAS SOBRE O PREÇO:
- O preço informado em "PREÇO" é sempre o valor de referência (preço cheio parcelado). Sempre apresente como "a partir de R$ X" pois o valor final pode variar conforme as datas, condições ou opções escolhidas pelo cliente
- Se houver desconto à vista, mencione como uma vantagem adicional, não como o preço principal

REGRAS DE MENSAGEM DE ENTRADA (anúncio):
- Se a primeira mensagem do cliente contiver palavras-chave como "pacote", "quero saber mais", "interesse", "anúncio", ou mencionar diretamente o nome do produto, entenda que ele veio de um anúncio e já inicie apresentando o produto diretamente, sem perguntar "como posso ajudar?"

REGRAS DA VENDA:
- Use o "TEXTO PERSUASIVO" abaixo como base para argumentar a favor do produto, adaptando ao que o cliente perguntar, sem simplesmente colar o texto inteiro de uma vez
- Não invente benefício, resultado, número, percentual ou garantia que não esteja literalmente escrito no texto persuasivo. Nunca arredonde, estime ou crie um exemplo numérico que não esteja lá
- Sempre conduza a conversa em direção ao interesse do cliente. Mesmo respondendo dúvidas, retome o argumento de venda e busque o fechamento
- Se o cliente demonstrar hesitação, frieza ou disser que "não quer no momento", "vai pensar" ou algo parecido, NÃO desista imediatamente. Tente reverter UMA vez com um argumento genuíno e específico (ex: destacar um benefício que ele ainda não considerou, mencionar que as datas disponíveis são limitadas, ou reforçar o custo-benefício). Só encerre cordialmente se ele insistir na recusa após essa tentativa
- Quando relevante, mencione que Buenos Aires é uma das cidades mais vibrantes e acessíveis da América do Sul, com gastronomia, tango, arquitetura europeia e vida noturna — use isso como argumento de desejo, não apenas como descrição
- Se o cliente perguntar sobre meses disponíveis ou quando pode viajar, consulte a lista em "MESES DISPONÍVEIS" abaixo e responda com base nela
- Você precisa coletar, um por um, exatamente os campos listados em "DADOS A COLETAR" abaixo. Não pule nenhum, e não peça nada além do que está nessa lista
- Se algum desses dados já for conhecido do cliente (informado em "DADOS JÁ CONHECIDOS DESTE CLIENTE"), não pergunte de novo, só confirme rapidamente
- Assim que o cliente fornecer QUALQUER dado da lista "DADOS A COLETAR" (mesmo que seja só o primeiro campo), ADICIONE no final da resposta este bloco pra registrar o contato, e continue coletando os demais campos normalmente:
###LEAD###
{"itens":["nome do produto"],"total":0,"dados":{"Nome do campo que já foi respondido":"valor informado"}}
###FIM###
- Inclua o bloco ###LEAD### de novo sempre que coletar mais um dado, com TODOS os dados já conhecidos atualizados, não só o que acabou de coletar

REGRAS DE FINALIZAÇÃO (sem checkout online):
- Quando TODOS os campos de "DADOS A COLETAR" já tiverem sido respondidos, NÃO mande nenhum link de pagamento. Em vez disso, agradeça pelo interesse, diga que o responsável vai entrar em contato pelo WhatsApp informado para finalizar tudo, e encerre a conversa de forma calorosa
- NUNCA diga que a compra foi concluída ou confirmada, pois o fechamento acontece fora dessa conversa, pelo responsável
- Se o cliente pedir pra CANCELAR ou desistir antes de o responsável entrar em contato, responda de forma simpática dizendo que tudo bem e que não há nada confirmado ainda
- Se o cliente disser "cancelar" mas ainda não tinha fornecido nenhum dado, apenas confirme que não há nada a cancelar, sem incluir nenhum bloco`;

// ─── Negócio padrão (fallback enquanto não há cadastro) ─────────────────────

const NEGOCIO_PADRAO = {
  tipo: 'delivery',
  nome: 'Delivery',
  horario: '18h às 23h, todos os dias',
  taxaEntrega: 6.0,
  tempoMedio: '35 a 45 minutos',
  camposColeta: ['Nome completo', 'E-mail', 'Forma de pagamento'],
  itens: [
    { nome: 'Pizza grande de calabresa', preco: 54.9, descricao: '' },
    { nome: 'Pizza grande de mussarela', preco: 49.9, descricao: '' },
    { nome: 'Refrigerante lata', preco: 6.0, descricao: '' },
    { nome: 'Borda recheada (catupiry)', preco: 12.0, descricao: '' },
  ],
};

// ─── Montagem do prompt ──────────────────────────────────────────────────────

function montarSystemPrompt(negocio, cliente, horariosOcupados, primeiraMensagem) {
  const tipo = negocio.tipo || 'delivery';
  const promptBase = tipo === 'agendamento'
    ? PROMPT_AGENDAMENTO
    : tipo === 'produto_digital'
    ? PROMPT_PRODUTO_DIGITAL
    : PROMPT_DELIVERY;

  const listaTexto = (negocio.itens || [])
    .map(i => {
      const esgotado = i.disponivel === false ? ' — ⚠️ ESGOTADO (não ofereça este item)' : '';
      return `- ${i.nome} — R$ ${Number(i.preco).toFixed(2).replace('.', ',')}${i.descricao ? ' — ' + i.descricao : ''}${esgotado}`;
    })
    .join('\n');

  let blocoCliente = '';
  if (cliente && tipo !== 'produto_digital') {
    const labelDado2 = tipo === 'agendamento' ? 'Data/horário mais comum' : 'Endereço';
    blocoCliente = `\n\nDADOS JÁ CONHECIDOS DESTE CLIENTE:
- Nome: ${cliente.nome || 'desconhecido'}
- ${labelDado2}: ${cliente.endereco || 'desconhecido'}
- Forma de pagamento mais usada: ${cliente.pagamento || 'desconhecida'}`;
  }

  if (tipo === 'produto_digital') {
    const camposTexto = (negocio.camposColeta && negocio.camposColeta.length)
      ? negocio.camposColeta.map(c => `- ${c}`).join('\n')
      : '- Nome completo\n- E-mail\n- Forma de pagamento';

    let blocoClienteDados = '';
    if (cliente && cliente.dados && Object.keys(cliente.dados).length) {
      const linhas = Object.entries(cliente.dados).map(([k, v]) => `- ${k}: ${v}`).join('\n');
      blocoClienteDados = `\n\nDADOS JÁ CONHECIDOS DESTE CLIENTE:\n${linhas}`;
    }

    const instrucaoPrimeiraMensagem = primeiraMensagem
      ? `\n\nESTA É A PRIMEIRA MENSAGEM DESSA CONVERSA. Sua resposta precisa:
1. Abrir com o gancho mais forte e específico do texto persuasivo (um resultado, número ou diferencial concreto QUE ESTEJA LITERALMENTE escrito no texto persuasivo, nunca invente ou arredonde pra cima)
2. Gerar curiosidade, sem entregar todos os detalhes de uma vez, fazendo o cliente querer saber mais
3. Terminar com uma pergunta curta que convide o cliente a continuar a conversa (NÃO uma pergunta genérica e morna como "o que mais você gostaria de saber?")
REGRA INVIOLÁVEL: todo número, resultado ou afirmação que você usar precisa estar literalmente presente no texto persuasivo abaixo.`
      : '';

    const mesesTexto = (negocio.mesesDisponiveis && negocio.mesesDisponiveis.length)
      ? negocio.mesesDisponiveis.join(', ')
      : '(sem restrição de mês — datas flexíveis o ano todo)';

    const precoFormatado = `a partir de R$ ${Number(negocio.precoProduto || 0).toFixed(2).replace('.', ',')}`;
    const descontoAvista = negocio.descontoAvista
      ? `\nDESCONTO À VISTA: ${negocio.descontoAvista}% de desconto — valor à vista: R$ ${(Number(negocio.precoProduto || 0) * (1 - Number(negocio.descontoAvista) / 100)).toFixed(2).replace('.', ',')}`
      : '';

    return `${promptBase}

PRODUTO: ${negocio.nomeProduto || negocio.nome || '(sem nome definido)'}
PREÇO: ${precoFormatado}${descontoAvista}

DESCRIÇÃO DA OFERTA:
${negocio.descricaoOferta || '(não preenchido)'}

TEXTO PERSUASIVO (use como base para os argumentos de venda):
${negocio.textoPersuasivo || '(não preenchido)'}

MESES DISPONÍVEIS PARA O PACOTE:
${mesesTexto}

DADOS A COLETAR (peça exatamente estes, um a um, antes de encaminhar o interessado para o responsável):
${camposTexto}${blocoClienteDados}${instrucaoPrimeiraMensagem}`;
  }

  if (tipo === 'agendamento') {
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const ocupadosTexto = horariosOcupados && horariosOcupados.length
      ? horariosOcupados.join('\n')
      : '(nenhum horário ocupado encontrado)';
    const bloqueadosTexto = negocio.diasBloqueados && negocio.diasBloqueados.length
      ? negocio.diasBloqueados.map(d => `- ${new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit' })}`).join('\n')
      : '(nenhum dia bloqueado)';

    return `${promptBase}

HOJE É: ${hoje}

SERVIÇOS (${negocio.nome}):
${listaTexto}

HORÁRIO DE ATENDIMENTO: ${negocio.horario}

HORÁRIOS JÁ OCUPADOS (próximos 14 dias):
${ocupadosTexto}

DIAS BLOQUEADOS (não atende nesses dias):
${bloqueadosTexto}${blocoCliente}`;
  }

  return `${promptBase}

CARDÁPIO (${negocio.nome}):
${listaTexto}

HORÁRIO: ${negocio.horario}
TAXA DE ENTREGA: R$ ${Number(negocio.taxaEntrega).toFixed(2).replace('.', ',')}
TEMPO MÉDIO: ${negocio.tempoMedio}${blocoCliente}`;
}

// ─── Horário de funcionamento e pausa ────────────────────────────────────────

async function estaAtendimentoPausado(negocioId) {
  try {
    const resultado = await redisCommand(['GET', ns(negocioId, 'pausado')]);
    return resultado?.result === '1';
  } catch (err) {
    return false;
  }
}

function verificarHorario(negocio) {
  // Se não tiver horário estruturado configurado, considera sempre aberto
  if (!negocio.abreAs || !negocio.fechaAs) return true;

  const agora = new Date();
  const agoraSP = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = agoraSP.getDay(); // 0=Dom, 1=Seg...
  const horaAtual = agoraSP.getHours() * 60 + agoraSP.getMinutes();

  const [abreH, abreM] = negocio.abreAs.split(':').map(Number);
  const [fechaH, fechaM] = negocio.fechaAs.split(':').map(Number);
  const abreMin  = abreH * 60 + abreM;
  const fechaMin = fechaH * 60 + fechaM;

  // diasAbertos: array de números 0-6. Se não configurado, todos os dias
  const diasAbertos = (negocio.diasAbertos && negocio.diasAbertos.length)
    ? negocio.diasAbertos.map(Number)
    : [0, 1, 2, 3, 4, 5, 6];

  return diasAbertos.includes(diaSemana) && horaAtual >= abreMin && horaAtual < fechaMin;
}

function montarMensagemFechado(negocio) {
  const horario = negocio.horario || 'confira nosso horário nas redes sociais';
  return `Olá! No momento estamos fechados. 😴 Nosso horário de atendimento é: ${horario}. Quando abrirmos, é só mandar mensagem!`;
}

// ─── Processamento da mensagem ───────────────────────────────────────────────

async function processarMensagem(negocioId, subscriberId, mensagemDoCliente, negocioPreCarregado) {
  const [historico, cliente] = await Promise.all([
    buscarHistorico(negocioId, subscriberId),
    buscarCliente(negocioId, subscriberId),
  ]);

  // Usa o negócio já carregado se veio do handler (evita busca dupla)
  const negocio = negocioPreCarregado || await buscarNegocio(negocioId);

  let horariosOcupados = [];
  if (negocio.tipo === 'agendamento') {
    horariosOcupados = await buscarHorariosOcupadosInterno(negocioId);
  }

  const primeiraMensagem = historico.length === 0;
  const systemPrompt = montarSystemPrompt(negocio, cliente, horariosOcupados, primeiraMensagem);

  const contents = [
    ...historico,
    { role: 'user', parts: [{ text: mensagemDoCliente }] },
  ];

  try {
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro na API do Gemini:', JSON.stringify(data));
      await registrarErroSistema(negocioId, subscriberId, mensagemDoCliente, `Gemini: ${JSON.stringify(data).slice(0, 200)}`);
      return { replyText: 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?', pedidoFechado: null, leadCapturado: null, pedidoCancelado: false, chamarHumano: false, tipoNegocio: negocio.tipo || 'delivery' };
    }

    const textoCompleto = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Desculpa, não consegui entender. Pode reformular?';

    let replyText = textoCompleto;
    let pedidoFechado = null;
    let leadCapturado = null;
    let pedidoCancelado = false;

    const matchPedido = textoCompleto.match(/###PEDIDO###([\s\S]*?)###FIM###/);
    if (matchPedido) {
      try { pedidoFechado = JSON.parse(matchPedido[1].trim()); } catch (e) { console.error('Parse pedido falhou'); }
      replyText = replyText.replace(/###PEDIDO###[\s\S]*?###FIM###/, '').trim();
    }

    const matchLead = textoCompleto.match(/###LEAD###([\s\S]*?)###FIM###/);
    if (matchLead) {
      try { leadCapturado = JSON.parse(matchLead[1].trim()); } catch (e) { console.error('Parse lead falhou'); }
      replyText = replyText.replace(/###LEAD###[\s\S]*?###FIM###/, '').trim();
    }

    if (textoCompleto.includes('###CANCELAR###')) {
      pedidoCancelado = true;
      replyText = replyText.replace('###CANCELAR###', '').trim();
    }

    let chamarHumano = false;
    if (textoCompleto.includes('###CHAMAR_HUMANO###')) {
      chamarHumano = true;
      replyText = replyText.replace('###CHAMAR_HUMANO###', '').trim();
      await registrarAlertaHumano(negocioId, subscriberId, cliente?.nome, mensagemDoCliente);
    }

    const novoHistorico = [...contents, { role: 'model', parts: [{ text: textoCompleto }] }];
    await salvarHistorico(negocioId, subscriberId, novoHistorico);

    return { replyText, pedidoFechado, leadCapturado, pedidoCancelado, chamarHumano, tipoNegocio: negocio.tipo || 'delivery' };
  } catch (err) {
    console.error('Erro ao chamar a IA:', err);
    await registrarErroSistema(negocioId, subscriberId, mensagemDoCliente, err.message || String(err));
    return { replyText: 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?', pedidoFechado: null, leadCapturado: null, pedidoCancelado: false, chamarHumano: false, tipoNegocio: 'delivery' };
  }
}

// ─── Redis ───────────────────────────────────────────────────────────────────

async function redisCommand(comando) {
  const response = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando),
  });
  return response.json();
}

// ─── Histórico ───────────────────────────────────────────────────────────────

async function buscarHistorico(negocioId, subscriberId) {
  try {
    const resultado = await redisCommand(['GET', ns(negocioId, `historico:${subscriberId}`)]);
    if (resultado?.result) return JSON.parse(resultado.result);
    // Retrocompatibilidade: tenta a chave antiga (sem namespace)
    const legado = await redisCommand(['GET', `historico:${subscriberId}`]);
    return legado?.result ? JSON.parse(legado.result) : [];
  } catch (err) {
    console.error('Erro ao buscar histórico:', err);
    return [];
  }
}

async function salvarHistorico(negocioId, subscriberId, historico) {
  try {
    const recortado = historico.slice(-20);
    await redisCommand(['SET', ns(negocioId, `historico:${subscriberId}`), JSON.stringify(recortado)]);
  } catch (err) {
    console.error('Erro ao salvar histórico:', err);
  }
}

// ─── Negócio ─────────────────────────────────────────────────────────────────

async function buscarNegocio(negocioId) {
  try {
    const resultado = await redisCommand(['GET', ns(negocioId, 'config')]);
    if (resultado?.result) return JSON.parse(resultado.result);
    // Retrocompatibilidade: chave antiga
    const legado = await redisCommand(['GET', 'negocio:config']);
    return legado?.result ? JSON.parse(legado.result) : NEGOCIO_PADRAO;
  } catch (err) {
    console.error('Erro ao buscar negócio:', err);
    return NEGOCIO_PADRAO;
  }
}

// ─── Cliente ─────────────────────────────────────────────────────────────────

async function buscarCliente(negocioId, subscriberId) {
  try {
    const resultado = await redisCommand(['GET', ns(negocioId, `cliente:${subscriberId}`)]);
    if (resultado?.result) return JSON.parse(resultado.result);
    const legado = await redisCommand(['GET', `cliente:${subscriberId}`]);
    return legado?.result ? JSON.parse(legado.result) : null;
  } catch (err) {
    console.error('Erro ao buscar cliente:', err);
    return null;
  }
}

async function salvarCliente(negocioId, subscriberId, pedido, tipo) {
  try {
    // Busca o perfil existente pra preservar dados do Instagram já salvos
    const perfilExistente = await buscarCliente(negocioId, subscriberId);
    const perfil = {
      ...perfilExistente,
      nome: pedido.nome,
      endereco: pedido.endereco,
      pagamento: pedido.pagamento,
      dados: tipo === 'produto_digital' ? pedido.dados : undefined,
      atualizadoEm: new Date().toISOString(),
    };
    await redisCommand(['SET', ns(negocioId, `cliente:${subscriberId}`), JSON.stringify(perfil)]);
  } catch (err) {
    console.error('Erro ao salvar cliente:', err);
  }
}

// Cria um lead inicial na primeira interação de produto digital,
// usando o nome do Instagram que já buscamos via ManyChat
async function criarLeadInicialSeNaoExistir(negocioId, subscriberId, negocio) {
  try {
    const chave = ns(negocioId, 'pedidos');
    const resultado = await redisCommand(['LRANGE', chave, '0', '99']);
    const lista = resultado?.result || [];

    // Verifica se já existe algum registro pra esse subscriber
    const jaExiste = lista.some(b => {
      const p = JSON.parse(b);
      return p.subscriberId === subscriberId && !['finalizado', 'cancelado'].includes(p.status);
    });
    if (jaExiste) return;

    // Busca o nome do Instagram (pode já estar salvo se enriquecerPerfilInstagram rodou)
    const perfil = await buscarCliente(negocioId, subscriberId);
    const nomeInstagram = perfil?.instagramNome || perfil?.instagramUsername || null;
    if (!nomeInstagram) return; // sem nome ainda, tenta de novo na próxima mensagem

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const registro = {
      id,
      subscriberId,
      tipo: 'produto_digital',
      status: 'lead_inicial',
      nome: nomeInstagram,
      itens: [negocio.nomeProduto || negocio.nome || 'Produto digital'],
      dados: { 'Nome Instagram': nomeInstagram },
      criadoEm: new Date().toISOString(),
    };
    await redisCommand(['LPUSH', chave, JSON.stringify(registro)]);
    console.log(`[${negocioId}] Lead inicial criado para ${subscriberId} (${nomeInstagram})`);
  } catch (err) {
    console.error('Erro ao criar lead inicial:', err);
  }
}
async function enriquecerPerfilInstagram(negocioId, subscriberId) {
  try {
    // Verifica se já tem perfil do Instagram salvo pra não buscar toda vez
    const perfilAtual = await buscarCliente(negocioId, subscriberId);
    if (perfilAtual?.instagramUsername) return; // já enriquecido

    const response = await fetch(
      `https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${subscriberId}`,
      { headers: { Authorization: `Bearer ${process.env.MANYCHAT_API_TOKEN}` } }
    );
    if (!response.ok) return;

    const data = await response.json();
    const sub = data.data;
    if (!sub) return;

    const perfilInstagram = {
      instagramUsername: sub.key || null,
      instagramNome: sub.name || null,
      instagramFoto: sub.profile_pic || null,
    };

    // Mescla com o que já existe no perfil
    const perfilMesclado = { ...(perfilAtual || {}), ...perfilInstagram, atualizadoEm: new Date().toISOString() };
    await redisCommand(['SET', ns(negocioId, `cliente:${subscriberId}`), JSON.stringify(perfilMesclado)]);
  } catch (err) {
    console.error('Erro ao enriquecer perfil do Instagram:', err);
  }
}

// ─── Pedidos ─────────────────────────────────────────────────────────────────

function derivarNomeDeDados(dados) {
  if (!dados) return null;
  const chaveNome = Object.keys(dados).find(k => k.toLowerCase().includes('nome'));
  return chaveNome ? dados[chaveNome] : Object.values(dados)[0];
}

async function salvarPedido(negocioId, subscriberId, pedido, tipo) {
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let nomeExibicao = pedido.nome;
    if (tipo === 'produto_digital' && pedido.dados) nomeExibicao = derivarNomeDeDados(pedido.dados);

    // Captura o snapshot da conversa no momento em que o pedido é fechado
    const historico = await buscarHistorico(negocioId, subscriberId);

    const registro = {
      ...pedido,
      nome: nomeExibicao,
      id,
      subscriberId,
      tipo: tipo || 'delivery',
      status: 'ativo',
      criadoEm: new Date().toISOString(),
      conversaSnapshot: historico,
    };
    await redisCommand(['LPUSH', ns(negocioId, 'pedidos'), JSON.stringify(registro)]);
    await salvarCliente(negocioId, subscriberId, registro, tipo);
  } catch (err) {
    console.error('Erro ao salvar pedido:', err);
  }
}

async function registrarOuAtualizarLead(negocioId, subscriberId, pedido, tipo) {
  try {
    const chave = ns(negocioId, 'pedidos');
    const resultado = await redisCommand(['LRANGE', chave, '0', '199']);
    const lista = resultado?.result || [];

    for (let i = 0; i < lista.length; i++) {
      const registro = JSON.parse(lista[i]);
      if (registro.subscriberId === subscriberId && registro.tipo === tipo && !['finalizado', 'cancelado'].includes(registro.status)) {
        const dadosMesclados = { ...(registro.dados || {}), ...(pedido.dados || {}) };
        const atualizado = {
          ...registro,
          itens: pedido.itens || registro.itens,
          dados: dadosMesclados,
          nome: derivarNomeDeDados(dadosMesclados) || registro.nome,
          // Faz upgrade de lead_inicial pra lead assim que chegar dado via conversa
          status: registro.status === 'lead_inicial' ? 'lead' : registro.status,
        };
        await redisCommand(['LSET', chave, String(i), JSON.stringify(atualizado)]);
        await salvarCliente(negocioId, subscriberId, atualizado, tipo);
        return;
      }
    }

    // Não achou registro, cria novo como lead
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const historico = await buscarHistorico(negocioId, subscriberId);
    const registro = { ...pedido, nome: derivarNomeDeDados(pedido.dados), id, subscriberId, tipo, status: 'lead', criadoEm: new Date().toISOString(), conversaSnapshot: historico };
    await redisCommand(['LPUSH', chave, JSON.stringify(registro)]);
    await salvarCliente(negocioId, subscriberId, registro, tipo);
  } catch (err) {
    console.error('Erro ao registrar lead:', err);
  }
}

async function confirmarCompraLead(negocioId, subscriberId, pedido, tipo) {
  if (tipo !== 'produto_digital') return salvarPedido(negocioId, subscriberId, pedido, tipo);
  try {
    const chave = ns(negocioId, 'pedidos');
    const resultado = await redisCommand(['LRANGE', chave, '0', '199']);
    const lista = resultado?.result || [];

    for (let i = 0; i < lista.length; i++) {
      const registro = JSON.parse(lista[i]);
      if (registro.subscriberId === subscriberId && registro.tipo === tipo && !['finalizado', 'cancelado'].includes(registro.status)) {
        const dadosMesclados = { ...(registro.dados || {}), ...(pedido.dados || {}) };
        const historicoAtual = await buscarHistorico(negocioId, subscriberId);
        const atualizado = { ...registro, itens: pedido.itens || registro.itens, dados: dadosMesclados, nome: derivarNomeDeDados(dadosMesclados) || registro.nome, status: 'ativo', compraConfirmadaEm: new Date().toISOString(), conversaSnapshot: historicoAtual };
        await redisCommand(['LSET', chave, String(i), JSON.stringify(atualizado)]);
        await salvarCliente(negocioId, subscriberId, atualizado, tipo);
        return;
      }
    }
    await salvarPedido(negocioId, subscriberId, pedido, tipo);
  } catch (err) {
    console.error('Erro ao confirmar compra:', err);
  }
}

async function cancelarUltimoPedido(negocioId, subscriberId) {
  try {
    const chave = ns(negocioId, 'pedidos');
    const resultado = await redisCommand(['LRANGE', chave, '0', '99']);
    const lista = resultado?.result || [];

    for (let i = 0; i < lista.length; i++) {
      const pedido = JSON.parse(lista[i]);
      if (pedido.subscriberId === subscriberId && pedido.status === 'ativo') {
        pedido.status = 'cancelado';
        pedido.canceladoEm = new Date().toISOString();
        await redisCommand(['LSET', chave, String(i), JSON.stringify(pedido)]);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('Erro ao cancelar pedido:', err);
    return false;
  }
}

// ─── Agenda / horários ───────────────────────────────────────────────────────

async function buscarHorariosOcupadosInterno(negocioId) {
  try {
    const resultado = await redisCommand(['LRANGE', ns(negocioId, 'pedidos'), '0', '99']);
    const lista = resultado?.result || [];
    const agora = Date.now();
    const em14dias = agora + 14 * 24 * 60 * 60 * 1000;

    const ocupados = lista
      .map(item => JSON.parse(item))
      .filter(p => p.tipo === 'agendamento' && p.dataHoraISO && ['ativo', 'em_entrega'].includes(p.status))
      .map(p => ({ inicio: new Date(p.dataHoraISO), nome: p.nome }))
      .filter(p => p.inicio.getTime() >= agora && p.inicio.getTime() <= em14dias)
      .sort((a, b) => a.inicio - b.inicio);

    return ocupados.map(p => {
      const fim = new Date(p.inicio.getTime() + 60 * 60 * 1000);
      const inicioTexto = p.inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const fimTexto = fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      return `- ${inicioTexto} até ${fimTexto}`;
    });
  } catch (err) {
    console.error('Erro ao buscar horários ocupados:', err);
    return [];
  }
}

// ─── Alertas e erros ─────────────────────────────────────────────────────────

async function registrarErroSistema(negocioId, subscriberId, mensagem, detalhe) {
  try {
    const registro = { subscriberId, mensagem, detalhe, criadoEm: new Date().toISOString() };
    const chave = ns(negocioId, 'erros_sistema');
    await redisCommand(['LPUSH', chave, JSON.stringify(registro)]);
    await redisCommand(['LTRIM', chave, '0', '19']);
  } catch (err) {
    console.error('Erro ao registrar erro do sistema:', err);
  }
}

async function registrarAlertaHumano(negocioId, subscriberId, nomeConhecido, mensagem) {
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const registro = { id, subscriberId, nome: nomeConhecido || null, mensagem, status: 'pendente', criadoEm: new Date().toISOString() };
    await redisCommand(['LPUSH', ns(negocioId, 'alertas_humano'), JSON.stringify(registro)]);
  } catch (err) {
    console.error('Erro ao registrar alerta de humano:', err);
  }
}

// ─── WhatsApp via Evolution API ──────────────────────────────────────────────

async function buscarNegocioPorInstancia(instanceName) {
  try {
    // Busca o negocio_id mapeado pra essa instância do Evolution
    const resultado = await redisCommand(['GET', `evolution:instancia:${instanceName}`]);
    return resultado?.result || 'default';
  } catch (err) {
    return 'default';
  }
}

async function sendWhatsAppReply(instanceName, remoteJid, text) {
  try {
    const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${instanceName}`;
    console.log(`[Evolution] Enviando pra ${remoteJid}: "${text.slice(0, 50)}..."`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.EVOLUTION_API_KEY,
      },
      body: JSON.stringify({
        number: remoteJid,
        text,
      }),
    });
    const resultado = await response.text();
    if (!response.ok) {
      console.error('Erro ao enviar mensagem WhatsApp:', resultado);
    } else {
      console.log('[Evolution] Mensagem enviada com sucesso:', resultado.slice(0, 100));
    }
  } catch (err) {
    console.error('Erro ao enviar mensagem WhatsApp:', err);
  }
}

// ─── Instagram ───────────────────────────────────────────────────────────────

async function obterTokenInstagram() {
  try {
    // Lê o token do Redis (renovado automaticamente), com fallback pro env var
    const resultado = await redisCommand(['GET', 'ig_access_token']);
    return resultado?.result || process.env.IG_ACCESS_TOKEN;
  } catch (err) {
    return process.env.IG_ACCESS_TOKEN;
  }
}

async function sendInstagramReply(recipientId, text) {
  const token = await obterTokenInstagram();
  const url = `https://graph.instagram.com/v21.0/me/messages?access_token=${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
  });
  if (!response.ok) {
    console.error('Erro ao enviar resposta pro Instagram:', await response.text());
  }
}
