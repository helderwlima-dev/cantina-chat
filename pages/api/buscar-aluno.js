import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
)

export default async function handler(req, res) {
  // ✅ CORS (OBRIGATÓRIO pro Botpress)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Metodo nao permitido' })
  }

  try {
    const { nome } = req.body || {}

    if (!nome) {
      return res.status(400).json({ erro: 'Nome não informado' })
    }

    const { data, error } = await supabase
      .from('alunos')
      .select('id, nome, saldo_atual')
      .ilike('nome', `%${nome}%`)
      .limit(10)

    if (error) {
      return res.status(500).json({ erro: error.message })
    }

    return res.status(200).json(
      (data || []).map(a => ({
        id: a.id,
        nome: a.nome,
        saldo: a.saldo_atual
      }))
    )

  } catch (err) {
    return res.status(500).json({ erro: err.message })
  }
}
