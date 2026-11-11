import { adminHref, readAdminView } from '../admin-view.mjs';
import { schemas, settingsFields } from '../schema.mjs';
import { adminLocationLabel, adminTasks } from '../../components/admin-tasks.mjs';

const byId = new Map(adminTasks.map(task => [task.id, task]));
// These are application instructions, not model-authored text. Stable step keys
// let the engine resolve only the steps actually read during the current turn.
const workflows = {
  home:[['review','Revisa los pendientes y abre la tarea que corresponde. Los accesos del inicio no confirman operaciones.']],
  orders:[['find','Busca el número del pedido o una guía; abre el registro para revisar líneas, cobros y envíos.'],['edit','Para crear un pedido, completa cliente, vendedor, fecha y líneas con productos reales. Revisa cantidades, precios y costos conocidos.'],['save','Revisa el total antes de guardar. Guardar un pedido no acredita un cobro; registra el dinero recibido como una operación separada.']],
  shipments:[['find','Busca la guía y revisa el pedido asociado y el corte de la fuente.'],['metadata','Edita transportadora, guía y fecha estimada en los datos del envío. Revisa las asignaciones de líneas.'],['event','Registra una novedad con su fecha real y motivo. La fecha de registro no sustituye la fecha del evento.']],
  imports:[['source','Selecciona la plataforma y su cuenta de origen; carga un archivo propio en el flujo de importación.'],['mapping','Selecciona las hojas y su propósito, la fila de encabezados, los formatos y los destinos de las columnas.'],['review','Genera la revisión y resuelve errores de identidad, equivalencias y datos faltantes. Revisa la autoridad y el inventario cuando el flujo los solicite.'],['confirm','Acepta la revisión vigente antes de procesar. Ali no carga archivos ni acepta decisiones de identidad, inventario o confirmaciones por ti.']],
  cash:[['accounts','Revisa el saldo de cada cuenta y la fecha del corte. El dinero pendiente de plataformas no es disponible en caja.'],['operation','Abre ingreso, transferencia o cierre según el hecho real. Selecciona cuentas, importe y fecha sin deducirlos del saldo.'],['confirm','Revisa y confirma la operación. Una transferencia genera contrapartidas entre cuentas, no un ingreso nuevo para el negocio.']],
  movements:[['find','Filtra por cuenta, fechas o búsqueda y abre el movimiento para revisar su documento de origen.'],['reverse','Para corregir dinero registrado, usa la reversión del documento correspondiente, con fecha y motivo; no borres el hecho original.']],
  settlements:[['declaration','Selecciona la cuenta de plataforma y revisa los recaudos y deducciones de la liquidación.'],['receipt','Declarar una liquidación no acredita recepción de dinero. Confirma cada abono con cuenta, importe y fecha reales.']],
  expenses:[['record','Registra categoría, concepto, importe y fecha económica del gasto; identifica el pedido o envío cuando corresponda.'],['payment','Pagar un gasto y recuperar un sobrepago son operaciones separadas. Revisa el saldo y la cuenta antes de confirmar.']],
  payroll:[['preview','Selecciona la persona y las fechas inicial y final exclusiva para preparar el período. La preparación solo consulta; no confirma un sueldo ni paga.'],['confirm','Revisa obligaciones, anticipos, créditos y ajustes antes de confirmar el período.'],['payment','Registra el pago desde el período confirmado con la cuenta, importe y fecha reales.']],
  setup:[['cash','Completa la etapa de caja con responsable, cuenta, fecha y saldo de apertura. La confirmación de apertura es humana.'],['product','Prepara el primer producto con nombre, precio y los datos de existencias y costo que conozcas.'],['complete','Sigue las etapas y revisa el diagnóstico. Ali no confirma las políticas ni finaliza la guía por ti.']],
  people:[['person','Registra una persona responsable o vendedora. Esto no crea acceso al panel.'],['agreements','Revisa los convenios de sueldo y comisión con sus fechas de vigencia; los convenios no deben superponerse.'],['save','Comprueba importes, frecuencia y reglas antes de guardar y confirmar sus efectos.']],
  accounts:[['account','Selecciona responsable y tipo de cuenta; completa nombre, fecha y saldo de apertura cuando crees una cuenta.'],['defaults','Revisa las cuentas predeterminadas en las preferencias del negocio. Una cuenta de plataforma no es una cuenta de caja.']],
  platforms:[['platform','Crea o selecciona una plataforma y después su cuenta de origen.'],['profile','Los perfiles de columnas pertenecen a una cuenta de origen; revisa hojas, formatos y destinos antes de reutilizarlos.']],
  social:[['settings','Configura la integración en esta pantalla y conecta las cuentas mediante el flujo humano existente. Nunca escribas claves ni contraseñas en el chat.'],['review','Revisa el estado de conexión. Conectar una cuenta no publica una campaña ni autoriza inversión.']],
  'shipping-integrations':[['connect','Usa el flujo de conexión del complemento local en esta pantalla; no compartas tokens o controles del navegador por chat.'],['review','Revisa las consultas del proveedor y los datos antes de importarlos. Ali solo consulta hechos ya guardados en esta aplicación.']],
  assistant:[['configure','Selecciona proveedor y modelo. Si usas un endpoint propio, introduce la raíz de su API y autoriza explícitamente la red privada solo si corresponde.'],['credential','Introduce la API key únicamente en el campo de configuración. La clave guardada no se muestra ni se envía al chat.'],['enable','Guardar y habilitar comprueba autenticación y herramientas estructuradas; puede consumir una solicitud del proveedor. Los datos necesarios se envían al endpoint seleccionado.']],
  alerts:[['review','Filtra las alertas y abre el registro relacionado para revisar su evidencia y responsable.'],['rule','Edita umbrales y responsables en las reglas. Reconocer una alerta no corrige automáticamente el hecho comercial que la originó.']],
  users:[['review','Consulta las cuentas administrativas y su estado. Todas las cuentas del panel son administradoras.'],['human','Crear acceso, cambiar contraseña o desactivar una cuenta requiere el flujo humano de usuarios; Ali no completa credenciales ni otorga acceso.']],
  settings:[['fields',`Revisa los campos de vitrina: ${settingsFields.filter(field=>!['logo','launchApproved'].includes(field.name)).map(field=>field.label).join(', ')}.`],['publish','La publicación global requiere revisión y confirmación humana; guardar contenido y publicar son decisiones distintas.']],
  'prepare-publication':[['draft','Basta un nombre para guardar un borrador local y retomarlo. Completa texto, modalidad, objetivo y pieza con datos del negocio.'],['human','Selecciona conexiones y activos reales. Derechos, aceptaciones, publicación, programación e inversión se confirman en su flujo humano.'],['save','Guardar un borrador no publica ni autoriza gasto; Ali solo puede preparar cambios locales permitidos.']],
  'advertising-campaigns':[['find','Busca campañas por nombre, modalidad, objetivo, estado o red. Abre la campaña para revisar su borrador y entregas.'],['review','Distingue el estado local del estado confirmado por la red. Ali no publica, programa ni cambia inversión por chat.']],
  'advertising-assets':[['upload','Escribe un nombre y selecciona un archivo propio; confirma los derechos en el formulario. Ali no selecciona archivos ni acepta derechos.'],['processing','Espera la preparación de la pieza y revisa su vista previa privada antes de usarla en un borrador.']],
  'advertising-results':[['selection','Selecciona campaña, alcance, dimensión y período para revisar las capturas persistidas. Un dato faltante no equivale a cero.'],['coverage','Revisa fecha de captura, cobertura, demoras y definiciones. No sumes alcance entre entregas como si estuviera deduplicado.'],['business','Los vínculos con pedidos y gastos son declarados por el administrador; una asociación o correlación no demuestra causalidad ni ganancia.']],
};
const reportTasks=new Set(['reports','sales-report','shipping-report','returns-report','costs-report','payroll-report','cash-report']);
function stepsFor(task) {
  const kind=task.id==='gifts'?'products':task.id;
  let steps=workflows[task.id];
  if(schemas[kind]) {
    const schema=schemas[kind],fields=schema.fields.filter(field=>!['image','sort','status'].includes(field.name));
    steps=[['record',`Abre una ficha existente o crea ${schema.singular}. ${schema.help}`],...fields.map(field=>[`field-${field.name}`,`${field.label}${field.required?' es obligatorio':': revisa el valor registrado'}.`]),['save','Los precios de catálogo se expresan en pesos colombianos. La imagen se selecciona en el formulario. Revisa las relaciones y el estado de publicación antes de guardar.']];
  }
  if(reportTasks.has(task.id)) steps=[['period','Selecciona período y fecha de referencia; aplica los filtros de vendedor, producto, plataforma, transportadora, estado, cuenta u origen que necesites.'],['coverage','Revisa cobertura, subtotales conocidos, exclusiones y corte de datos. Un costo desconocido impide afirmar una ganancia.'],['detail','Abre el detalle de la métrica para ver sus hechos y páginas. Un listado parcial no es un total del negocio.'],['snapshot','Distingue el informe en vivo de una revisión guardada. Una revisión desactualizada conserva su corte original; no la describas como actual.']];
  return [['open',`Abre ${task.label} en ${adminLocationLabel(readAdminView(task.view))}.`],...(steps||[['review',task.description]])].map(([key,text])=>({id:`${task.id}:${key}`,text}));
}
export function getAssistantGuide(taskId) {
  const task=byId.get(taskId);if(!task)return null;
  const view=readAdminView(task.view);
  return {id:task.id,taskId:task.id,title:task.label,description:task.description,action:task.action||null,href:adminHref(view),location:adminLocationLabel(view),group:task.group,steps:stepsFor(task)};
}
export function listAssistantGuideTasks() { return adminTasks.map(task=>getAssistantGuide(task.id)); }
export function getAssistantCurrentLocation(candidate) {
  const view=readAdminView(candidate||{});
  return {view,label:adminLocationLabel(view),href:adminHref(view)};
}
