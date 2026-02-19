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
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Metodo no permitido" });

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  try {
    const { movimentacao_id, motivo } = req.body || {};
    if (!movimentacao_id) {
      return res.status(400).json({ erro: "Campo obrigatorio: movimentacao_id" });
    }

    // 1) Busca movimentação original
    const { data: mov, error: erroMov } = await supabase
      .from("movimentacoes_saldo")
      .select("id, aluno_id, tipo, valor, origem, referencia_id, created_at")
      .eq("id", movimentacao_id)
      .single();

    if (erroMov) return res.status(500).json({ erro: erroMov.message });
    if (!mov) return res.status(404).json({ erro: "Movimentacao nao encontrada" });

    if (mov.tipo !== "debito") {
      return res.status(400).json({ erro: "So pode estornar movimentacao do tipo debito" });
    }

    // 2) Verifica se já existe estorno dessa movimentação
    const { data: estornos, error: erroEst } = await supabase
      .from("movimentacoes_saldo")
      .select("id")
      .eq("tipo", "estorno")
      .eq("referencia_id", movimentacao_id)
      .limit(1);

    if (erroEst) return res.status(500).json({ erro: erroEst.message });
    if ((estornos || []).length > 0) {
      return res.status(400).json({ erro: "Essa movimentacao ja foi estornada" });
    }

    // 3) Busca saldo atual do aluno
    const { data: aluno, error: erroAluno } = await supabase
      .from("alunos")
      .select("id, nome, saldo_atual")
      .eq("id", mov.aluno_id)
      .single();

    if (erroAluno) return res.status(500).json({ erro: erroAluno.message });
    if (!aluno) return res.status(404).json({ erro: "Aluno nao encontrado" });

    const saldoAnterior = Number(aluno.saldo_atual || 0);

    // mov.valor é negativo (debito). Para estornar, somamos o absoluto.
    const valorDebito = Math.abs(Number(mov.valor));
    const saldoAtual = saldoAnterior + valorDebito;

    // 4) Atualiza saldo
    const { error: erroUpdate } = await supabase
      .from("alunos")
      .update({ saldo_atual: saldoAtual })
      .eq("id", mov.aluno_id);

    if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });

    // 5) Insere estorno referenciando a movimentação original
    const origemEstorno =
      `ESTORNO: ${mov.origem || "debito"}${motivo ? ` | Motivo: ${motivo}` : ""}`;

    const { data: estornoCriado, error: erroInsert } = await supabase
      .from("movimentacoes_saldo")
      .insert({
        aluno_id: mov.aluno_id,
        tipo: "estorno",
        valor: valorDebito,          // estorno é positivo
        origem: origemEstorno,
        referencia_id: movimentacao_id
      })
      .select("id, aluno_id, tipo, valor, origem, referencia_id, created_at")
      .single();

    if (erroInsert) return res.status(500).json({ erro: erroInsert.message });

    return res.status(200).json({
      sucesso: true,
      aluno: { id: aluno.id, nome: aluno.nome },
      saldo_anterior: saldoAnterior,
      saldo_atual: saldoAtual,
      estorno: estornoCriado
    });
  } catch (err) {
    return res.status(500).json({ erro: err?.message || "Erro interno" });
  }
}
