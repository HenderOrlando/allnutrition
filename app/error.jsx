'use client';
export default function ErrorPage({reset}){return <main className="empty-page"><h1>No pudimos cargar la página.</h1><p>Revisa la conexión o consulta al responsable técnico.</p><button className="button primary" onClick={reset}>Volver a intentar</button></main>;}
