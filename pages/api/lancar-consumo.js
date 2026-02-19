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

// Ajuda quando o req.body vem como string, buffer ou vem vazio
async function readBodySafe(req) {
  // Caso 1: Next já parseou
  if (req.body && typeof req.body === "object") return req.body;

  // Caso 2: body veio como string (às vezes)
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }

  // Caso 3: ler o stream manualmente (último recurso)
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
  // CORS (Hoppscotch no browser precisa disso)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Metodo no permitido" });

  const supabase = getSupabaseClient(res);
  if (!supabase) return;

  try {
    const body = await readBodySafe(req);

    const aluno_id = body.aluno_id;
    const valorNum = Number(body.valor);
    const origem = (body.origem || "Venda na cantina").toString();
    const forcar = !!body.forcar;

    if (!aluno_id) {
      return res.status(400).json({ erro: "Campo obrigatorio: aluno_id" });
    }
    if (Number.isNaN(valorNum) || valorNum <= 0) {
      return res.status(400).json({ erro: "Campo obrigatorio: valor (numero > 0)" });
    }

    // 1) Busca aluno
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

    // 2) Calcula total do dia e do mês (somente débitos)
    const agora = new Date();
    const inicioHoje = new Date(agora);
    inicioHoje.setHours(0, 0, 0, 0);

    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    inicioMes.setHours(0, 0, 0, 0);

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

    // 3) Validações (se não forçar)
    if (!forcar) {
      if (limiteDiario > 0 && totalDia + valorNum > limiteDiario) {
        return res.status(200).json({
          alerta: true,
          tipo: "limite_diario",
          mensagem: "Limite diario ultrapassado. Deseja liberar mesmo assim?",
          aluno: { id: aluno.id, nome: aluno.nome, saldo_atual: saldoAtual },
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
          aluno: { id: aluno.id, nome: aluno.nome, saldo_atual: saldoAtual },
          limite_mensal: limiteMensal,
          total_mes: totalMes,
          valor_solicitado: valorNum
        });
      }

      // Regra B: limite_fiado = 0 => sem limite
      if (limiteFiado > 0) {
        const saldoDepois = saldoAtual - valorNum;
        if (saldoDepois < -limiteFiado) {
          return res.status(200).json({
            alerta: true,
            tipo: "limite_fiado",
            mensagem: "Limite de fiado ultrapassado. Deseja liberar mesmo assim?",
            aluno: { id: aluno.id, nome: aluno.nome, saldo_atual: saldoAtual },
            limite_fiado: limiteFiado,
            saldo_apos_venda: saldoDepois,
            valor_solicitado: valorNum
          });
        }
      }
    }

    // 4) Atualiza saldo
    const saldoAnterior = saldoAtual;
    const saldoNovo = saldoAnterior - valorNum;

    const { error: erroUpdate } = await supabase
      .from("alunos")
      .update({ saldo_atual: saldoNovo })
      .eq("id", aluno_id);

    if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });

    // 5) Grava movimentação e retorna
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
