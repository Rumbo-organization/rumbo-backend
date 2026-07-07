import './env.js';
import pg from 'pg';

// Pool contra Neon (connection string pooled, sslmode=require en la URL).
// Serverless-friendly: pocas conexiones por instancia.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});
