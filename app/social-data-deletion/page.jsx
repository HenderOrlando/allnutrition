export const metadata = {
  title: 'Eliminación de datos de Facebook e Instagram',
  description: 'Cómo solicitar la desconexión y eliminación de datos de plataforma almacenados por All Nutrition.'
};

export default function SocialDataDeletionPage() {
  return <main className="wrap" style={{ maxWidth: 850, paddingBlock: 48 }}>
    <a href="/" className="text-link">Volver a All Nutrition</a>
    <h1>Eliminación de datos de Facebook e Instagram</h1>
    <p>Solicita la eliminación al administrador de All Nutrition mediante los canales de contacto publicados en la vitrina. Identifica la conexión o cuenta de negocio que deseas retirar. No envíes contraseñas, cookies, códigos de verificación ni tokens.</p>
    <h2>Qué elimina esta aplicación</h2>
    <p>El administrador desconecta la cuenta y cancela su trabajo local pendiente. Tras confirmar el alcance, elimina sus credenciales o sesión guardada, controles de acceso al navegador, campañas, revisiones, referencias remotas, mediciones, estimaciones y recomendaciones locales. También elimina sus vínculos declarados a pedidos y gastos, sin borrar esos documentos comerciales.</p>
    <p>Se conserva un recibo con administrador, fecha y cantidades eliminadas, sin identificadores de Meta. Las piezas subidas por el usuario y los documentos originales de pedidos, gastos y pagos permanecen en el negocio.</p>
    <h2>Qué no hace la eliminación local</h2>
    <p>No borra publicaciones, anuncios ni información conservada por Facebook o Instagram. Eliminar datos de esta aplicación no demuestra que una campaña haya dejado de gastar. Antes de desconectar, el administrador puede solicitar una pausa y comprobar su estado remoto; si ya no tiene acceso, debe detener los anuncios directamente en Meta.</p>
    <h2>Sesiones y copias de seguridad</h2>
    <p>Las credenciales y cookies se cifran por separado y no se incluyen en las exportaciones comerciales. Una copia física antigua puede contener información previa a la eliminación: debe restaurarse sin publicación habilitada, invalidar las sesiones del navegador y exigir reconexión y reconciliación antes de cualquier nueva operación. La eliminación debe aplicarse también a las copias retenidas conforme a la política del propietario.</p>
  </main>;
}
