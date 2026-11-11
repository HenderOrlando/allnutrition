'use client';
import { OrdersList } from './AdminLists';
import ImportWizard from './ImportWizard';
import ShipmentsWorkspace from './ShipmentsWorkspace';
import WorkspaceTabs from './WorkspaceTabs';

const tabs=[{id:'list',label:'Pedidos'},{id:'shipments',label:'Envíos'},{id:'imports',label:'Importar Excel'}];
export default function OrdersWorkspace({api,view,onViewChange,onNavigate,resource,onCreate,onEdit,onRetry,onInteractionStateChange,onCreateProduct,onMutation,assistantOpenRequest,onAssistantOpenHandled}){
  const tab=view.tab||'list';
  return <>
    <WorkspaceTabs label="Vistas de pedidos" items={tabs} value={tab} onChange={key=>{if(key!==tab)onViewChange({tab:key,batch:undefined,record:undefined,q:'',status:'',paymentStatus:'',issue:'',source:'',platform:'',carrier:'',seller:'',product:'',page:1});}}/>
    {tab==='imports'?<ImportWizard api={api} view={view} onViewChange={onViewChange} onNavigate={onNavigate} onInteractionStateChange={onInteractionStateChange} onCreateProduct={onCreateProduct} onMutation={onMutation} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={onAssistantOpenHandled}/>:tab==='shipments'?<ShipmentsWorkspace api={api} view={view} onViewChange={onViewChange} onEdit={onEdit} onInteractionStateChange={onInteractionStateChange} onMutation={onMutation} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={onAssistantOpenHandled}/>:<OrdersList resource={resource} view={view} onViewChange={onViewChange} onCreate={onCreate} onEdit={onEdit} onRetry={onRetry}/>}
  </>;
}
