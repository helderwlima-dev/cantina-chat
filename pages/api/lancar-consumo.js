import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

export default async function handler(req, res) {
  // 🔓 CORS completo
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  )

  // ✅ responde preflight SEMPRE
  if (req.method === 'OPTIONS') {
    return res.status(200).json({})
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' })
  }

  try {
    const { aluno_id, valor, descricao } = req.body

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
      descricao: descricao || 'Venda na cantina'
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
