import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

export default async function handler(req, res) {
  // 🔓 CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  )

  if (req.method === 'OPTIONS') {
    return res.status(200).json({})
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' })
  }

  try {
    const { aluno_id, valor, descricao, forcar } = req.body

    if (!aluno_id || !valor) {
      return res.status(400).json({ erro: 'Dados obrigatórios faltando' })
    }

    // 🔎 busca aluno
    const { data: aluno, error: erroAluno } = await supabase
      .from('alunos')
      .select('*')
      .eq('id', aluno_id)
      .single()

    if (erroAluno || !aluno) {
      return res.status(404).json({ erro: 'Aluno não encontrado' })
    }

    // 📅 hoje (UTC simples)
    const hojeInicio = new Date()
    hojeInicio.setHours(0, 0, 0, 0)

    // 📅 início do mês
    const inicioMes = new Date(
      hojeInicio.getFullYear(),
      hojeInicio.getMonth(),
      1
    )

    // 🔎 total diário
    const { data: movDia } = await supabase
      .from('movimentacoes_saldo')
      .select('valor')
      .eq('aluno_id', aluno_id)
      .gte('created_at', hojeInicio.toISOString())

    const totalDia =
      movDia?.reduce((s, m) => s + Math.abs(Number(m.valor)), 0) || 0

    // 🔎 total mensal
    const { data: movMes } = await supabase
      .from('movimentacoes_saldo')
      .select('valor')
      .eq('aluno_id', aluno_id)
      .gte('created_at', inicioMes.toISOString())

    const totalMes =
      movMes?.reduce((s, m) => s + Math.abs(Number(m.valor)), 0) || 0

    // 🚨 valida limites
    if (!forcar) {
      if (aluno.limite_diario && totalDia + valor > aluno.limite_diario) {
        return res.status(200).json({
          alerta: true,
          tipo: 'limite_diario',
          mensagem: 'Limite diário ultrapassado',
          total_dia: totalDia
        })
      }

      if (aluno.limite_mensal && totalMes + valor > aluno.limite_mensal) {
        return res.status(200).json({
          alerta: true,
          tipo: 'limite_mensal',
          mensagem: 'Limite mensal ultrapassado',
          total_mes: totalMes
        })
      }
    }

    const novoSaldo = Number(aluno.saldo_atual) - Number(valor)

    // 💾 atualiza saldo
    const { error: erroUpdate } = await supabase
      .from('alunos')
      .update({ saldo_atual: novoSaldo })
      .eq('id', aluno_id)

    if (erroUpdate) {
      return res.status(500).json({ erro: erroUpdate.message })
    }

    // 🧾 movimentação
    await supabase.from('movimentacoes_saldo').insert({
      aluno_id,
      valor: -Math.abs(valor),
      tipo: 'debito',
      descricao: descricao || 'Venda na cantina',
      liberado_manual: !!forcar
    })

    return res.status(200).json({
      sucesso: true,
      saldo_anterior: aluno.saldo_atual,
      saldo_atual: novoSaldo
    })
  } catch (err) {
    return res.status(500).json({ erro: err.message })
  }
}
