'use client';

import styles from './FinanceExperience.module.css';

const topics = [
  {
    id: 'accounts',
    title: 'Empezar y organizar cuentas',
    when: 'Cuando empiezas a usar Caja o necesitas separar los lugares donde está el dinero.',
    steps: [
      'Crea una cuenta por cada lugar real donde guardas dinero: efectivo, banco o billetera. Asigna una persona responsable; no necesita correo, contraseña ni credenciales de acceso.',
      'Registra la fecha y el importe real de apertura, incluso si es 0 COP. La apertura histórica no se edita: revisa estos datos antes de guardar.',
      'Revisa las cuentas predeterminadas que se sugieren en las operaciones. Archiva una cuenta que ya no uses en lugar de borrar su historia; puedes reactivarla desde su configuración.',
    ],
    example: 'Ejemplo ficticio: una caja física abre con 0 COP y una cuenta bancaria con 70.000 COP. Son dos cuentas, no dos responsables con acceso al sistema.',
    changes: 'La apertura registra dinero en esa cuenta y forma parte del saldo. Archivar deja de ofrecerla para nuevas operaciones; no borra movimientos ni elimina su saldo del total registrado.',
    unchanged: 'Crear un responsable no crea un usuario. La apertura no es una venta ni una ganancia.',
    destinations: [
      { label: 'Abrir configuración guiada', section: 'business', tab: 'setup' },
      { label: 'Configurar cuentas', section: 'business', tab: 'accounts' },
    ],
  },
  {
    id: 'balances',
    title: 'Entender los saldos',
    when: 'Para saber qué dinero está registrado hoy y qué obligaciones siguen pendientes.',
    steps: [
      'Lee Disponible en cuentas como el saldo actual registrado, no como ventas ni como ganancia del negocio. Cambiar el período del listado no cambia ese saldo actual.',
      'Separa lo que está por recibir de plataforma: todavía no está disponible. Distingue el gasto, que crea una obligación, del pago, que mueve dinero.',
      'Recuerda que los sueldos pendientes ya están incluidos en gastos por pagar. Un crédito es un saldo a favor por recuperar o compensar; no lo vuelvas a sumar como gasto.',
      'Para consultar un saldo al corte, abre el informe de caja. Un listado vacío solo indica que no hay registros en esa consulta: no demuestra un saldo cero ni ausencia de operaciones históricas.',
    ],
    example: 'Ejemplo ficticio: hay 100.000 COP disponibles, 30.000 COP por recibir y 20.000 COP de gastos pendientes, incluidos 5.000 COP de sueldos. Disponible sigue siendo 100.000 COP; no sumes otra vez los sueldos a los gastos.',
    changes: 'Los cobros, pagos y demás movimientos registrados cambian las cuentas. El informe al corte permite consultar otra fecha.',
    unchanged: 'Cambiar filtros o período no mueve dinero. Los pendientes no se convierten en disponible por aparecer en el resumen.',
    destinations: [{ label: 'Consultar informe al corte', section: 'reports', tab: 'cash' }],
  },
  {
    id: 'income',
    title: 'Registrar lo que entra',
    when: 'Cuando recibes dinero y debes distinguir un cobro de venta de un ingreso no comercial.',
    steps: [
      'Si recibes el pago de una venta, abre el pedido en Pedidos y registra allí el cobro vinculado.',
      'Para un aporte del propietario u otro ingreso no comercial, usa Registrar ingreso en Caja; no lo registres como venta.',
      'Selecciona la cuenta que recibió el dinero, la fecha real, el importe y una referencia que permita reconocerlo. Revisa esos datos antes de guardar.',
    ],
    example: 'Ejemplo ficticio: el propietario aporta 50.000 COP a la caja. Registra un ingreso no comercial de 50.000 COP: aumenta el dinero de esa cuenta, pero no las ventas.',
    changes: 'Un ingreso no comercial registra una entrada en la cuenta elegida. El cobro de un pedido actualiza el pago de esa venta.',
    unchanged: 'Un aporte no aumenta las ventas ni demuestra una ganancia. Leer esta guía no registra ningún ingreso.',
    destinations: [
      { label: 'Ir a Pedidos para cobrar una venta', section: 'orders', tab: 'list' },
      { label: 'Consultar movimientos', section: 'cash', tab: 'movements' },
    ],
  },
  {
    id: 'expenses',
    title: 'Gastos, abonos y sobrepagos',
    when: 'Cuando nace una obligación, pagas una parte o necesitas corregir un gasto o recuperar un crédito.',
    steps: [
      'Registra el importe y la fecha del gasto, su categoría, proveedor y persona responsable. La fecha del gasto y la fecha en que pagas pueden ser distintas.',
      'Elige Dejar pendiente si aún no salió dinero. Solo elige Registrar y pagar ahora si pagaste el gasto completo y selecciona explícitamente cuenta y fecha de pago.',
      'Para un abono, guarda el gasto pendiente y abre Pagar saldo o abono. Cada pago debe reflejar su fecha e importe reales.',
      'Si el gasto estaba mal, corrígelo con un motivo y revisa su historial de pagos. Corregir no registra otro pago.',
      'Si pagaste de más, revisa el crédito. Cuando recuperes ese dinero, registra la recuperación: entra dinero sin restar otra vez el gasto.',
    ],
    example: 'Ejemplo ficticio: un gasto de 20.000 COP recibe un abono de 5.000 COP. Quedan 15.000 COP pendientes y solo salen 5.000 COP de la cuenta.',
    changes: 'Registrar el gasto crea la obligación; pagar o abonar reduce el dinero de la cuenta. Recuperar un crédito registra una entrada real.',
    unchanged: 'Dejar pendiente no mueve dinero. Una corrección conserva la historia y no crea un pago; recuperar un crédito no reduce de nuevo el gasto.',
    destinations: [{ label: 'Consultar gastos y pagos', section: 'cash', tab: 'expenses' }],
  },
  {
    id: 'transfers',
    title: 'Transferir entre cuentas',
    when: 'Cuando el dinero pasa de una cuenta propia a otra, por ejemplo de efectivo a banco.',
    steps: [
      'Usa Transferir y elige dos cuentas activas distintas: una de origen y otra de destino.',
      'Registra la fecha real, el importe trasladado y una referencia para reconocer la operación.',
      'Revisa la salida en origen y la entrada en destino. No simules el traslado con un ingreso y un gasto separados.',
    ],
    example: 'Ejemplo ficticio: trasladas 30.000 COP de Caja a Banco. Caja baja 30.000 COP y Banco sube 30.000 COP; el total entre ambas no cambia.',
    changes: 'Se registran dos movimientos vinculados: una salida y una entrada por el mismo importe.',
    unchanged: 'La transferencia no cambia el total entre cuentas propias ni crea ventas o gastos.',
    destinations: [{ label: 'Consultar movimientos de transferencias', section: 'cash', tab: 'movements' }],
  },
  {
    id: 'settlements',
    title: 'Liquidaciones de plataforma',
    when: 'Para comparar lo declarado por una plataforma con los soportes y el dinero efectivamente recibido.',
    steps: [
      'Configura la plataforma y su cuenta de origen en Configuración → Plataformas. Después registra la declaración de liquidación.',
      'Vincula los cobros y gastos existentes y revisa el bruto menos las retenciones. Conciliar significa comparar y vincular esos soportes, no duplicarlos.',
      'Confirma únicamente lo recibido, con su cuenta y fecha reales. Si llegó solo una parte, registra un abono parcial; lo restante sigue pendiente.',
      'Revisa el signo del neto: un neto cero no produce movimiento y un neto negativo representa una salida. Las diferencias sin soporte quedan pendientes de aclarar.',
    ],
    example: 'Ejemplo ficticio: 122.000 COP brutos − 17.000 COP de deducciones = 105.000 COP netos. Declararlos no recibe dinero; confirmar la recepción de 105.000 COP sí registra la entrada.',
    changes: 'La declaración organiza lo esperado y sus soportes. La recepción confirmada registra el movimiento real según el neto recibido.',
    unchanged: 'Declarar no aumenta el disponible. Una diferencia sin soporte no se considera recibida ni desaparece automáticamente.',
    destinations: [
      { label: 'Consultar liquidaciones', section: 'cash', tab: 'settlements' },
      { label: 'Configurar plataformas', section: 'business', tab: 'platforms' },
    ],
  },
  {
    id: 'payroll',
    title: 'Sueldos, comisiones y anticipos',
    when: 'Para revisar obligaciones con personas y separar lo ganado, los anticipos y el pago nuevo.',
    steps: [
      'Configura los convenios de cada persona en Configuración → Personas antes de preparar el período.',
      'Prepara y revisa el cálculo: la fecha final del corte es exclusiva. Por ejemplo, del 1 de septiembre al 1 de octubre incluye septiembre, no el 1 de octubre.',
      'Confirma la obligación después de revisarla. Preparar, revisar, confirmar y pagar son acciones distintas; confirmar no paga.',
      'Revisa anticipos y créditos antes de pagar. Registra el pago nuevo desde la cuenta y fecha reales, sin descontar dos veces un anticipo.',
    ],
    example: 'Ejemplo ficticio: una persona gana 100.000 COP y ya recibió un anticipo de 20.000 COP. Tras aplicarlo, el pago nuevo es de 80.000 COP, no de 100.000 COP.',
    changes: 'Confirmar registra la obligación correspondiente. Un anticipo o un pago registra la salida real de dinero y se considera al revisar lo pendiente.',
    unchanged: 'Preparar o confirmar no mueve dinero. Este es un control interno, no una nómina legal ni asesoría fiscal.',
    destinations: [
      { label: 'Consultar sueldos y anticipos', section: 'cash', tab: 'payroll' },
      { label: 'Configurar personas y convenios', section: 'business', tab: 'people' },
    ],
  },
  {
    id: 'closing',
    title: 'Cerrar y corregir',
    when: 'Al terminar de contar efectivo o cuando necesitas corregir una operación conservando la historia.',
    steps: [
      'Cuenta el efectivo real y selecciona la cuenta de efectivo y la fecha del cierre. Revisa el saldo esperado para esa cuenta y fecha, no el saldo actual de otra consulta.',
      'Escribe el importe contado y compara la diferencia: faltante, sobrante o sin diferencia. El esperado se vuelve a comprobar al guardar; cerrar conserva la diferencia y no ajusta el dinero.',
      'Las fechas alcanzadas por un cierre quedan bloqueadas. Si debes corregirlas, reabre con un motivo; cuando hay cierres posteriores, reabre primero el cierre posterior.',
      'Para revertir una operación, revisa su origen y registra el motivo. La reversión añade una contrapartida sin borrar el original; los documentos vinculados se revierten completos, no como asientos aislados.',
    ],
    example: 'Ejemplo ficticio: esperado 95.000 COP y contado 94.000 COP dan un faltante de 1.000 COP. Guardar el cierre deja esa comparación registrada, sin retirar ni añadir 1.000 COP a la cuenta.',
    changes: 'El cierre registra el conteo y bloquea las fechas alcanzadas. Reabrir permite corregir con motivo y conserva las revisiones; una reversión añade el registro contrario.',
    unchanged: 'Cerrar no ajusta el saldo automáticamente. Reabrir o revertir no borra la historia original.',
    destinations: [
      { label: 'Consultar cuentas y cierres', section: 'cash', tab: 'overview' },
      { label: 'Consultar movimientos para corregir', section: 'cash', tab: 'movements' },
    ],
  },
];

