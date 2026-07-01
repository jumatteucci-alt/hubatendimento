// api/relatorios.js
// Retorna dados agregados de pedidos para o painel de relatórios.

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Método não permitido');

  const { negocio_id, senha } = req.query;
  const negocioId = negocio_id || 'default';

  const senhaValida = await validarSenha(negocioId, senha);
  if (!senhaValida) return res.status(401).json({ error: 'Senha inválida' });

  try {
    const chave = `n:${negocioId}:pedidos`;
    const brutos = (await redisCommand(['LRANGE', chave, '0', '499']))?.result || [];
    const todos = brutos.map(b => JSON.parse(b));

    const agora = new Date();
    const inicioDia = new Date(agora); inicioDia.setHours(0, 0, 0, 0);
    const inicioSemana = new Date(agora); inicioSemana.setDate(agora.getDate() - agora.getDay()); inicioSemana.setHours(0, 0, 0, 0);
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const inicioMesPassado = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
    const fimMesPassado = new Date(agora.getFullYear(), agora.getMonth(), 0, 23, 59, 59);

    // Filtra só pedidos que geram receita (não leads, não cancelados)
    const ativos = todos.filter(p => !['cancelado', 'lead'].includes(p.status));

    function filtrarPeriodo(lista, inicio, fim) {
      return lista.filter(p => {
        const d = new Date(p.criadoEm);
        return d >= inicio && (!fim || d <= fim);
      });
    }

    function somarTotal(lista) {
      return lista.reduce((acc, p) => acc + (Number(p.total) || 0), 0);
    }

    function contarItens(lista) {
      const contagem = {};
      lista.forEach(p => {
        (p.itens || []).forEach(item => {
          contagem[item] = (contagem[item] || 0) + 1;
        });
      });
      return Object.entries(contagem)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([nome, qtd]) => ({ nome, qtd }));
    }

    // Pedidos dos últimos 30 dias agrupados por dia (para o gráfico)
    const inicio30dias = new Date(agora); inicio30dias.setDate(agora.getDate() - 29); inicio30dias.setHours(0, 0, 0, 0);
    const ultimos30 = filtrarPeriodo(ativos, inicio30dias);

    const porDia = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(agora);
      d.setDate(agora.getDate() - i);
      const chaveD = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      porDia[chaveD] = { pedidos: 0, receita: 0 };
    }
    ultimos30.forEach(p => {
      const chaveD = new Date(p.criadoEm).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      if (porDia[chaveD]) {
        porDia[chaveD].pedidos++;
        porDia[chaveD].receita += Number(p.total) || 0;
      }
    });

    const hoje = filtrarPeriodo(ativos, inicioDia);
    const semana = filtrarPeriodo(ativos, inicioSemana);
    const mes = filtrarPeriodo(ativos, inicioMes);
    const mesPassado = filtrarPeriodo(ativos, inicioMesPassado, fimMesPassado);
    const leads = todos.filter(p => p.status === 'lead');
    const cancelados = todos.filter(p => p.status === 'cancelado');

    return res.status(200).json({
      resumo: {
        hoje: { pedidos: hoje.length, receita: somarTotal(hoje) },
        semana: { pedidos: semana.length, receita: somarTotal(semana) },
        mes: { pedidos: mes.length, receita: somarTotal(mes) },
        mesPassado: { pedidos: mesPassado.length, receita: somarTotal(mesPassado) },
        total: { pedidos: ativos.length, leads: leads.length, cancelados: cancelados.length },
      },
      topItens: contarItens(ativos),
      porDia: Object.entries(porDia).map(([data, v]) => ({ data, ...v })),
    });
  } catch (err) {
    console.error('Erro ao gerar relatório:', err);
    return res.status(500).json({ error: 'Erro ao gerar relatório' });
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
