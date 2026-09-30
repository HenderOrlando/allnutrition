'use client';

import { useCallback, useEffect, useState } from 'react';
import Icon from './Icons';

export default function UserManagement({ api }) {
  const [users, setUsers] = useState([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await api('/api/admin/users');
      setUsers(result.users);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (password !== confirmation) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      const result = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, role: 'administrator' }),
      });
      setEmail('');
      setPassword('');
      setConfirmation('');
      setNotice(`Cuenta ${result.user.email} creada con rol Administrador.`);
      await load();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="user-management-page">
    <section className="user-management-card" aria-labelledby="add-user-heading">
      <p className="eyebrow">ACCESO AL PANEL</p>
      <h2 id="add-user-heading">Agregar usuario</h2>
      <p className="muted">Crea una cuenta administrativa adicional para una persona de confianza.</p>
      <div className="user-role-summary"><span>Rol único disponible</span><strong>Administrador</strong></div>
      <form className="user-management-form" onSubmit={submit}>
        <label>Correo electrónico
          <input type="email" autoComplete="email" maxLength={254} required disabled={busy} value={email} onChange={event => setEmail(event.target.value)} />
        </label>
        <label>Contraseña inicial
          <input type="password" autoComplete="new-password" minLength={14} maxLength={200} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} aria-describedby="user-password-help" />
        </label>
        <p id="user-password-help" className="small muted">Usa entre 14 y 200 caracteres. Compártela con la persona por un canal seguro.</p>
        <label>Confirmar contraseña
          <input type="password" autoComplete="new-password" minLength={14} maxLength={200} required disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="success" role="status">{notice}</p>}
        <button className="button primary" disabled={busy}>{busy ? 'Creando…' : 'Crear usuario'}<Icon name="plus" size={16} /></button>
      </form>
    </section>
    <section className="user-management-card" aria-labelledby="users-list-heading">
      <p className="eyebrow">CUENTAS CON ACCESO</p>
      <h2 id="users-list-heading">Usuarios registrados</h2>
      <p className="muted">Todas las cuentas actuales tienen acceso de administrador.</p>
      {loading ? <p className="small muted">Cargando usuarios…</p> : users.length === 0 ? <p className="small muted">No hay usuarios registrados.</p> :
        <div className="user-table-scroll"><table className="user-management-table">
          <thead><tr><th scope="col">Correo</th><th scope="col">Rol</th><th scope="col">Estado</th></tr></thead>
          <tbody>{users.map(user => <tr key={user.id}><td>{user.email}</td><td>Administrador</td><td>{user.active ? 'Activo' : 'Desactivado'}</td></tr>)}</tbody>
        </table></div>}
    </section>
  </div>;
}
