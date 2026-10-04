// Vercel Serverless Function: lee un ticket con Claude y lo desglosa.
// Variables de entorno en Vercel: ANTHROPIC_API_KEY (obligatoria), CLAUDE_MODEL (opcional).
const SUPABASE_URL = process.env.SUPABASE_URL || "https://whsegvulhumxvxwbfigo.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_uRLpG1zYCDS2k-wqQQ1j1w_1ZImq1gE";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const CATS = ["Despensa","Nevera","Frutas y verduras","Carnes y pescado","Panadería","Limpieza","Aseo personal","Bebidas","Otros"];

const SYSTEM = `Eres un lector de tickets de supermercado de España. Recibes una o varias fotos (o un PDF) de UN solo ticket y la lista de productos de una casa.
Devuelve SOLO un objeto JSON válido, sin texto antes ni después y sin \`\`\`:
{"tienda":"nombre del súper o ''","fecha":"AAAA-MM-DD o null","total":número o null,"lineas":[{"texto":"la línea tal cual sale en el ticket","producto_id":"id de la lista o null","nombre":"nombre corto y claro","categoria":"una de: ${CATS.join(", ")}","cantidad":número,"por_peso":true o false,"precio_unitario":número,"importe":número,"ignorar":true o false}]}
Reglas:
- Una entrada por artículo comprado. No incluyas IVA, subtotales, forma de pago, cambio, datos de tarjeta, puntos ni cabeceras.
- importe = lo pagado por esa línea con sus descuentos ya aplicados. Si debajo de un artículo hay una línea de descuento o promoción, réstala a ese artículo y no la pongas como línea aparte.
- Por unidades: cantidad = unidades y precio_unitario = importe / cantidad.
- Al peso: por_peso = true, cantidad = kilos y precio_unitario = precio por kg.
- producto_id: el id del producto de la casa que sea claramente el mismo artículo (ej. "LECHE ENT HACEND 6X1L" → el producto "Leche"). Si no hay una coincidencia clara, null. No fuerces coincidencias.
- nombre: en español, con la primera letra en mayúscula, sin la marca salvo que sea la forma habitual de llamarlo (ej. "Harina PAN"). Si hay producto_id, usa el nombre de ese producto.
- Bolsas, envases retornables y similares: ignorar = true. Todo lo demás: ignorar = false.
- Si el ticket viene en varias fotos que se solapan, no dupliques líneas.
- Números con punto decimal y sin símbolo de moneda.`;

const num = (v, d = 2) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  if (!isFinite(n)) return null;
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en Vercel." });

  // Solo usuarios con sesión en la app (así nadie gasta tu saldo de Claude)
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Sin sesión. Vuelve a entrar." });
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return res.status(401).json({ error: "Sesión caducada. Vuelve a entrar." });
  } catch (e) {
    return res.status(502).json({ error: "No se pudo comprobar la sesión." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const files = Array.isArray(body && body.files) ? body.files.slice(0, 4) : [];
  const productos = (Array.isArray(body && body.productos) ? body.productos : [])
    .slice(0, 600).map(p => ({ id: String(p.id), nombre: String(p.nombre || "").slice(0, 80) }));

  const content = [];
  for (const f of files) {
    if (!f || typeof f.data !== "string") continue;
    if (f.type === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } });
    else if (/^image\/(jpeg|png|webp|gif)$/.test(f.type)) content.push({ type: "image", source: { type: "base64", media_type: f.type, data: f.data } });
  }
  if (!content.length) return res.status(400).json({ error: "No llegó ninguna foto válida." });
  content.push({ type: "text", text: `Productos de la casa:\n${JSON.stringify(productos)}\n\nLee el ticket y devuelve solo el JSON.` });

  let j;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content }] })
    });
    j = await r.json();
    if (!r.ok) return res.status(502).json({ error: "Claude: " + ((j && j.error && j.error.message) || r.status) });
  } catch (e) {
    return res.status(502).json({ error: "No se pudo conectar con Claude." });
  }

  const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const clean = text.replace(/```json|```/g, "").trim();
  let data;
  try { data = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)); }
  catch (e) { return res.status(502).json({ error: "No se pudo leer el ticket. Prueba con una foto más nítida." }); }

  const ids = new Set(productos.map(p => p.id));
  const lineas = (Array.isArray(data.lineas) ? data.lineas : []).map(l => ({
    texto: String(l.texto || "").slice(0, 120),
    producto_id: ids.has(String(l.producto_id)) ? String(l.producto_id) : null,
    nombre: String(l.nombre || l.texto || "Producto").slice(0, 60),
    categoria: CATS.includes(l.categoria) ? l.categoria : "Otros",
    cantidad: num(l.cantidad, 3) || 1,
    por_peso: !!l.por_peso,
    precio_unitario: num(l.precio_unitario),
    importe: num(l.importe),
    ignorar: !!l.ignorar
  })).filter(l => l.importe != null || l.precio_unitario != null);

  return res.status(200).json({
    tienda: String(data.tienda || "").slice(0, 60),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(data.fecha)) ? data.fecha : null,
    total: num(data.total),
    lineas
  });
};
