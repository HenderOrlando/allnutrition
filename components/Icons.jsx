export default function Icon({name,size=20,...props}){
 const paths={arrow:<path d="M4 12h15M13 5l7 7-7 7"/>,chat:<><path d="M21 11.5a9 9 0 0 1-13.2 8L3 21l1.5-4.8A9 9 0 1 1 21 11.5Z"/><path d="M8 8c0 4 2 6 6 7l2-2-3-1-1 1-2-2 1-1-1-3Z"/></>,grid:<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,box:<><path d="m12 2 9 5v10l-9 5-9-5V7Z M3 7l9 5 9-5 M12 12v10 M7 4.8l10 5.4"/></>,edit:<><path d="m15 4 5 5-10 10-6 1 1-6Z M13 6l5 5"/></>,plus:<path d="M12 4v16M4 12h16"/>,search:<><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,check:<path d="m4 12 5 5L20 6"/>,close:<path d="m5 5 14 14M19 5 5 19"/>,external:<><path d="M14 3h7v7M21 3 10 14M11 3H3v18h18v-8"/></>,truck:<><path d="M3 5h12v12H3ZM15 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,chevron:<path d="m8 5 7 7-7 7"/>,lock:<><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></>,sun:<><circle cx="12" cy="12" r="4"/><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2"/></>,
 home:<><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/></>,
 receipt:<><path d="M5 3h14v18l-3-2-4 2-4-2-3 2ZM9 7h6M9 11h6M9 15h3"/></>,
 wallet:<><path d="M20 8V5H5a2 2 0 0 1 0-4h13M5 5a2 2 0 0 0-2 2v13h17V8ZM16 11h5v6h-5a3 3 0 0 1 0-6Z"/><path d="M17 14h.01"/></>,
 chart:<><path d="M3 3v18h18M7 16v-5M12 16V7M17 16V4"/></>,
 settings:<><path d="m9 3-.6 2.4-2.2 1.3-2.4-.7-2 3.5 1.8 1.7v2.6L1.8 15l2 3.5 2.4-.7 2.2 1.3L9 21h6l.6-1.9 2.2-1.3 2.4.7 2-3.5-1.8-1.2v-2.6l1.8-1.7-2-3.5-2.4.7-2.2-1.3L15 3Z"/><circle cx="12" cy="12" r="3"/></>,
 users:<><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 14 0v2M16 3a4 4 0 0 1 0 8M18 14a6 6 0 0 1 4 5v2"/></>,
 menu:<path d="M4 6h16M4 12h16M4 18h16"/>,
 logout:<><path d="M10 3H3v18h7M8 12h13M16 7l5 5-5 5"/></>,
 cart:<><path d="M2 3h3l3 12h12l2-9H6M9 19h.01M19 19h.01"/><circle cx="9" cy="20" r="1"/><circle cx="19" cy="20" r="1"/></>,
 moon:<path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z"/>
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]||paths.grid}</svg>;
}
