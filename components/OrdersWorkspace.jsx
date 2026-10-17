'use client';
import { OrdersList } from './AdminLists';
import ImportWizard from './ImportWizard';
import ShipmentsWorkspace from './ShipmentsWorkspace';
export default function OrdersWorkspace({api,view,onViewChange,resource,onCreate,onEdit,onRetry,onInteractionStateChange,onCreateProduct,onMutation}){
  const tab=view.tab||'list';
  return <>
    <nav className="admin-actions workspace-tabs" aria-label="Vistas de pedidos">
      {[['list','Pedidos'],['shipments','Envíos'],['imports','Importar Excel']].map(([key,title])=><button key={key} type="button" className={`button ${tab===key?'primary':'subtle'}`} aria-current={tab===key?'page':undefined} onClick={()=>{if(key!==tab)onViewChange({tab:key,batch:undefined,record:undefined,q:'',status:'',paymentStatus:'',issue:'',source:'',platform:'',carrier:'',seller:'',product:'',page:1});}}>{title}</button>)}
    </nav>
    {tab==='imports'?<ImportWizard api={api} view={view} onViewChange={onViewChange} onInteractionStateChange={onInteractionStateChange} onCreateProduct={onCreateProduct} onMutation={onMutation}/>:tab==='shipments'?<ShipmentsWorkspace api={api} view={view} onViewChange={onViewChange} onEdit={onEdit} onInteractionStateChange={onInteractionStateChange} onMutation={onMutation}/>:<OrdersList resource={resource} view={view} onViewChange={onViewChange} onCreate={onCreate} onEdit={onEdit} onRetry={onRetry}/>}
  </>;
}