const firstTopicByTab = {
  overview: 'balances',
  movements: 'income',
  settlements: 'settlements',
  expenses: 'expenses',
  payroll: 'payroll',
};

export default function CashGuide({ tab, onNavigate, disabled = false }) {
  const firstTopic = topics.find(topic => topic.id === (firstTopicByTab[tab] || 'balances'));
  const orderedTopics = [firstTopic, ...topics.filter(topic => topic !== firstTopic)];

  return (
    <details className={styles.cashHelp}>
      <summary>Guía de caja</summary>
      <p className={styles.guideRoutine}>
        Al empezar: revisa saldos y pendientes. Durante el día: registra cada hecho con su fecha real.
        {' '}Al terminar: cuenta el efectivo y registra el cierre.
      </p>
      <p>Abre el tema que necesites. Consultar esta ayuda no registra operaciones ni guarda progreso; sus botones solo te llevan a otra vista.</p>
      {orderedTopics.map(topic => (
        <details className={styles.guideTopic} key={topic.id}>
          <summary>{topic.title}</summary>
          <p><strong>Cuándo usarlo:</strong> {topic.when}</p>
          <ol>{topic.steps.map(step => <li key={step}>{step}</li>)}</ol>
          <p><strong>Ejemplo ficticio.</strong> {topic.example.replace('Ejemplo ficticio: ', '')}</p>
          <p><strong>Qué cambia:</strong> {topic.changes}</p>
          <p><strong>Qué no cambia:</strong> {topic.unchanged}</p>
          <div className={styles.guideNavigation}>
            {topic.destinations.map(({ label, ...destination }) => (
              <button type="button" key={label} disabled={disabled} onClick={() => onNavigate(destination)}>
                {label}
              </button>
            ))}
          </div>
        </details>
      ))}
      <section className={styles.glossary} aria-label="Glosario de caja">
        <h2>Glosario breve</h2>
        <dl>
          <dt>Devengado</dt><dd>Obligación generada aunque no se haya pagado.</dd>
          <dt>Conciliar</dt><dd>Comparar y vincular los soportes.</dd>
          <dt>Retención</dt><dd>Importe descontado por la plataforma.</dd>
          <dt>Crédito</dt><dd>Saldo a favor por recuperar o compensar.</dd>
          <dt>Reversión</dt><dd>Registro contrario que conserva la historia.</dd>
        </dl>
      </section>
    </details>
  );
}
