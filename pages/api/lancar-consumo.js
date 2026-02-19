export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASEURL, process.env.SUPABASEKEY);

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Metodo no permitido" });

  try {
    const { alunoid, valor, descricao, forcar } = req.body || {};
    const v = Number(valor);

    if (!alunoid || !valor || Number.isNaN(v) || v <= 0) {
      return res.status(400).json({ erro: "Dados obrigatorios faltando (alunoid, valor>0)" });
    }

    // 1) Busca aluno + limites
    const { data: aluno, error: erroAluno } = await supabase
      .from("alunos")
      .select("id, nome, saldoatual, limitediario, limitemensal, limitefiado, ativo")
      .eq("id", alunoid)
      .single();

    if (erroAluno || !aluno) return res.status(404).json({ erro: "Aluno nao encontrado" });
    if (aluno.ativo === false) return res.status(400).json({ erro: "Aluno inativo" });

    // 2) Calcula total gasto hoje e no mês (usando movimentacoes_saldo)
    const hojeInicio = new Date();
    hojeInicio.setHours(0, 0, 0, 0);

    const inicioMes = new Date(hojeInicio.getFullYear(), hojeInicio.getMonth(), 1);

    const { data: movDia, error: erroMovDia } = await supabase
      .from("movimentacoes_saldo")
      .select("valor, createdat")
      .eq("alunoid", alunoid)
      .gte("createdat", hojeInicio.toISOString());

    if (erroMovDia) return res.status(500).json({ erro: erroMovDia.message });

    const totalDia = (movDia || [])
      .filter(m => Number(m.valor) < 0) // débitos
      .reduce((s, m) => s + Math.abs(Number(m.valor)), 0);

    const { data: movMes, error: erroMovMes } = await supabase
      .from("movimentacoes_saldo")
      .select("valor, createdat")
      .eq("alunoid", alunoid)
      .gte("createdat", inicioMes.toISOString());

    if (erroMovMes) return res.status(500).json({ erro: erroMovMes.message });

    const totalMes = (movMes || [])
      .filter(m => Number(m.valor) < 0)
      .reduce((s, m) => s + Math.abs(Number(m.valor)), 0);

    // 3) Regra B: se estourar, retorna alerta e só prossegue com forcar=true
    if (!forcar) {
      if (Number(aluno.limitediario) > 0 && (totalDia + v) > Number(aluno.limitediario)) {
        return res.status(200).json({
          alerta: true,
          tipo: "limitediario",
          mensagem: "Limite diario ultrapassado. Deseja liberar mesmo assim?",
          alunoid,
          aluno: aluno.nome,
          totalDia,
          limiteDiario: aluno.limitediario,
          valorSolicitado: v
        });
      }

      if (Number(aluno.limitemensal) > 0 && (totalMes + v) > Number(aluno.limitemensal)) {
        return res.status(200).json({
          alerta: true,
          tipo: "limitemensal",
          mensagem: "Limite mensal ultrapassado. Deseja liberar mesmo assim?",
          alunoid,
          aluno: aluno.nome,
          totalMes,
          limiteMensal: aluno.limitemensal,
          valorSolicitado: v
        });
      }
    }

    // 4) Debita saldo e registra movimentação
    const novoSaldo = Number(aluno.saldoatual) - v;

    const { error: erroUpdate } = await supabase
      .from("alunos")
      .update({ saldoatual: novoSaldo })
      .eq("id", alunoid);

    if (erroUpdate) return res.status(500).json({ erro: erroUpdate.message });

    const { error: erroMov } = await supabase
      .from("movimentacoes_saldo")
      .insert({
        alunoid,
        tipo: "debito",
        valor: -Math.abs(v),
        descricao: descricao || "Venda na cantina",
        liberadomanual: !!forcar
      });

    if (erroMov) return res.status(500).json({ erro: erroMov.message });

    return res.status(200).json({
      sucesso: true,
      aluno: aluno.nome,
      saldoAnterior: Number(aluno.saldoatual),
      saldoAtual: novoSaldo,
      liberadoManual: !!forcar
    });

  } catch (err) {
    return res.status(500).json({ erro: err?.message || "Erro interno" });
  }
}
