import finance from './FinanceExperience.module.css';
import styles from './AdvertisingWorkspace.module.css';

const topics = [
  {
    id: 'start', title: 'Empezar y guardar una idea',
    steps: [
      'Elige Crear publicación; puedes empezar sin cuenta conectada ni archivo.',
      'Pon un nombre reconocible para encontrar la idea después.',
      'Usa Guardar borrador y retómalo cuando quieras; la cuenta y la imagen o video pueden añadirse después.',
    ],
    example: 'Creatina · noviembre · Instagram',
  },
  {
    id: 'prepare', title: 'Preparar y aprobar',
    steps: [
      'Recorre los cinco pasos para elegir cuenta, objetivo, imagen o video, texto y destinos; Continuar no guarda.',
      'Revisa la configuración y consulta una estimación: sus fuentes están separadas y los datos faltantes no son promesas.',
      'Guardar borrador no publica: aprobar una publicación sin inversión sí autoriza publicarla; aprobar un anuncio pagado solo lo prepara, sin activar gasto.',
    ],
  },
  {
    id: 'organize', title: 'Encontrar y organizar',
    steps: [
      'En Publicaciones, busca por nombre y combina tipo y estado; Más filtros ofrece Red y Objetivo.',
      'Los chips muestran los criterios aplicados: quita uno sin perder los demás o usa Limpiar filtros; busca imágenes y videos por nombre y estado en su biblioteca.',
      'Espera Lista para usar y revisa Ver archivo antes de elegirlo; archivar conserva historia y archivos, no borra ni libera espacio.',
    ],
  },
  {
    id: 'connect', title: 'Conectar una cuenta',
    steps: [
      'En Cuentas conectadas, elige un método disponible: Conectar con Facebook autoriza desde Facebook sin introducir la contraseña en este panel.',
      'Para acceso asistido se necesita permiso previo de Meta: usa Crear conexión y abrir acceso, inicia sesión personalmente en el visor privado y resuelve los desafíos; la sesión se conserva cifrada.',
      'Elige página y cuenta de anuncios y comprueba sus capacidades; si falta configuración, debe revisarla el administrador y puedes guardar borradores mientras tanto, sin sustitución automática de método.',
    ],
  },
  {
    id: 'investment', title: 'Controlar inversión y pendientes',
    steps: [
      'Revisa presupuesto total, moneda y fechas: no es un presupuesto diario ni dinero ya gastado o pagado.',
      'Preparar el anuncio no activa inversión; activar y reanudar requieren otra autorización expresa, y una pausa solicitada solo detiene gasto cuando Meta la confirma.',
      'Ante incertidumbre usa Comprobar estado en Meta sin reenviar; no repitas una publicación incierta y, sin acceso válido para pausarla, detén los anuncios directamente en Meta.',
    ],
    example: 'Un presupuesto total de 50.000 COP no significa que ya gastaste ni pagaste 50.000 COP.',
  },
  {
    id: 'results', title: 'Entender resultados y mejorar',
    steps: [
      'En Resultados revisa fuente, período, moneda y cobertura; no disponible o desactualizado no equivale a cero ni las personas se suman entre redes.',
      'Presupuesto autorizado, gasto reportado por Meta, gastos vinculados y pagos son magnitudes distintas; los vínculos con pedidos no prueban que la publicidad causó las ventas.',
      'Actualizar vista solo lee datos locales; Pedir actualización a Meta solicita datos al proveedor y Crear borrador con esta idea prepara una revisión nueva, sin publicar ni autorizar inversión.',
    ],
  },
];

const firstTopic = { assets: 'organize', connections: 'connect', results: 'results' };

export default function AdvertisingGuide({ tab = 'campaigns' }) {
  const first = firstTopic[tab];
  const ordered = first ? [topics.find(topic => topic.id === first), ...topics.filter(topic => topic.id !== first)] : topics;
  return <details className={styles.guide}>
    <summary>Cómo usar Publicidad</summary>
    <p className={finance.guideRoutine}>Guarda una idea, prepárala cuando quieras y revisa antes de autorizar. Abre solo el tema que necesites.</p>
    <p>Leer esta guía no guarda, publica ni autoriza inversión.</p>
    {ordered.map(topic => <details className={finance.guideTopic} key={topic.id}>
      <summary>{topic.title}</summary>
      <ol>{topic.steps.map(step => <li key={step}>{step}</li>)}</ol>
      {topic.example && <p><strong>Ejemplo ficticio:</strong> {topic.example}</p>}
    </details>)}
    <section className={finance.glossary} aria-label="Glosario de Publicidad">
      <h2>Glosario breve</h2>
      <dl>
        <dt>Publicación sin inversión (orgánica)</dt><dd>Contenido publicado sin comprar distribución en la red, sin alcance garantizado.</dd>
        <dt>Anuncio pagado (pauta)</dt><dd>Contenido cuya distribución usa un presupuesto y necesita autorización separada para activar gasto.</dd>
        <dt>Borrador</dt><dd>Idea guardada que puedes completar y revisar, sin autorización para publicar o gastar.</dd>
        <dt>Presupuesto total</dt><dd>Importe autorizado para el intervalo completo, distinto del gasto reportado y de los pagos.</dd>
        <dt>Alcance frente a impresiones</dt><dd>Alcance son personas únicas según la consulta de la red; impresiones son veces que se mostró, incluidas repeticiones.</dd>
        <dt>Comprobación de estado sin reenviar (reconciliación)</dt><dd>Consulta para aclarar qué ocurrió en Meta sin repetir la intención original de publicación o activación.</dd>
      </dl>
    </section>
  </details>;
}
