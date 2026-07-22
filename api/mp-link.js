// api/mp-link.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Metodo nao permitido');
  const { negocio_id, senha, pacoteId, tipo } = req.body || {};
  const negocioId = negocio_id || 'default';
  if (!await validarSenha(negocioId, senha)) return res.status(401).json({ error: 'Senha invalida' });
  if (!pacoteId || !tipo) return res.status(400).json({ error: 'pacoteId e tipo obrigatorios' });
  const mpToken = process.env.MP_ACCESS_TOKEN;
  if (!mpToken) return res.status(500).json({ error: 'MP_ACCESS_TOKEN nao configurado' });
  try {
    const resultado = await redisCommand(['GET', 'pacote:' + pacoteId]);
    if (!resultado?.result) return res.status(404).json({ error: 'Pacote nao encontrado' });
    const pacote = JSON.parse(resultado.result);
    const preco = Number(pacote.preco || 0);
    const taxaMP = Number(pacote.taxaMP || 15.99);
    const parcelas = Number(pacote.parcelas || 10);
    const desconto = Number(pacote.descontoAvista || 0);
    const precoParcelado = Math.round(preco / (1 - taxaMP / 100) * 100) / 100;
    const precoVista = Math.round(preco * (1 - desconto / 100) * 100) / 100;
    const valor = tipo === 'pix' ? precoVista : precoParcelado;
    const titulo = (pacote.destino || 'Pacote') + (pacote.duracao ? ' - ' + pacote.duracao : '');
    const preference = {
      items: [{ title: titulo, quantity: 1, currency_id: 'BRL', unit_price: valor }],
      payment_methods: tipo === 'pix'
        ? { excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }, { id: 'ticket' }] }
        : { installments: parcelas, default_installments: parcelas },
      back_urls: {
        success: 'https://hubatendimento.com.br/pacote?id=' + pacoteId + '&status=sucesso',
        failure: 'https://hubatendimento.com.br/pacote?id=' + pacoteId + '&status=falha',
        pending: 'https://hubatendimento.com.br/pacote?id=' + pacoteId + '&status=pendente',
      },
      auto_return: 'approved',
      statement_descriptor: 'Vou Turistar',
    };
    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + mpToken },
      body: JSON.stringify(preference),
    });
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: 'Erro MP', detalhe: data });
    const link = data.init_point;
    const pacoteAtualizado = { ...pacote };
    if (tipo === 'pix') pacoteAtualizado.linkCheckoutPix = link;
    else pacoteAtualizado.linkCheckout = link;
    await redisCommand(['SET', 'pacote:' + pacoteId, JSON.stringify(pacoteAtualizado)]);
    return res.status(200).json({ ok: true, link, tipo });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
}
async function validarSenha(negocioId, senha) {
  if (!senha) return false;
  const r = await redisCommand(['GET', 'n:' + negocioId + ':senha']);
  if (r?.result) return r.result === senha;
  if (negocioId === 'default') return senha === process.env.PAINEL_SENHA;
  return false;
}
async function redisCommand(cmd) {
  const r = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.KV_REST_API_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}