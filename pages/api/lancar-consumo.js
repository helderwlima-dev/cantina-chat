import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // CORS (importante pro Hoppscotch web)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Metodo no permitido" });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  try {
    const { aluno_id, valor, descricao, forcar } = req.body || {};
    const v = Number(valor);

    if (!aluno_id) return res.status(400).json({ erro: "Campo obrigatorio: aluno_id" });
    if (Number.isNaN(v) || v <= 0) {
      return res.status(400).json({ erro: "Campo obrigatorio: valor (numero > 0)" });
    }

    // 1) Busca aluno (nomes iguais ao seu SQL)
    const { data: aluno, error: erroAluno } = await supabase
      .from("alunos")
      .select("id, nome, saldo_atual, limite_diario, limite_mensal, ativo")
      .eq("id", aluno_id)
      .single();

    if (erroAluno || !aluno) return res.status(404).json({ erro: "Aluno nao encontrado" });
    if (aluno.ativo === false) return res.status(400).json({ erro: "Aluno inativo" });

    // 2) Calcula totais do dia e do mês (usando movimentacoes_saldo e created_at)
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
      .filter((m) => Number(m.valor) < 0) // débitos
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

    // 3) Regra B: alerta -> se forcar=true, libera e registra
    const limiteDiario = Number(aluno.limite_diario || 0);
    const limiteMensal = Number(aluno.limite_mensal || 0);

    if (!forcar) {
      if (limiteDiario > 0 && totalDia + v > limiteDiario) {
        return res.status(200).json({
          alerta: true,
          tipo: "limite_diario",
          mensagem: "Limite diario ultrapassado. Deseja liberar mesmo assim?",
          aluno: { id: aluno.id, nome: aluno.nome, saldo_atual: Number(aluno.saldo_atual) },
          limite_diario: limiteDiario,
          total_dia: totalDia,
          valor_solicitado: v,
        });
      }

      if (limiteMensal > 0 && totalMes + v > limiteMensal) {
        return res.status(200).json({
          alerta: true,
          tipo: "limite_mensal",
          mensagem: "Limite mensal ultrapassado. Deseja liberar mesmo assim?",
          aluno: { id: aluno.id, nome: aluno.nome, saldo_atual: Number(aluno.saldo_atual) },
          limite_mensal: limiteMensal,
          total_mes: totalMes,
          valor_solicitado: v,
        });
      }
    }

    // 4) Debita saldo
    const saldoAnterior = Number(aluno.saldo_atual || 0);
    const saldoAtual = saldoAnterior - v;

    const { error: erroUpdate } = await supabase
      .from("alunos")
      .update({ saldo_atual: saldoAtual })
      .eq("id", aluno_id);

    if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });

    // 5) Registra movimentação (seu SQL não tem "descricao" nem "liberadomanual")
    // Vou usar "origem" pra guardar a descricao, e "referencia_id" fica null por enquanto.
    const { error: erroMovInsert } = await supabase.from("movimentacoes_saldo").insert({
      aluno_id,
      tipo: "debito",
      valor: -Math.abs(v),
      origem: descricao || "Venda na cantina",
      referencia_id: null,
    });

    if (erroMovInsert) return res.status(500).json({ erro: erroMovInsert.message });

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
