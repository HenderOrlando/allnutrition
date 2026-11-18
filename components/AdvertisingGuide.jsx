import finance from './FinanceExperience.module.css';
import styles from './AdvertisingWorkspace.module.css';

const topics = [
  {
    id: 'start', title: 'Empezar y guardar una idea',
    steps: [
      'Elige Crear publicidad y decide entre post sin inversión y campaña pagada.',
      'Busca la referencia exacta por presentación, sabor o SKU. Puedes anunciar solo la marca. Si añades un obsequio a un producto o combo, escribe para qué compra aplica.',
      'Guardar borrador solo requiere un nombre; puedes añadir cuenta, redes y pieza después.',
    ],
    example: 'Conseguir consultas por WhatsApp sobre Dúo Cacao con muestra de vainilla, «Solo con Dúo». La muestra no forma parte del contenido normal del combo.',
  },
  {
    id: 'prepare', title: 'Preparar y aprobar',
    steps: [
      'El recorrido es Qué anunciar → Preparar contenido → Revisar y publicar. Continuar y Anterior no guardan, publican ni solicitan imágenes.',
      'Sube o elige una foto, úsala tal cual si está lista, o prepara una variante con indicaciones. Por ejemplo: «Aclara el fondo, conserva la etiqueta y la condición Solo con Dúo». El original nunca se sustituye automáticamente.',
      'Revisa la oferta exacta, los destinos y la estimación. En orgánico, aprobar autoriza publicar o programar. En pauta, primero se prepara sin activar; autorizar inversión es otra decisión.',
    ],
  },
  {
    id: 'organize', title: 'Encontrar y organizar',
    steps: [
      'En Publicaciones y campañas, busca por nombre; Más filtros ofrece Red y Objetivo.',
      'Desde la tarjeta puedes retomar un borrador, comprobar la publicación o ver el rendimiento de esa pieza.',
      'En Biblioteca, espera Lista para revisar y abre la vista previa. Archivar conserva historia y archivos: no borra ni libera espacio.',
    ],
  },
  {
    id: 'connect', title: 'Conectar una cuenta',
    steps: [
      'En Configuración → Redes sociales, guarda las opciones de Meta y elige un método disponible: Conectar con Facebook autoriza desde Facebook sin introducir la contraseña en este panel.',
      'En esa misma configuración, el acceso asistido requiere permiso previo de Meta: usa Crear conexión y abrir acceso, inicia sesión personalmente en el visor privado y resuelve los desafíos; la sesión se conserva cifrada.',
      'Elige página y cuenta de anuncios y comprueba sus capacidades en Redes sociales; puedes guardar borradores mientras tanto, sin sustitución automática de método. Deshabilitar publicación no confirma detener gasto remoto.',
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
      'Ver rendimiento abre esa pieza. Para el ejemplo de WhatsApp, revisa conversaciones y costo por conversación solo si se reportaron. Cero, sin dato y aún es pronto no significan lo mismo.',
      'Cambiar esta pieza afecta solo el destino comprobable que revisaste; una nueva variante no hereda los comentarios ni resultados. Ambas alternativas requieren aprobación humana y en pauta nunca reactivan gasto.',
      'En Qué aprendimos, compara la misma métrica y período según el criterio de la prueba. Si no hay datos comparables, no se puede aislar la mejora ni atribuir ventas. Actualizar vista solo lee los datos locales.',
    ],
  },
];

const firstTopic = { assets: 'organize', results: 'results' };

export default function AdvertisingGuide({ tab = 'campaigns' }) {
  const first = firstTopic[tab];
  const ordered = first ? [topics.find(topic => topic.id === first), ...topics.filter(topic => topic.id !== first)] : topics;
  return <details className={styles.guide}>
    <summary>Cómo usar Publicidad</summary>
    <p className={finance.guideRoutine}>Crea la pieza, revisa dónde saldrá, mide su objetivo y prueba una mejora cuando los datos la sustenten.</p>
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
