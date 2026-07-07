// Entrypoint Vercel: función serverless que envuelve la app Express.
// vercel.json re-escribe todo el tráfico a /api/index. Sin app.listen() acá.
import app from '../src/app.js';

export default app;
