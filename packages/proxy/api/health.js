// Health endpoint — reports which providers have keys configured (no secrets leaked).
module.exports = function handler(_req, res) {
  const providers = {
    groq: Boolean(process.env.GROQ_KEY),
    mistral: Boolean(process.env.MISTRAL_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_KEY),
  };
  const ok = Object.values(providers).some(Boolean);
  res.status(ok ? 200 : 503).json({ ok, providers, version: '3.0.0' });
};
