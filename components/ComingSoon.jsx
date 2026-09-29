import ImageByUrl from './ImageByUrl';
import { whatsAppLink } from '@/lib/schema.mjs';
export default function ComingSoon({settings}) {
 return <main className="coming-soon wrap"><ImageByUrl src={settings.logo} alt={settings.brandName} width="110" height="110"/><p className="eyebrow">{settings.brandName}</p><h1>Estamos preparando<br/>nuestro catálogo.</h1><p>{settings.tagline}</p><a className="button primary" href={whatsAppLink(settings)} target="_blank" rel="noopener noreferrer">Consultar por WhatsApp</a><p className="small muted">La vitrina se publicará después de revisar su información.</p></main>;
}
