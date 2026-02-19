import { createClient } from "@supabase/supabase-js";

function getSupabaseClient(res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl) {
    res.status(500).json({ erro: "Env ausente: SUPABASE_URL" });
    return null;
  }
  if (!supabaseKey) {
    res.status(500).json({ erro: "Env ausente: SUPABASE_KEY" });
    return null;
  }

  return createClient(supabaseUrl, supabaseKey);
}

export default async function handler(req, res) {
  // CORS primeiro (evita “Network error” no Hoppscotch)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Metodo no permitido" });

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  try {
    const body = req.body || {};

    // Body padronizado
    const aluno_id = body.aluno_id;
    const valor = Number(body.valor);
    const origem = body.origem || body.descricao || "Venda na cantina"; // você pode mandar origem ou descricao
    const forcar = !!body.forcar;

    if (!aluno_id) return res.status(400).json({ erro: "Campo obrigatorio: aluno_id" });
    if (Number.isNaN(valor) || valor <= 0) {
      return res.status(400).json({ erro: "Campo obrigatorio: valor (numero > 0)" });
    }

    // 1) Busca aluno
    const { data: aluno, error: erroAluno } = await supabase
      .from("alunos")
      .select("id, nome, saldo_atual, limite_diario, limite_mensal, ativo")
      .eq("id", aluno_id)
      .single();

    if (erroAluno) return res.status(500).json({ erro: erroAluno.message });
    if (!aluno) return res.status(404).json({ erro: "Aluno nao encontrado" });
    if (aluno.ativo === false) return res.status(400).json({ erro: "Aluno inativo" });

    // 2) Calcula consumo do dia e do mês (somando apenas débitos)
    const hojeInicio = new Date();
    hojeInicio.setHours(0, 0, 0, 0);

    const inicioMes = new Date(hojeInicio.getFullYear(), hojeInicio.getMonth(), 1);

    const { data: movDia, error: erroMovDia } = await supabase
      .from("movimentacoes_saldo")
      .select("valor, created_at")
      .eq("aluno_id", aluno_id)
      .gte("created_at", hojeInicio.toISOString());

    if (erroMovDia) return res.status(500).json({ erro: erroMovDia.message });

    const totalDia = (movDia || [])
      .filter((m) => Number(m.valor) < 0)
      .reduce((s, m) => s + Math.abs(Number(m.valor)), 0);

    const { data: movMes, error: erroMovMes } = await supabase
      .from("movimentacoes_saldo")
      .select("valor, created_at")
      .eq("aluno_id", aluno_id)
      .gte("created_at", inicioMes.toISOString());

    if (erroMovMes) return res.status(500).json({ erro: erroMovMes.message });

    const totalMes = (movMes || [])
      .filter((m) => Number(m.valor) < 0)
      .reduce((s, m) => s + Math.abs(Number(m.valor)), 0);

    // 3) Checa limites (Fluxo B)
    const limiteDiario = Number(aluno.limite_diario || 0);
    const limiteMensal = Number(aluno.limite_mensal || 0);

    if (!forcar) {
      if (limiteDiario > 0 && totalDia + valor > limiteDiario) {
        return res.status(200).json({
          alerta: true,
          tipo: "limite_diario",
          mensagem: "Limite diario ultrapassado. Deseja liberar mesmo assim?",
          aluno: { id: aluno.id, nome: aluno.nome, saldo_atual: Number(aluno.saldo_atual || 0) },
          limite_diario: limiteDiario,
          total_dia: totalDia,
          valor_solicitado: valor,
        });
      }

      if (limiteMensal > 0 && totalMes + valor > limiteMensal) {
        return res.status(200).json({
          alerta: true,
          tipo: "limite_mensal",
          mensagem: "Limite mensal ultrapassado. Deseja liberar mesmo assim?",
          aluno: { id: aluno.id, nome: aluno.nome, saldo_atual: Number(aluno.saldo_atual || 0) },
          limite_mensal: limiteMensal,
          total_mes: totalMes,
          valor_solicitado: valor,
        });
      }
    }

    // 4) Atualiza saldo do aluno
    const saldoAnterior = Number(aluno.saldo_atual || 0);
    const saldoAtual = saldoAnterior - valor;

    const { error: erroUpdate } = await supabase
      .from("alunos")
      .update({ saldo_atual: saldoAtual })
      .eq("id", aluno_id);

    if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });

    // 5) Insere movimentação (seu SQL)
    const { error: erroInsert } = await supabase.from("movimentacoes_saldo").insert({
      aluno_id,
      tipo: "debito",
      valor: -Math.abs(valor),
      origem: forcar ? `${origem} (EXCECAO)` : origem,
      referencia_id: null,
      // created_at é default now(), não precisa mandar
    });

    if (erroInsert) return res.status(500).json({ erro: erroInsert.message });

    return res.status(200).json({
      sucesso: true,
      liberado_manual: !!forcar,
      aluno: { id: aluno.id, nome: aluno.nome },
      saldo_anterior: saldoAnterior,
      saldo_atual: saldoAtual,
    });
  } catch (err) {
    return res.status(500).json({ erro: err?.message || "Erro interno" });
  }
}
