// Config mínima para materializar el esquema desde cero (schema.ts → DDL).
// El proyecto normalmente NO usa drizzle-kit (migraciones manuales), pero para
// crear una branch de Neon vacía necesitamos el DDL completo, que solo vive en
// schema.ts. `generate` no toca la base; produce el SQL para revisar y aplicar.
//
// Objeto plano a propósito (sin `defineConfig`): drizzle-kit corre vía npx y su
// módulo no está en el node_modules local, así que no se puede importar acá.
export default {
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './_gen_init',
};
