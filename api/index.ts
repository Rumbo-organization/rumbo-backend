// Entrypoint Vercel: función serverless que envuelve la app Express.
// vercel.json re-escribe todo el tráfico a /api/index. Sin app.listen() acá.
import app from '../src/app.js';

// Techo de ejecución de la función. Lo pide el cron de la sync con San
// Cristóbal: su API tarda ~30 s por póliza (medido en UAT), así que con los
// 10 s por defecto no entra ni una. 60 s es el máximo del plan Hobby; con Pro
// se puede subir a 300 y el cron drena bastante más cola por corrida.
// El job igual se autolimita a 50 s y deja lo que falta encolado.
export const maxDuration = 60;

export default app;
