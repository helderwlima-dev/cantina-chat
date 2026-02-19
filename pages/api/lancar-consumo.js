import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' })
  }

  try {
    const { aluno_id, valor, descricao } = req.body

    if (!aluno_id || !valor) {
      return res.status(400).json({ error: 'Dados obrigatórios faltando' })
    }

    // 1️⃣ Buscar saldo atual
    const { data: aluno, error: erroAluno } = await supabase
      .from('alunos')
      .select('saldo_atual, nome')
      .eq('id', aluno_id)
      .single()

    if (erroAluno || !aluno) {
      return res.status(404).json({ error: 'Aluno não encontrado' })
    }

    const novoSaldo = Number(aluno.saldo_atual) - Number(valor)

    // 2️⃣ Atualizar saldo do aluno
    const { error: erroUpdate } = await supabase
      .from('alunos')
      .update({ saldo_atual: novoSaldo })
      .eq('id', aluno_id)

    if (erroUpdate) throw erroUpdate

    // 3️⃣ Registrar movimentação
    const { error: erroMov } = await supabase
      .from('movimentacoes_saldo')
      .insert({
        aluno_id,
        tipo: 'debito',
        valor,
        descricao: descricao || 'Compra na cantina'
      })

    if (erroMov) throw erroMov

    return res.status(200).json({
      sucesso: true,
      aluno: aluno.nome,
      saldo_anterior: aluno.saldo_atual,
      saldo_atual: novoSaldo
    })

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Erro interno' })
  }
}
