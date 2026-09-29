import { emptyRecord } from './schema.mjs';
export async function seed(store) {
 if((await store.list('products')).length||(await store.list('catalogs')).length)return false;
 const cats=['Creatinas','Proteínas','Preentrenos','Aminoácidos'];
 const slugs=['creatinas','proteinas','preentrenos','aminoacidos'];
 const catalogs=[];for (const [i,title] of cats.entries()) catalogs.push(await await store.save('catalogs',{...emptyRecord('catalogs'),title,slug:slugs[i],status:'published',sort:i}));
 await store.save('products',{...emptyRecord('products'),title:'Creatina Monohidrato Vital Force',slug:'creatina-vital-force-70-servicios',status:'published',sort:0,image:'/brand/creatina-vital-force.jpg',presentation:'70 servicios',flavor:'Sin sabor',price:55000,availability:'consult',featured:true,catalogIds:[catalogs[0].id],description:'Creatina monohidrato Vital Force, presentación de 70 servicios, sin sabor. Consulta las condiciones de contraentrega y el costo de envío.'});
 // Copia propuesta, no respuestas adicionales atribuidas al cliente.
 await store.save('messages',{...emptyRecord('messages'),title:'Tu próxima elección empieza aquí.',slug:'mensaje-principal',status:'published',placement:'hero',body:'Explora nuestro catálogo y consulta con el equipo de All Nutrition por WhatsApp.',buttonText:'Hablar por WhatsApp',sort:0});
 await store.save('faqs',{...emptyRecord('faqs'),title:'¿Cómo puedo hacer un pedido?',slug:'como-hacer-un-pedido',status:'draft',answer:'Elige el producto que te interesa y utiliza su botón de WhatsApp. El equipo confirmará disponibilidad, pago y envío antes de cerrar tu pedido.'});
 await store.save('faqs',{...emptyRecord('faqs'),title:'¿Cuánto cuesta el envío?',slug:'costo-del-envio',status:'draft',answer:'Confirmar con All Nutrition las zonas, costos y tiempos antes de publicar.'});
 // No crear pedidos, clientes, precios de combos ni perfiles sociales ficticios.
 return true;
}
