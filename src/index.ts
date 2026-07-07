import app from './app.js';

// Entrypoint local / Docker. En Vercel NO se usa (ver api/index.ts).
const port = Number(process.env.PORT ?? 4000);

app.listen(port, () => {
  console.log(`[${process.env.APP_NAME ?? 'api'}] escuchando en http://localhost:${port}`);
});
