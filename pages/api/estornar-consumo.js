import { createClient } from "@supabase/supabase-js";

// ===== Supabase (usando suas envs) =====
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Variáveis do Supabase não configuradas");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ===== helper seguro para ler body =====
async function readBodySafe(req) {
  if (req.body && typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export default async function handler(req, res) {
  // ===== CORS (ajuda no Botpress) =====
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Metodo nao permitido" });
  }

  try {
    const body = await readBodySafe(req);
    let { movimentacao_id, nome, motivo } = body || {};

    // 🔥 Se não veio ID, tenta achar pela última venda do aluno
    if (!movimentacao_id && nome) {
      const { data: alunoBusca, error: erroBuscaAluno } = await supabase
        .from("alunos")
        .select("id")
        .ilike("nome", `%${nome}%`)
        .limit(1)
        .single();

      if (erroBuscaAluno || !alunoBusca) {
        return res
          .status(404)
          .json({ erro: "Aluno nao encontrado para estorno" });
      }

      // pega última venda (debito)
      const { data: ultimaMov, error: erroUltimaMov } = await supabase
        .from("movimentacoes_saldo")
        .select("id")
        .eq("aluno_id", alunoBusca.id)
        .eq("tipo", "debito")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (erroUltimaMov || !ultimaMov) {
        return res
          .status(404)
          .json({ erro: "Aluno nao possui vendas para estornar" });
      }

      movimentacao_id = ultimaMov.id;
    }

    if (!movimentacao_id) {
      return res.status(400).json({
        erro: "Informe movimentacao_id ou nome do aluno",
      });
    }

    // ===== busca movimentação =====
    const { data: mov, error: erroMov } = await supabase
      .from("movimentacoes_saldo")
      .select(
        "id, aluno_id, tipo, valor, origem, referencia_id, created_at"
      )
      .eq("id", movimentacao_id)
      .single();

    if (erroMov) return res.status(500).json({ erro: erroMov.message });
    if (!mov)
      return res.status(404).json({ erro: "Movimentacao nao encontrada" });

    if (mov.tipo !== "debito") {
      return res.status(400).json({
        erro: "So pode estornar movimentacao do tipo debito",
      });
    }

    // ===== verifica se já foi estornado =====
    const { data: estornos } = await supabase
      .from("movimentacoes_saldo")
      .select("id")
      .eq("tipo", "estorno")
      .eq("referencia_id", movimentacao_id)
      .limit(1);

    if ((estornos || []).length > 0) {
      return res
        .status(400)
        .json({ erro: "Essa movimentacao ja foi estornada" });
    }

    // ===== busca aluno =====
    const { data: aluno, error: erroAluno } = await supabase
      .from("alunos")
      .select("id, nome, saldo_atual")
      .eq("id", mov.aluno_id)
      .single();

    if (erroAluno) return res.status(500).json({ erro: erroAluno.message });

    // ===== calcula novo saldo =====
    const saldoAnterior = Number(aluno.saldo_atual || 0);
    const valorDebito = Math.abs(Number(mov.valor));
    const saldoAtual = saldoAnterior + valorDebito;

    // ===== atualiza saldo =====
    const { error: erroUpdate } = await supabase
      .from("alunos")
      .update({ saldo_atual: saldoAtual })
      .eq("id", mov.aluno_id);

    if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });

    // ===== cria registro de estorno =====
    const origemEstorno = `ESTORNO: ${
      mov.origem || "debito"
    }${motivo ? ` | Motivo: ${motivo}` : ""}`;

    const { data: estornoCriado, error: erroInsert } = await supabase
      .from("movimentacoes_saldo")
      .insert([
        {
          aluno_id: mov.aluno_id,
          tipo: "estorno",
          valor: valorDebito,
          origem: origemEstorno,
          referencia_id: mov.id,
        },
      ])
      .select()
      .single();

    if (erroInsert) return res.status(500).json({ erro: erroInsert.message });

    // ===== resposta final =====
    return res.status(200).json({
      sucesso: true,
      mensagem: `Estorno realizado para ${aluno.nome}`,
      saldo_anterior: saldoAnterior,
      saldo_atual: saldoAtual,
      estorno_id: estornoCriado.id,
    });
  } catch (erro) {
    console.error("Erro no estorno:", erro);
    return res.status(500).json({ erro: "Erro interno no servidor" });
  }
}
