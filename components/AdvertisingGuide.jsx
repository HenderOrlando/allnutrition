import finance from './FinanceExperience.module.css';
import styles from './AdvertisingWorkspace.module.css';

const topics = [
  {
    id: 'start', title: 'Empezar y guardar una idea',
    steps: [
      'Pulsa Crear publicación o campaña. En el Estudio visual, usa Adjuntar foto o video, Elegir de biblioteca o describe una idea. Para subir o elegir un archivo no necesitas IA ni una cuenta de Meta.',
      'Usar esta pieza y continuar elige el archivo que acabas de revisar. Si todavía no tienes una imagen, usa Definir primero, sin imagen aún. Después elige Publicación sin inversión o Anuncio pagado.',
      'En Definir publicación puedes anunciar solo la marca o elegir una oferta del catálogo por presentación, sabor o SKU. Guardar borrador te permite retomar el trabajo sin publicar ni autorizar gasto.',
    ],
    example: 'Conseguir consultas por WhatsApp sobre Dúo Cacao con muestra de vainilla, «Solo con Dúo». La muestra no forma parte del contenido normal del combo.',
  },
  {
    id: 'prepare', title: 'Preparar y aprobar',
    steps: [
      'En Definir publicación elige objetivo, oferta, mensaje, cuenta, redes y países. En una publicación sin inversión, los países orientan el mensaje: no limitan ni garantizan la distribución.',
      'Si generas o ajustas una imagen, revisa los datos y fotos que se enviarán a OpenAI y autoriza el posible cargo de cada solicitud. El original se conserva y un envío incierto no se repite.',
      'Para un anuncio pagado, confirma los países antes de definir la audiencia. Elige público amplio sin IA, configúralo tú o solicita ayuda a Ali con su autorización separada. Elegir zonas no incluye todo el país.',
      'Pulsa Continuar a revisión. En Qué falta antes de aprobar, cada acción te lleva al campo pendiente o a la configuración que corresponde. Después revisa la pieza por red y consulta la estimación.',
      'Aprobar sin publicar y Preparar sin activar no envían la publicación ni autorizan inversión. Después usa Publicar, Programar o Autorizar inversión, según corresponda.',
    ],
  },
  {
    id: 'organize', title: 'Encontrar y organizar',
    steps: [
      'En Publicaciones y campañas, busca por nombre; Más filtros ofrece Red y Objetivo.',
      'Mis piezas en curso reabre tus conversaciones privadas. Quien colabora en un borrador puede revisar su pieza comercial, no leer tu conversación.',
      'La tarjeta indica el siguiente paso: retomar un borrador, revisar la autorización, comprobar en Meta sin reenviar o ver resultados cuando se confirme la entrega.',
      'En Biblioteca, espera Lista para revisar y abre la vista previa. Archivar conserva historia y archivos: no borra ni libera espacio.',
    ],
  },
  {
    id: 'connect', title: 'Conectar una cuenta',
    steps: [
      'En Configuración → Redes sociales, completa las opciones requeridas para tu vía. Conectar con Facebook abre la autorización oficial; no introduzcas tu contraseña en este panel.',
      'En Cuentas conectadas, abre la cuenta y elige Seleccionar página y cuenta. Comprueba que la página, Instagram o la cuenta de anuncios elegidas aparezcan con el permiso que necesitas. Un token manual solo permite consultar.',
      'Para publicar, revisa también que esté habilitada la publicación en las opciones de Meta. Si usas acceso asistido, este requiere permiso previo de Meta y que completes personalmente el acceso o el desafío en el visor privado. No se cambia de método automáticamente.',
    ],
  },
  {
    id: 'investment', title: 'Controlar inversión y pendientes',
    steps: [
      'Revisa presupuesto total, moneda y zona de la cuenta, no de los países elegidos. No es un presupuesto diario ni dinero ya gastado o pagado.',
      'Preparar no activa inversión. Para activar o reanudar, confirma el importe restante comprobado y las fechas originales. Solicitar una pausa no acredita que el gasto se detuvo.',
      'Ante incertidumbre usa Comprobar en Meta sin reenviar; no repitas el envío original. Sin acceso válido para pausarlo, detén el anuncio directamente en Meta.',
    ],
    example: 'Un presupuesto total de 50.000 COP no significa que ya gastaste ni pagaste 50.000 COP.',
  },
  {
    id: 'results', title: 'Entender resultados y mejorar',
    steps: [
      'Ver resultados abre la pieza y la métrica de su objetivo. Para WhatsApp, revisa conversaciones y costo por conversación solo si se reportaron. Cero, sin dato y aún es pronto no significan lo mismo.',
      'Abre la captura citada para comprobar qué provocó la sugerencia. Cambiar aquí afecta solo el destino comprobable que revisaste; Preparar una variante conserva el original y no transfiere comentarios ni métricas.',
      'En Qué aprendimos, compara la misma métrica y período según el criterio de la prueba. Actualizar vista solo lee datos locales; Actualizar desde Meta solicita una captura y Revisar mejoras, un análisis local. Medición de la cuenta lleva a fuentes e historial, separados de la publicación.',
    ],
  },
];

const firstTopic = { assets: 'organize', results: 'results' };

export default function AdvertisingGuide({ tab = 'campaigns', onConnections }) {
  const first = firstTopic[tab];
  const ordered = first ? [topics.find(topic => topic.id === first), ...topics.filter(topic => topic.id !== first)] : topics;
  return <details id="advertising-guide" className={styles.guide}>
    <summary>Cómo usar Publicidad</summary>
    <p className={finance.guideRoutine}>Empieza donde estés: crear, resolver un requisito o entender lo que reportó Meta.</p>
    <p>Leer la guía no guarda, publica ni autoriza inversión.</p>
    {ordered.map(topic => <details className={finance.guideTopic} key={topic.id}>
      <summary>{topic.title}</summary>
      <ol>{topic.steps.map(step => <li key={step}>{step}</li>)}</ol>
      {topic.id === 'connect' && onConnections && <div className={styles.actions}><button type="button" className="button subtle" onClick={onConnections}>Abrir Configuración → Redes sociales</button></div>}
      {topic.example && <p><strong>Ejemplo ficticio:</strong> {topic.example}</p>}
    </details>)}
    <section className={finance.glossary} aria-label="Glosario de Publicidad">
      <h2>Glosario breve</h2>
      <dl>
        <dt>Publicación sin inversión (orgánica)</dt><dd>Contenido publicado sin comprar distribución en la red, sin alcance garantizado.</dd>
        <dt>Mercado</dt><dd>País o países elegidos para orientar el mensaje. En pauta se cubren solo con los países completos o las zonas verificadas que hayas seleccionado.</dd>
        <dt>Anuncio pagado (pauta)</dt><dd>Contenido cuya distribución usa un presupuesto y necesita autorización separada para activar gasto.</dd>
        <dt>Borrador</dt><dd>Idea guardada que puedes completar y revisar, sin autorización para publicar o gastar.</dd>
        <dt>Presupuesto total</dt><dd>Importe autorizado para el intervalo completo, distinto del gasto reportado y de los pagos.</dd>
        <dt>Alcance frente a impresiones</dt><dd>Alcance son personas únicas según la consulta de la red; impresiones son veces que se mostró, incluidas repeticiones.</dd>
        <dt>Comprobación de estado sin reenviar (reconciliación)</dt><dd>Consulta para aclarar qué ocurrió en Meta sin repetir la intención original de publicación o activación.</dd>
      </dl>
    </section>
  </details>;
}
