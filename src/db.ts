import './env.js';
import pg from 'pg';

// Pool contra Neon (connection string pooled, sslmode=require en la URL).
// Serverless-friendly: pocas conexiones por instancia.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

// Neon corta las conexiones ociosas del pooler. pg emite ese corte como evento
// `error` del Pool y, sin listener, Node lo trata como excepción no capturada y
// MATA el proceso — aunque el pool ya se recuperó solo descartando el cliente
// roto. Pasó de verdad: tumbó un backfill de la sync a mitad de camino.
// Loguear y seguir; el próximo query abre una conexión nueva.
pool.on('error', err => {
  console.error('[db] conexión ociosa caída (el pool se recupera solo):', err.message);
});
