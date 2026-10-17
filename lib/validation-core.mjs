export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const fail = (message, status = 400) => { throw new AppError(message, status); };
export function text(value, label, max = 1000, required = false) {
  if (typeof value !== 'string') { if (value == null && !required) return ''; fail(`${label}: se esperaba texto.`); }
  const out = value.trim();
  if (required && !out) fail(`${label}: este campo es obligatorio.`);
  if (out.length > max) fail(`${label}: máximo ${max} caracteres.`);
  return out;
}
export function integer(value, label, min = 0, max = 1000000000) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`${label}: usa un número entero entre ${min} y ${max}.`);
  return value;
}
