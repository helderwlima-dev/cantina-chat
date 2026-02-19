import { createClient } from "@supabase/supabase-js";

function getSupabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

async function readBodySafe(req) {
  // 1) Next já parseou
  if (req.body && typeof req.body === "object") return req.body;

  // 2) veio como string
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }

  // 3) stream manual
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Metodo no permitido" });

  try {
    const body = await readBodySafe(req);

    // DEBUG (veja em Vercel > Functions > api/lancar-consumo)
    console.log("DEBUG headers:", req.headers);
    console.log("DEBUG raw body parsed:", body);

    const aluno_id = body.aluno_id ?? body.alunoId ?? body.alunoid ?? null;
    const rawValor = body.valor ?? body.total ?? body.valorTotal ?? null;

    const valorNum = Number(rawValor);
    const origem = (body.origem || "Venda na cantina").toString();
    const forcar = !!body.forcar;

    if (!aluno_id) {
      return res.status(400).json({
        erro: "Campo obrigatorio: aluno_id",
        dica: "Envie aluno_id (ou alunoId/alunoid). Ex: {\"aluno_id\":\"UUID\",\"valor\":10}"
      });
    }
    if (Number.isNaN(valorNum) || valorNum <= 0) {
      return res.status(400).json({
        erro: "Campo obrigatorio: valor (numero > 0)",
        dica: "Envie valor (ou total/valorTotal) como numero. Ex: {\"aluno_id\":\"UUID\",\"valor\":10}"
      });
    }

    const supabase = getSupabaseClient();

    // Busca aluno (aluno_id do JSON == alunos.id)
    const { data: aluno, error: erroAluno } = await supabase
      .from("alunos")
      .select("id, nome, ativo, saldo_atual, limite_diario, limite_mensal, limite_fiado")
      .eq("id", aluno_id)
      .single();

    if (erroAluno) return res.status(500).json({ erro: erroAluno.message });
    if (!aluno) return res.status(404).json({ erro: "Aluno nao encontrado" });
    if (aluno.ativo === false) return res.status(400).json({ erro: "Aluno inativo" });

    const saldoAtual = Number(aluno.saldo_atual || 0);
    const limiteDiario = Number(aluno.limite_diario || 0);
    const limiteMensal = Number(aluno.limite_mensal || 0);
    const limiteFiado = Number(aluno.limite_fiado || 0);

    // Totais dia/mês (débitos)
    const agora = new Date();
    const inicioHoje = new Date(agora); inicioHoje.setHours(0, 0, 0, 0);
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1); inicioMes.setHours(0, 0, 0, 0);

    const { data: movDia, error: erroMovDia } = await supabase
      .from("movimentacoes_saldo")
      .select("valor")
      .eq("aluno_id", aluno_id)
      .gte("created_at", inicioHoje.toISOString());
    if (erroMovDia) return res.status(500).json({ erro: erroMovDia.message });

    const totalDia = (movDia || [])
      .map((m) => Number(m.valor || 0))
      .filter((v) => v < 0)
      .reduce((acc, v) => acc + Math.abs(v), 0);

    const { data: movMes, error: erroMovMes } = await supabase
      .from("movimentacoes_saldo")
      .select("valor")
      .eq("aluno_id", aluno_id)
      .gte("created_at", inicioMes.toISOString());
    if (erroMovMes) return res.status(500).json({ erro: erroMovMes.message });

    const totalMes = (movMes || [])
      .map((m) => Number(m.valor || 0))
      .filter((v) => v < 0)
      .reduce((acc, v) => acc + Math.abs(v), 0);

    // Bloqueios com opção B (alerta e pergunta; libera com forcar:true)
    if (!forcar) {
      if (limiteDiario > 0 && totalDia + valorNum > limiteDiario) {
        return res.status(200).json({
          alerta: true,
          tipo: "limite_diario",
          mensagem: "Limite diario ultrapassado. Deseja liberar mesmo assim?",
          limite_diario: limiteDiario,
          total_dia: totalDia,
          valor_solicitado: valorNum
        });
      }
      if (limiteMensal > 0 && totalMes + valorNum > limiteMensal) {
        return res.status(200).json({
          alerta: true,
          tipo: "limite_mensal",
          mensagem: "Limite mensal ultrapassado. Deseja liberar mesmo assim?",
          limite_mensal: limiteMensal,
          total_mes: totalMes,
          valor_solicitado: valorNum
        });
      }
      if (limiteFiado > 0) {
        const saldoDepois = saldoAtual - valorNum;
        if (saldoDepois < -limiteFiado) {
          return res.status(200).json({
            alerta: true,
            tipo: "limite_fiado",
            mensagem: "Limite de fiado ultrapassado. Deseja liberar mesmo assim?",
            limite_fiado: limiteFiado,
            saldo_atual: saldoAtual,
            saldo_apos_venda: saldoDepois,
            valor_solicitado: valorNum
          });
        }
      }
    }

    // Atualiza saldo
    const saldoAnterior = saldoAtual;
    const saldoNovo = saldoAnterior - valorNum;

    const { error: erroUpdate } = await supabase
      .from("alunos")
      .update({ saldo_atual: saldoNovo })
      .eq("id", aluno_id);
    if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });

    // Grava movimentação
    const { data: movCriada, error: erroInsert } = await supabase
      .from("movimentacoes_saldo")
      .insert({
        aluno_id,
        tipo: "debito",
        valor: -Math.abs(valorNum),
        origem: forcar ? `${origem} (EXCECAO)` : origem,
        referencia_id: null
      })
      .select("id, aluno_id, tipo, valor, origem, referencia_id, created_at")
      .single();

    if (erroInsert) return res.status(500).json({ erro: erroInsert.message });

    return res.status(200).json({
      sucesso: true,
      liberado_manual: !!forcar,
      aluno: { id: aluno.id, nome: aluno.nome },
      saldo_anterior: saldoAnterior,
      saldo_atual: saldoNovo,
      movimentacao: movCriada
    });
  } catch (err) {
    return res.status(500).json({ erro: err?.message || "Erro interno" });
  }
}
