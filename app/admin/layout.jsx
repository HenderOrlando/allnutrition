import './admin.css';

export const metadata = {
  manifest:'/admin/shipping.webmanifest',
  icons:{ apple:[{ url:'/admin/shipping-icon/192',sizes:'192x192',type:'image/png' }] },
  appleWebApp:{ capable:true,title:'All Nutrition' },
};

export default function AdminLayout({children}) {
  return <div className="admin-theme">{children}</div>;
}
