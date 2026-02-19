import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

export default async function handler(req, res) {
  const { busca } = req.query

  if (!busca) {
    return res.status(400).json({ erro: 'Busca não informada' })
  }

  const { data, error } = await supabase
    .from('alunos')
    .select('id, nome, saldo_atual')
    .ilike('nome', `%${busca}%`)
    .limit(10)

  if (error) {
    return res.status(500).json({ erro: error.message })
  }

  res.status(200).json(
    data.map(a => ({
      id: a.id,
      nome: a.nome,
      saldo: a.saldo_atual
    }))
  )
}
