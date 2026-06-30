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

        const { replyText, pedidoFechado, leadCapturado, pedidoCancelado, tipoNegocio } = await processarMensagem(subscriberId, userText);

        if (leadCapturado) {
          await registrarOuAtualizarLead(subscriberId, leadCapturado, tipoNegocio);
          console.log('Lead registrado/atualizado:', JSON.stringify(leadCapturado));
        }

        if (pedidoFechado) {
          await confirmarCompraLead(subscriberId, pedidoFechado, tipoNegocio);
          console.log('Compra confirmada:', JSON.stringify(pedidoFechado));
        }

        if (pedidoCancelado) {
          await cancelarUltimoPedido(subscriberId);
          console.log(`Pedido cancelado para ${subscriberId}`);
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
- O campo "dataHoraISO" é OBRIGATÓRIO nesse bloco, no formato ISO 8601 com fuso de São Paulo (-03:00), pra conseguirmos lançar na agenda automaticamente. Calcule a data real com base em hoje, considerando o dia da semana mencionado pelo cliente
- Se ainda faltar alguma informação, NÃO inclua esse bloco, apenas continue perguntando
- Se o cliente pedir pra CANCELAR um agendamento já confirmado antes (você vai ver isso no histórico da conversa), responda confirmando o cancelamento de forma simpática, e ADICIONE no final da resposta este bloco, exatamente assim:
###CANCELAR###
- Se o cliente disser "cancelar" mas ainda não tinha confirmado nenhum agendamento na conversa, apenas confirme que não há nada pra cancelar, sem incluir nenhum bloco`;

const PROMPT_PRODUTO_DIGITAL = `Você é o atendente virtual de venda de um produto digital, via Instagram.

${PROMPT_COMUM}

REGRAS DA VENDA:
- Use o "TEXTO PERSUASIVO" abaixo como base para argumentar a favor do produto, adaptando ao que o cliente perguntar, sem simplesmente colar o texto inteiro de uma vez
- Não invente benefício, resultado, número, percentual ou garantia que não esteja literalmente escrito no texto persuasivo. Nunca arredonde, estime ou crie um exemplo numérico que não esteja lá
- Sempre conduza a conversa em direção à compra. Mesmo respondendo dúvidas, retome o argumento de venda e busque o fechamento, sem ser repetitivo ou insistente a ponto de incomodar
- Antes de mandar o link de checkout, você precisa coletar, um por um, exatamente os campos listados em "DADOS A COLETAR" abaixo. Não pule nenhum, e não peça nada além do que está nessa lista
- Se algum desses dados já for conhecido do cliente (informado em "DADOS JÁ CONHECIDOS DESTE CLIENTE"), não pergunte de novo, só confirme rapidamente
- Assim que você já souber pelo menos o nome e o telefone/WhatsApp do cliente (mesmo que outros campos da lista ainda faltem), ADICIONE no final da resposta este bloco, pra registrar o contato como lead, e continue normalmente coletando o que falta na mesma mensagem ou nas seguintes:
###LEAD###
{"itens":["nome do produto"],"total":0,"dados":{"Nome do campo 1":"valor informado","Nome do campo 2":"valor informado"}}
###FIM###
- Inclua o bloco ###LEAD### de novo sempre que coletar um dado novo do cliente, com todos os dados já conhecidos atualizados (não só o que faltava), pra manter o registro completo
- Quando TODOS os campos de "DADOS A COLETAR" já tiverem sido respondidos, envie o "LINK DE CHECKOUT" abaixo pro cliente, explicando que é por ali que ele finaliza a compra
- IMPORTANTE: você NUNCA pode dizer que a compra foi concluída ou confirmada, porque o pagamento acontece fora dessa conversa, no link de checkout, e só o cliente sabe se finalizou ou não
- Depois de mandar o link de checkout, em mensagens seguintes, pergunte se o cliente já concluiu a compra por ali
- Quando o cliente confirmar explicitamente que JÁ COMPROU (concluiu o pagamento no link), agradeça e ADICIONE no final da sua resposta um bloco assim, exatamente neste formato, sem nada antes ou depois dele:
###PEDIDO###
{"itens":["nome do produto"],"total":0,"dados":{"Nome do campo 1":"valor informado","Nome do campo 2":"valor informado"}}
###FIM###
- As chaves dentro de "dados" devem ser EXATAMENTE os nomes dos campos listados em "DADOS A COLETAR", e os valores são o que o cliente respondeu
- NUNCA inclua o bloco ###PEDIDO### antes do cliente confirmar explicitamente que concluiu a compra. Só coletar os dados e mandar o link não é suficiente pra isso, use ###LEAD### nesse caso
- Se o cliente pedir pra CANCELAR uma compra já confirmada antes (você vai ver isso no histórico da conversa), responda confirmando o cancelamento de forma simpática, e ADICIONE no final da resposta este bloco, exatamente assim:
###CANCELAR###
- Se o cliente disser "cancelar" mas ainda não tinha confirmado nenhuma compra na conversa, apenas confirme que não há nada pra cancelar, sem incluir nenhum bloco`;

// Cardápio/serviços e dados do negócio padrão, usados só enquanto o dono ainda não preencheu o cadastro
const NEGOCIO_PADRAO = {
  tipo: 'delivery', // 'delivery', 'agendamento' ou 'produto_digital'
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

function montarSystemPrompt(negocio, cliente, horariosOcupados, primeiraMensagem) {
  const tipo = negocio.tipo || 'delivery';
  const promptBase = tipo === 'agendamento'
    ? PROMPT_AGENDAMENTO
    : tipo === 'produto_digital'
    ? PROMPT_PRODUTO_DIGITAL
    : PROMPT_DELIVERY;

  const listaTexto = (negocio.itens || [])
    .map(i => `- ${i.nome} — R$ ${Number(i.preco).toFixed(2).replace('.', ',')}${i.descricao ? ' — ' + i.descricao : ''}`)
    .join('\n');

  let blocoCliente = '';
  if (cliente && tipo !== 'produto_digital') {
    const labelDado2 = tipo === 'agendamento' ? 'Data/horário mais comum' : 'Endereço';
    blocoCliente = `\n\nDADOS JÁ CONHECIDOS DESTE CLIENTE (de pedidos/compras anteriores, use pra agilizar, mas sempre confirme antes de fechar):
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
      blocoClienteDados = `\n\nDADOS JÁ CONHECIDOS DESTE CLIENTE (de compras anteriores, use pra agilizar, mas sempre confirme antes de fechar):\n${linhas}`;
    }

    const instrucaoPrimeiraMensagem = primeiraMensagem
      ? `\n\nESTA É A PRIMEIRA MENSAGEM DESSA CONVERSA. Sua resposta precisa:
1. Abrir com o gancho mais forte e específico do texto persuasivo (um resultado, número ou diferencial concreto QUE ESTEJA LITERALMENTE escrito no texto persuasivo, nunca invente ou arredonde pra cima)
2. Gerar curiosidade, sem entregar todos os detalhes de uma vez, fazendo o cliente querer saber mais
3. Terminar com uma pergunta curta que convide o cliente a continuar a conversa (ex: pergunte o que mais interessa a ele, ou o que ele já busca, NÃO uma pergunta genérica e morna como "o que mais você gostaria de saber?")
Responda a pergunta específica do cliente (se ele já tiver perguntado algo) só depois desse gancho inicial, não antes.
REGRA INVIOLÁVEL: todo número, resultado ou afirmação que você usar precisa estar literalmente presente no texto persuasivo abaixo. Se o texto persuasivo não tiver números concretos, não invente nenhum, use os diferenciais qualitativos que estiverem escritos lá.`
      : '';

    return `${promptBase}

PRODUTO: ${negocio.nomeProduto || negocio.nome || '(sem nome definido)'}
PREÇO: R$ ${Number(negocio.precoProduto || 0).toFixed(2).replace('.', ',')}

DESCRIÇÃO DA OFERTA:
${negocio.descricaoOferta || '(não preenchido)'}

TEXTO PERSUASIVO (use como base para os argumentos de venda):
${negocio.textoPersuasivo || '(não preenchido)'}

LINK DE CHECKOUT (envie esse link exato quando os dados já tiverem sido coletados):
${negocio.linkCheckout || '(não preenchido, avise no painel que falta cadastrar)'}

DADOS A COLETAR (peça exatamente estes, um a um, antes de mandar o link de checkout):
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

async function processarMensagem(subscriberId, mensagemDoCliente) {
  const [historico, negocio, cliente] = await Promise.all([
    buscarHistorico(subscriberId),
    buscarNegocio(),
    buscarCliente(subscriberId),
  ]);

  let horariosOcupados = [];
  if (negocio.tipo === 'agendamento') {
    horariosOcupados = await buscarHorariosOcupadosInterno();
  }

  const primeiraMensagem = historico.length === 0;
  const systemPrompt = montarSystemPrompt(negocio, cliente, horariosOcupados, primeiraMensagem);

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
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Erro na API do Gemini:', JSON.stringify(data));
      await registrarErroSistema(subscriberId, mensagemDoCliente, `Gemini retornou erro: ${JSON.stringify(data).slice(0, 200)}`);
      return { replyText: 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?', pedidoFechado: null, pedidoCancelado: false, chamarHumano: false, tipoNegocio: negocio.tipo || 'delivery' };
    }

    const textoCompleto = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Desculpa, não consegui entender. Pode reformular?';

    // Extrai o bloco de pedido, lead ou cancelamento, se existir, e limpa o texto antes de mandar pro cliente
    let replyText = textoCompleto;
    let pedidoFechado = null;
    let leadCapturado = null;
    let pedidoCancelado = false;

    const matchPedido = textoCompleto.match(/###PEDIDO###([\s\S]*?)###FIM###/);
    if (matchPedido) {
      try {
        pedidoFechado = JSON.parse(matchPedido[1].trim());
      } catch (e) {
        console.error('Não foi possível parsear o bloco de pedido:', matchPedido[1]);
      }
      replyText = replyText.replace(/###PEDIDO###[\s\S]*?###FIM###/, '').trim();
    }

    const matchLead = textoCompleto.match(/###LEAD###([\s\S]*?)###FIM###/);
    if (matchLead) {
      try {
        leadCapturado = JSON.parse(matchLead[1].trim());
      } catch (e) {
        console.error('Não foi possível parsear o bloco de lead:', matchLead[1]);
      }
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
      await registrarAlertaHumano(subscriberId, cliente?.nome, mensagemDoCliente);
    }

    // Atualiza o histórico (mensagem do cliente + resposta da IA, sem os blocos de controle) e salva
    const novoHistorico = [
      ...contents,
      { role: 'model', parts: [{ text: textoCompleto }] },
    ];
    await salvarHistorico(subscriberId, novoHistorico);

    return { replyText, pedidoFechado, leadCapturado, pedidoCancelado, chamarHumano, tipoNegocio: negocio.tipo || 'delivery' };
  } catch (err) {
    console.error('Erro ao chamar a IA:', err);
    await registrarErroSistema(subscriberId, mensagemDoCliente, err.message || String(err));
    return { replyText: 'Desculpa, tive um problema aqui pra processar sua mensagem. Pode repetir?', pedidoFechado: null, leadCapturado: null, pedidoCancelado: false, chamarHumano: false, tipoNegocio: 'delivery' };
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

function derivarNomeDeDados(dados) {
  if (!dados) return null;
  const chaveNome = Object.keys(dados).find(k => k.toLowerCase().includes('nome'));
  return chaveNome ? dados[chaveNome] : Object.values(dados)[0];
}

async function salvarPedido(subscriberId, pedido, tipo) {
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Pra produto digital, os dados vêm livres em "dados" (objeto). Derivamos um "nome" pra exibição.
    let nomeExibicao = pedido.nome;
    if (tipo === 'produto_digital' && pedido.dados) {
      nomeExibicao = derivarNomeDeDados(pedido.dados);
    }

    const registro = { ...pedido, nome: nomeExibicao, id, subscriberId, tipo: tipo || 'delivery', status: 'ativo', criadoEm: new Date().toISOString() };
    await redisCommand(['LPUSH', 'pedidos', JSON.stringify(registro)]);
    await salvarCliente(subscriberId, registro, tipo);
  } catch (err) {
    console.error('Erro ao salvar pedido:', err);
  }
}

// Cria ou atualiza um registro de lead (produto digital) enquanto a conversa ainda não fechou venda.
// Usa o mesmo subscriberId pra não duplicar registros a cada novo dado coletado.
async function registrarOuAtualizarLead(subscriberId, pedido, tipo) {
  try {
    const resultado = await redisCommand(['LRANGE', 'pedidos', '0', '199']);
    const lista = resultado?.result || [];

    for (let i = 0; i < lista.length; i++) {
      const registro = JSON.parse(lista[i]);
      if (registro.subscriberId === subscriberId && registro.tipo === tipo && !['finalizado', 'cancelado'].includes(registro.status)) {
        const dadosMesclados = { ...(registro.dados || {}), ...(pedido.dados || {}) };
        const atualizado = { ...registro, itens: pedido.itens || registro.itens, dados: dadosMesclados, nome: derivarNomeDeDados(dadosMesclados) || registro.nome };
        await redisCommand(['LSET', 'pedidos', String(i), JSON.stringify(atualizado)]);
        await salvarCliente(subscriberId, atualizado, tipo);
        return;
      }
    }

    // Não achou registro existente, cria um novo já como "lead"
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const registro = { ...pedido, nome: derivarNomeDeDados(pedido.dados), id, subscriberId, tipo, status: 'lead', criadoEm: new Date().toISOString() };
    await redisCommand(['LPUSH', 'pedidos', JSON.stringify(registro)]);
    await salvarCliente(subscriberId, registro, tipo);
  } catch (err) {
    console.error('Erro ao registrar lead:', err);
  }
}

// Promove um lead existente pra "venda confirmada" (status ativo), ou cria um registro novo se não achar lead prévio.
async function confirmarCompraLead(subscriberId, pedido, tipo) {
  if (tipo !== 'produto_digital') {
    return salvarPedido(subscriberId, pedido, tipo);
  }
  try {
    const resultado = await redisCommand(['LRANGE', 'pedidos', '0', '199']);
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
          status: 'ativo',
          compraConfirmadaEm: new Date().toISOString(),
        };
        await redisCommand(['LSET', 'pedidos', String(i), JSON.stringify(atualizado)]);
        await salvarCliente(subscriberId, atualizado, tipo);
        return;
      }
    }

    // Sem lead anterior (caso raro, cliente confirmou tudo numa mensagem só) — cria direto como venda confirmada
    await salvarPedido(subscriberId, pedido, tipo);
  } catch (err) {
    console.error('Erro ao confirmar compra:', err);
  }
}
  }
}

async function buscarCliente(subscriberId) {
  try {
    const resultado = await redisCommand(['GET', `cliente:${subscriberId}`]);
    return resultado?.result ? JSON.parse(resultado.result) : null;
  } catch (err) {
    console.error('Erro ao buscar cliente:', err);
    return null;
  }
}

async function salvarCliente(subscriberId, pedido, tipo) {
  try {
    const perfil = {
      nome: pedido.nome,
      endereco: pedido.endereco,
      pagamento: pedido.pagamento,
      dados: tipo === 'produto_digital' ? pedido.dados : undefined,
      atualizadoEm: new Date().toISOString(),
    };
    await redisCommand(['SET', `cliente:${subscriberId}`, JSON.stringify(perfil)]);
  } catch (err) {
    console.error('Erro ao salvar cliente:', err);
  }
}

async function buscarNegocio() {
  try {
    const resultado = await redisCommand(['GET', 'negocio:config']);
    return resultado?.result ? JSON.parse(resultado.result) : NEGOCIO_PADRAO;
  } catch (err) {
    console.error('Erro ao buscar negócio:', err);
    return NEGOCIO_PADRAO;
  }
}

async function registrarErroSistema(subscriberId, mensagem, detalhe) {
  try {
    const registro = { subscriberId, mensagem, detalhe, criadoEm: new Date().toISOString() };
    await redisCommand(['LPUSH', 'erros_sistema', JSON.stringify(registro)]);
    await redisCommand(['LTRIM', 'erros_sistema', '0', '19']); // mantém só os 20 mais recentes
  } catch (err) {
    console.error('Erro ao registrar erro do sistema:', err);
  }
}

async function registrarAlertaHumano(subscriberId, nomeConhecido, mensagem) {
  try {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const registro = { id, subscriberId, nome: nomeConhecido || null, mensagem, status: 'pendente', criadoEm: new Date().toISOString() };
    await redisCommand(['LPUSH', 'alertas_humano', JSON.stringify(registro)]);
  } catch (err) {
    console.error('Erro ao registrar alerta de humano:', err);
  }
}

// --- Disponibilidade de agenda, usando os próprios agendamentos salvos no sistema ---

async function buscarHorariosOcupadosInterno() {
  try {
    const resultado = await redisCommand(['LRANGE', 'pedidos', '0', '99']);
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
      const fim = new Date(p.inicio.getTime() + 60 * 60 * 1000); // considera 1h de duração
      const inicioTexto = p.inicio.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const fimTexto = fim.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      return `- ${inicioTexto} até ${fimTexto}`;
    });
  } catch (err) {
    console.error('Erro ao buscar horários ocupados:', err);
    return [];
  }
}

async function cancelarUltimoPedido(subscriberId) {
  try {
    const resultado = await redisCommand(['LRANGE', 'pedidos', '0', '99']);
    const lista = resultado?.result || [];

    for (let i = 0; i < lista.length; i++) {
      const pedido = JSON.parse(lista[i]);
      if (pedido.subscriberId === subscriberId && pedido.status === 'ativo') {
        pedido.status = 'cancelado';
        pedido.canceladoEm = new Date().toISOString();
        await redisCommand(['LSET', 'pedidos', String(i), JSON.stringify(pedido)]);
        return true;
      }
    }
    console.log(`Nenhum pedido ativo encontrado pra cancelar (subscriber ${subscriberId})`);
    return false;
  } catch (err) {
    console.error('Erro ao cancelar pedido:', err);
    return false;
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
