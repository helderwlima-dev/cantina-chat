import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  try {
    const { busca } = req.query

    if (!busca) {
      return res.status(400).json({ erro: 'Busca não informada' })
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    )

    const { data, error } = await supabase
      .rpc('buscar_alunos_por_nome', { busca })

    if (error) {
      return res.status(500).json({ erro: error.message })
    }

    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno' })
  }
}
