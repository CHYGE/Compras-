// Vercel Serverless Function: lee un ticket con Claude y lo desglosa.
// Variables de entorno en Vercel: ANTHROPIC_API_KEY (obligatoria), CLAUDE_MODEL (opcional).
const SUPABASE_URL = process.env.SUPABASE_URL || "https://whsegvulhumxvxwbfigo.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_uRLpG1zYCDS2k-wqQQ1j1w_1ZImq1gE";
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const CATS = ["Despensa","Nevera","Frutas y verduras","Carnes y pescado","Panadería","Limpieza","Aseo personal","Bebidas","Otros"];

const SYSTEM = `Eres un lector de tickets de supermercado de España. Recibes una o varias fotos (o un PDF) y la lista de productos de una casa.
En las imágenes puede haber UN ticket o VARIOS tickets distintos (por ejemplo, varios tickets juntos en una misma foto). Lee TODOS.
Registra lo leído llamando a la herramienta "registrar_tickets". No escribas nada más.
Reglas:
- Un objeto en "tickets" por cada ticket físico distinto (otra tienda, otra fecha, otra hora, otro número de ticket u otro total = otro ticket). No mezcles líneas de tickets distintos.
- Si un mismo ticket largo sale repartido en varias fotos que se solapan, es UN solo ticket y no dupliques líneas.
- Una línea por artículo comprado. No incluyas IVA, subtotales, forma de pago, cambio, datos de tarjeta, puntos ni cabeceras.
- importe = lo pagado por esa línea con sus descuentos ya aplicados. Si debajo de un artículo hay una línea de descuento o promoción, réstala a ese artículo y no la pongas aparte.
- Por unidades: cantidad = unidades y precio_unitario = importe / cantidad.
- Al peso: por_peso = true, cantidad = kilos y precio_unitario = precio por kg.
- producto_id: el id del producto de la casa que sea claramente el mismo artículo (ej. "LECHE ENT HACEND 6X1L" → el producto "Leche"). Si no hay coincidencia clara, null. No fuerces coincidencias.
- nombre: en español, primera letra en mayúscula, sin la marca salvo que sea la forma habitual de llamarlo (ej. "Harina PAN"). Si hay producto_id, usa el nombre de ese producto.
- Bolsas, envases retornables y similares: ignorar = true. Todo lo demás: ignorar = false.
- Números como número (no texto) y sin símbolo de moneda.`;

const TOOL = {
  name: "registrar_tickets",
  description: "Registra todos los tickets leídos en las imágenes, con sus líneas.",
  input_schema: {
    type: "object",
    properties: {
      tickets: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tienda: { type: "string" },
            fecha: { type: ["string", "null"], description: "AAAA-MM-DD" },
            total: { type: ["number", "null"] },
            lineas: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  texto: { type: "string" },
                  producto_id: { type: ["string", "null"] },
                  nombre: { type: "string" },
                  categoria: { type: "string", enum: CATS },
                  cantidad: { type: "number" },
                  por_peso: { type: "boolean" },
                  precio_unitario: { type: ["number", "null"] },
                  importe: { type: ["number", "null"] },
                  ignorar: { type: "boolean" }
                },
                required: ["texto", "nombre", "cantidad", "importe"]
              }
            }
          },
          required: ["lineas"]
        }
      }
    },
    required: ["tickets"]
  }
};

const num = (v, d = 2) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d,.\-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
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
  content.push({ type: "text", text: `Productos de la casa:\n${JSON.stringify(productos)}\n\nLee todos los tickets y regístralos con la herramienta.` });

  let j;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, system: SYSTEM, tools: [TOOL], tool_choice: { type: "tool", name: "registrar_tickets" }, messages: [{ role: "user", content }] })
    });
    j = await r.json();
    if (!r.ok) return res.status(502).json({ error: "Claude: " + ((j && j.error && j.error.message) || r.status) });
  } catch (e) {
    return res.status(502).json({ error: "No se pudo conectar con Claude." });
  }

  let data = null;
  const tool = (j.content || []).find(b => b.type === "tool_use" && b.name === "registrar_tickets");
  if (tool && tool.input) data = tool.input;
  else {
    const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    try { data = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)); } catch (e) {}
    if (!data) {
      console.error("Respuesta sin formato:", j.stop_reason, text.slice(0, 500));
      return res.status(502).json({ error: "Claude no devolvió los datos del ticket (" + (j.stop_reason || "sin motivo") + "). Inténtalo otra vez." });
    }
  }
  const ids = new Set(productos.map(p => p.id));
  const limpiar = t => ({
    tienda: String(t.tienda || "").slice(0, 60),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(t.fecha)) ? t.fecha : null,
    total: num(t.total),
    lineas: (Array.isArray(t.lineas) ? t.lineas : []).map(l => ({
      texto: String(l.texto || "").slice(0, 120),
      producto_id: ids.has(String(l.producto_id)) ? String(l.producto_id) : null,
      nombre: String(l.nombre || l.texto || "Producto").slice(0, 60),
      categoria: CATS.includes(l.categoria) ? l.categoria : "Otros",
      cantidad: num(l.cantidad, 3) || 1,
      por_peso: !!l.por_peso,
      precio_unitario: num(l.precio_unitario),
      importe: num(l.importe),
      ignorar: !!l.ignorar
    })).filter(l => l.importe != null || l.precio_unitario != null)
  });
  const lista = Array.isArray(data.tickets) ? data.tickets : (Array.isArray(data.lineas) ? [data] : []);
  const tickets = lista.map(limpiar).filter(t => t.lineas.length);
  return res.status(200).json({ tickets });
};
