import styles from './FinanceExperience.module.css';

const topics = [
  {
    id: 'consult',
    title: 'Consultar un informe',
    steps: [
      'Elige Datos actuales, el área del informe y el período que quieres consultar.',
      'La fecha de referencia debe estar dentro del período que quieres revisar. Lee el rango y el corte de los datos antes de interpretar las cifras.',
      'Consultar no guarda una copia ni cambia los datos del negocio.',
    ],
  },
  {
    id: 'figures',
    title: 'Entender las cifras',
    steps: [
      'Distingue ventas, resultado y caja: vender no significa haber cobrado, y el resultado no es el dinero disponible.',
      'Lee los avisos de datos por completar. Un dato desconocido no equivale a cero y un subtotal conocido no es necesariamente el resultado final.',
      'Abre Ver registros para revisar de dónde viene una cifra. Usa Cerrar detalle para volver al resumen del área.',
    ],
    example: 'Un subtotal conocido de 80.000 COP con un costo pendiente no es un resultado final de 80.000 COP.',
  },
  {
    id: 'filters',
    title: 'Organizar con filtros',
    steps: [
      'Abre Filtrar resultados y elige los criterios que necesitas. Comprueba los chips visibles para saber qué limita la consulta.',
      'Quita un criterio con su botón o usa Limpiar filtros para consultar todo el período. Los filtros de una copia guardada son de solo lectura.',
      'La cuenta de caja o banco solo afecta caja y pagos, no las ventas. Los nombres de los catálogos pueden ser actuales; las cifras y agrupaciones de una copia conservan su historia.',
    ],
  },
  {
    id: 'copies',
    title: 'Guardar y encontrar copias',
    steps: [
      'Desde Datos actuales, usa Guardar copia. La solicitud inicia una preparación: espera su resultado, no significa que la copia ya esté lista.',
      'Busca en Informes guardados con el mismo período y los mismos filtros. Abre la versión que quieras revisar; cada una conserva su historia.',
      'Consulta los datos actuales de ese período antes de pedir una nueva copia. Si los datos no cambiaron, se conserva la misma versión.',
    ],
    example: 'Dos versiones del mismo mes conservan las cifras que tenía cada una al prepararse. Si solicitas otra copia sin cambios en los datos, no aparece una nueva versión.',
  },
  {
    id: 'download',
    title: 'Descargar y compartir',
    steps: [
      'Usa Descargar Excel para crear un archivo completo con las hojas Resumen, Detalle y Definiciones. Los importes están en COP.',
      'El archivo incluye todas las áreas del período y filtros elegidos, no solo la pestaña abierta ni una sola página de registros.',
      'Si descargas desde una copia guardada, el archivo mantiene las cifras de esa versión.',
    ],
  },
];

const savedTopics = [topics[3], ...topics.filter(topic => topic.id !== 'copies')];

export default function ReportsGuide({ mode = 'live', isSnapshot = false }) {
  const orderedTopics = mode === 'saved' ? savedTopics : topics;

  return (
    <details className={styles.reportHelp}>
      <summary>Cómo usar Informes</summary>
      <p className={styles.guideRoutine}>
        Elige el período y los filtros, revisa las cifras y sus pendientes, y guarda o descarga cuando lo necesites.
      </p>
      <p>Abre el tema que necesites. Leer esta guía no cambia datos, solicita copias ni guarda progreso.</p>
      {isSnapshot && <p>Estás leyendo una copia: sus cifras no cambian al consultar datos actuales.</p>}
      {orderedTopics.map(topic => (
        <details className={styles.guideTopic} key={topic.id}>
          <summary>{topic.title}</summary>
          <ol>{topic.steps.map(step => <li key={step}>{step}</li>)}</ol>
          {topic.example && <p><strong>Ejemplo ficticio:</strong> {topic.example}</p>}
        </details>
      ))}
      <section className={styles.glossary} aria-label="Glosario de Informes">
        <h2>Glosario breve</h2>
        <dl>
          <dt>Devengado</dt><dd>Importe generado aunque no se haya pagado.</dd>
          <dt>Cobertura</dt><dd>Cuántos registros tienen los datos necesarios para una cifra.</dd>
          <dt>Versión</dt><dd>Copia conservada de un período y filtros.</dd>
          <dt>Corte</dt><dd>Fecha y hora hasta la que se tomaron los datos.</dd>
          <dt>Contribución</dt><dd>Resultado después de los costos directos indicados, antes de otros gastos.</dd>
        </dl>
      </section>
    </details>
  );
}
