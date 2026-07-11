// Catálogo ramo → tipos de siniestro del formulario público de pre-denuncias
// (docs/rumbo/17-pre-denuncias.md §4). Vive como DATOS en código — no como
// enum de Postgres: agregar un tipo es editar esta constante, sin migración.
//
// Fuente: taxonomía relevada de la competencia (deep-dive §13.6, ~70 tipos),
// curada: sin "Fast Track" (modalidad de gestión, no evento), labels en
// lenguaje claro, y `publicLabel` del ramo en lenguaje llano ("¿qué bien está
// asegurado?") porque el asegurado común no piensa en ramos.
//
// `bucket` mapea cada tipo específico al enum grueso `claim_type` existente
// (filtros/analytics). El tipo específico se preserva textual: en el intake
// (jsonb) y, al convertir, en claims.tipo_detalle (Slice 2).

export type ClaimBucket =
  'robo' | 'choque' | 'incendio' | 'danos_agua' | 'granizo' | 'cristales' | 'resp_civil' | 'otros';

export interface IntakeTipo {
  code: string;
  label: string;
  bucket: ClaimBucket;
}

export interface IntakeRamo {
  code: string;
  label: string;
  /** Cómo se le pregunta al asegurado ("¿Qué bien está asegurado?"). */
  publicLabel: string;
  tipos: IntakeTipo[];
}

