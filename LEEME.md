# Mercado de casa (PWA)

Estático puro, sin build. Archivos:

- `index.html`: la app
- `config.js`: URL y anon key de Supabase (lo único que hay que editar)
- `supabase.sql`: tablas, RLS y realtime
- `sw.js`, `manifest.webmanifest`, `icons/`: lo que la hace instalable y usable sin conexión
- `vercel.json`: evita que el service worker se quede cacheado

Al cambiar `index.html`, sube `CACHE = "mercado-vN"` en `sw.js` para que los móviles se actualicen.
