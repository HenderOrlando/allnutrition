'use client';
import { useState } from 'react';
/** La imagen se solicita directamente desde el navegador, nunca mediante un proxy de Next.js. */
export default function ImageByUrl({ src, alt = '', onError, ...props }) {
  const [failedSource, setFailedSource] = useState(null);
  const failed = !src || failedSource === src;
  return <img {...props} src={failed ? '/brand/placeholder.svg' : src} alt={alt} referrerPolicy="no-referrer"
    onError={event => { if (!failed) setFailedSource(src); onError?.(event); }} />;
}
