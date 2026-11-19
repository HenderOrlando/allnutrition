import finance from './FinanceExperience.module.css';
import styles from './AdvertisingWorkspace.module.css';

const topics = [
  {
    id: 'start', title: 'Empezar y guardar una idea',
    steps: [
      'Pulsa Crear publicación o campaña. En el Estudio visual, escribe en Chat creativo para generar o ajustar una imagen; revisa el resultado en Tu pieza. También puedes adjuntar una foto o video o elegirlo en Biblioteca sin IA ni Meta.',
      'Usar esta pieza y continuar elige el archivo revisado. Si todavía no tienes una imagen, pulsa Definir primero, sin imagen aún. Después elige Publicación sin inversión o Anuncio pagado.',
      'En Idea y oferta, decide si publicarás para la marca o para una oferta del catálogo. Guardar borrador conserva el trabajo sin publicar ni autorizar gasto.',
    ],
    example: 'Conseguir consultas por WhatsApp sobre Dúo Cacao con muestra de vainilla, «Solo con Dúo». La muestra no forma parte del contenido normal del combo.',
  },
  {
    id: 'prepare', title: 'Preparar y aprobar',
    steps: [
      'En Destinos, abre Elegir redes o Elegir mercados, marca las opciones y pulsa Aplicar. Cancelar o Escape deja la selección anterior intacta. En una publicación sin inversión, los países orientan el mensaje, no limitan ni garantizan la distribución.',
      'Si generas o ajustas una imagen, revisa los datos y fotos que se enviarán a OpenAI y autoriza el posible cargo de cada solicitud. El original se conserva y un envío incierto no se repite.',
      'Para un anuncio pagado, confirma los países antes de definir la audiencia. Elige público amplio sin IA, configúralo tú o solicita ayuda a Ali con su autorización separada. Elegir zonas no incluye todo el país.',
      'Pulsa Continuar a revisión. En Qué falta antes de aprobar, cada acción te lleva al campo pendiente o a la configuración que corresponde. Después revisa la pieza por red y consulta la estimación.',
      'Aprobar sin publicar y Preparar sin activar no envían la publicación ni autorizan inversión. Después usa Publicar, Programar o Autorizar inversión, según corresponda.',
    ],
  },
  {
    id: 'organize', title: 'Encontrar y organizar',
    steps: [
      'En Publicaciones y campañas, elige Creadas en All Nutrition para buscar publicaciones y borradores propios por nombre, Red u Objetivo en Más filtros.',
      'Mis piezas en curso reabre tus conversaciones privadas. Quien colabora en un borrador puede revisar su pieza comercial, no leer tu conversación.',
      'La tarjeta indica el siguiente paso: retomar un borrador, revisar la autorización, comprobar en Meta sin reenviar o ver resultados cuando se confirme la entrega.',
      'Consultadas en Meta abre el historial de cuenta guardado, de solo lectura. Puedes filtrar por conexión o cuenta y abrir una lectura fechada con sus conjuntos de anuncios. Si hay un vínculo comprobado, Abrir ficha propia lleva al registro que sí puedes gestionar.',
      'En Biblioteca, busca o filtra los archivos guardados. Subir archivo privado abre la carga sin salir de la galería. Abre la ficha y espera Lista para revisar antes de usarlo. Archivar conserva el historial y el archivo; no libera espacio.',
    ],
  },
  {
    id: 'connect', title: 'Conectar una cuenta',
    steps: [
      'En Configuración → Redes sociales, completa las opciones requeridas para tu vía. Conectar con Facebook abre la autorización oficial; no introduzcas tu contraseña en este panel.',
      'En Tus conexiones, pulsa Administrar para elegir página y cuenta o revisar Datos consultados. Desde la ficha puedes abrir las campañas guardadas de esa conexión. Consultar anuncios por fecha es una consulta puntual: no se guarda en el historial.',
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
      'Desde una campaña propia, Ver ficha económica abre su ficha de Resultados. Las campañas consultadas tienen su ficha económica de solo lectura. Separa el punto de equilibrio simulado, lo que reportó Meta para su período y lo que dejaron los pedidos vinculados al corte del negocio. Cero y sin datos no significan lo mismo.',
      'En Qué probar ahora, abre la captura citada directamente desde la propuesta. Cambiar aquí afecta solo el destino que revisaste; Preparar una variante conserva el original y no transfiere comentarios ni métricas.',
      'En Qué aprendimos, compara la misma métrica y período según el criterio de la prueba. Período y filtros cambia qué capturas ves. Actualizar vista solo lee datos locales; Actualizar desde Meta solicita una captura y Revisar mejoras, un análisis local. Medición de la cuenta lleva a fuentes e historial, separados de la publicación.',
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