export const INTAKE_CATALOG: IntakeRamo[] = [
  {
    code: 'automotor',
    label: 'Automotor',
    publicLabel: 'Un auto',
    tipos: [
      { code: 'choque', label: 'Choque', bucket: 'choque' },
      { code: 'dano_terceros_personas', label: 'Daño a terceros (peatones, ciclistas, etc.)', bucket: 'resp_civil' },
      { code: 'granizo', label: 'Granizo', bucket: 'granizo' },
      { code: 'incendio', label: 'Incendio', bucket: 'incendio' },
      { code: 'inundacion', label: 'Inundación', bucket: 'danos_agua' },
      { code: 'robo_parcial', label: 'Robo parcial', bucket: 'robo' },
      { code: 'robo_total', label: 'Robo total', bucket: 'robo' },
      { code: 'tormenta_arena', label: 'Tormenta de arena', bucket: 'otros' },
    ],
  },
  {
    code: 'motovehiculo',
    label: 'Motovehículo',
    publicLabel: 'Una moto',
    tipos: [
      { code: 'choque', label: 'Choque', bucket: 'choque' },
      { code: 'incendio', label: 'Incendio', bucket: 'incendio' },
      { code: 'robo_parcial', label: 'Robo parcial', bucket: 'robo' },
      { code: 'robo_total', label: 'Robo total', bucket: 'robo' },
    ],
  },
  {
    code: 'bicicletas',
    label: 'Bicicletas',
    publicLabel: 'Una bicicleta',
    tipos: [{ code: 'robo', label: 'Robo', bucket: 'robo' }],
  },
  {
    code: 'hogar',
    label: 'Hogar',
    publicLabel: 'Mi casa',
    tipos: [
      { code: 'dano_electrico', label: 'Daño eléctrico', bucket: 'otros' },
      { code: 'dano_agua', label: 'Daño por agua', bucket: 'danos_agua' },
      { code: 'dano_climatico', label: 'Daño por fenómenos climáticos', bucket: 'otros' },
      { code: 'incendio_parcial', label: 'Incendio parcial', bucket: 'incendio' },
      { code: 'incendio_total', label: 'Incendio total', bucket: 'incendio' },
      { code: 'robo', label: 'Robo', bucket: 'robo' },
    ],
  },
  {
    code: 'comercio',
    label: 'Integral de comercio',
    publicLabel: 'Mi comercio',
    tipos: [
      { code: 'cristales', label: 'Cristales', bucket: 'cristales' },
      { code: 'danos_agua', label: 'Daños por agua', bucket: 'danos_agua' },
      { code: 'danos_intento_robo', label: 'Daños por intento de robo', bucket: 'robo' },
      { code: 'equipos_electronicos', label: 'Equipos electrónicos', bucket: 'otros' },
      { code: 'hurto', label: 'Hurto', bucket: 'robo' },
      { code: 'incendio', label: 'Incendio', bucket: 'incendio' },
      { code: 'robo_contenido', label: 'Robo de contenido', bucket: 'robo' },
      { code: 'robo_valores', label: 'Robo de valores', bucket: 'robo' },
      { code: 'robo_mercaderia', label: 'Robo de mercadería', bucket: 'robo' },
    ],
  },
  {
    code: 'consorcio',
    label: 'Consorcio',
    publicLabel: 'El edificio (consorcio)',
    tipos: [
      { code: 'accidentes_espacios_comunes', label: 'Accidentes en espacios comunes', bucket: 'otros' },
      { code: 'ascensores', label: 'Ascensores', bucket: 'otros' },
      { code: 'caida_objetos', label: 'Caída de objetos', bucket: 'otros' },
      { code: 'cristales_comunes', label: 'Cristales comunes', bucket: 'cristales' },
      { code: 'danos_electricos', label: 'Daños eléctricos', bucket: 'otros' },
      { code: 'danos_vereda', label: 'Daños en vereda', bucket: 'otros' },
      { code: 'danos_agua', label: 'Daños por agua', bucket: 'danos_agua' },
      { code: 'danos_humo', label: 'Daños por humo', bucket: 'incendio' },
      { code: 'equipos_electronicos', label: 'Equipos electrónicos', bucket: 'otros' },
      { code: 'explosion', label: 'Explosión', bucket: 'incendio' },
      { code: 'rc_terceros', label: 'Responsabilidad civil hacia terceros', bucket: 'resp_civil' },
      { code: 'rc_linderos', label: 'Responsabilidad civil linderos', bucket: 'resp_civil' },
      { code: 'robo_bienes_comunes', label: 'Robo de bienes comunes', bucket: 'robo' },
    ],
  },
  {
    code: 'incendio',
    label: 'Incendio',
    publicLabel: 'Un edificio o industria (seguro de incendio)',
    tipos: [
      { code: 'incendio_parcial', label: 'Incendio parcial', bucket: 'incendio' },
      { code: 'incendio_total', label: 'Incendio total', bucket: 'incendio' },
    ],
  },
  {
    code: 'cristales',
    label: 'Cristales',
    publicLabel: 'Cristales (vidrios asegurados)',
    tipos: [{ code: 'rotura', label: 'Rotura', bucket: 'cristales' }],
  },
  {
    code: 'agro',
    label: 'Granizo / Agro',
    publicLabel: 'El campo (cultivos)',
    tipos: [
      { code: 'dano_inundacion', label: 'Daño por inundación', bucket: 'danos_agua' },
      { code: 'exceso_hidrico', label: 'Exceso hídrico', bucket: 'danos_agua' },
      { code: 'granizo_dano_parcial', label: 'Granizo con daño parcial', bucket: 'granizo' },
      { code: 'granizo_perdida_total', label: 'Granizo con pérdida total', bucket: 'granizo' },
      { code: 'granizo_sobre_cultivo', label: 'Granizo sobre cultivo', bucket: 'granizo' },
      { code: 'helada', label: 'Helada', bucket: 'otros' },
      { code: 'incendio_cultivo', label: 'Incendio de cultivo', bucket: 'incendio' },
      { code: 'incendio_rastrojo', label: 'Incendio de rastrojo', bucket: 'incendio' },
      { code: 'planchado_suelo', label: 'Planchado de suelo', bucket: 'otros' },
      { code: 'resiembra', label: 'Resiembra', bucket: 'otros' },
      { code: 'sequia', label: 'Sequía', bucket: 'otros' },
      { code: 'viento_temporal', label: 'Viento / temporal', bucket: 'otros' },
    ],
  },
  {
    code: 'art',
    label: 'Riesgo del trabajo (ART)',
    publicLabel: 'Trabajadores (ART)',
    tipos: [
      { code: 'accidente_baja_laboral', label: 'Accidente con baja laboral', bucket: 'otros' },
      { code: 'accidente_lugar_trabajo', label: 'Accidente en lugar de trabajo', bucket: 'otros' },
      { code: 'accidente_in_itinere', label: 'Accidente in itinere', bucket: 'otros' },
      { code: 'accidente_esfuerzo_fisico', label: 'Accidente por esfuerzo físico', bucket: 'otros' },
      { code: 'accidente_sin_baja', label: 'Accidente sin baja laboral', bucket: 'otros' },
      { code: 'accidente_vial_laboral', label: 'Accidente vial laboral', bucket: 'otros' },
      { code: 'caida_persona', label: 'Caída de persona', bucket: 'otros' },
      { code: 'divergencia_alta_medica', label: 'Divergencia en alta médica', bucket: 'otros' },
      { code: 'divergencia_incapacidad', label: 'Divergencia en incapacidad', bucket: 'otros' },
      { code: 'divergencia_prestaciones', label: 'Divergencia en prestaciones', bucket: 'otros' },
      { code: 'enfermedad_profesional', label: 'Enfermedad profesional', bucket: 'otros' },
      { code: 'exposicion_sustancias', label: 'Exposición a sustancias', bucket: 'otros' },
      { code: 'fallecimiento_laboral', label: 'Fallecimiento laboral', bucket: 'otros' },
      { code: 'golpe_atrapamiento_corte', label: 'Golpe / atrapamiento / corte', bucket: 'otros' },
      { code: 'incapacidad_temporaria', label: 'Incapacidad laboral temporaria', bucket: 'otros' },
      { code: 'incapacidad_permanente_parcial', label: 'Incapacidad permanente parcial', bucket: 'otros' },
      { code: 'incapacidad_permanente_total', label: 'Incapacidad permanente total', bucket: 'otros' },
      { code: 'quemadura', label: 'Quemadura', bucket: 'otros' },
      { code: 'reagravamiento', label: 'Reagravamiento', bucket: 'otros' },
      { code: 'rechazo_cobertura', label: 'Rechazo de cobertura ART', bucket: 'otros' },
    ],
  },
  {
    code: 'robo',
    label: 'Robo',
    publicLabel: 'Contenido asegurado contra robo',
    tipos: [{ code: 'robo_contenido', label: 'Robo de contenido', bucket: 'robo' }],
  },
];

export function findRamo(code: unknown): IntakeRamo | undefined {
  return INTAKE_CATALOG.find(r => r.code === code);
}

export function findTipo(ramoCode: unknown, tipoCode: unknown): IntakeTipo | undefined {
  return findRamo(ramoCode)?.tipos.find(t => t.code === tipoCode);
}
