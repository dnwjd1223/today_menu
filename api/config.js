// Vercel Node.js Function: GET /api/config
// 브라우저용 URL과 publishable/anon 키만 반환합니다.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = (
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || ''
  ).trim();
  const supabaseKey = (
    process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''
  ).trim();

  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ error: 'Supabase URL and public API key are not configured' });
  }
  try {
    if (new URL(supabaseUrl).protocol !== 'https:') throw new Error('Invalid URL');
    // 비밀 키를 공개 환경 변수에 잘못 넣어도 브라우저로 전달하지 않습니다.
    if (!supabaseKey.startsWith('sb_publishable_')) {
      const payload = JSON.parse(Buffer.from(supabaseKey.split('.')[1] || '', 'base64url').toString('utf8'));
      if (payload.role !== 'anon') throw new Error('Not a public key');
    }
  } catch {
    return res.status(503).json({ error: 'Invalid Supabase URL or public API key' });
  }
  return res.status(200).json({ supabaseUrl, supabaseKey });
};
