'use client';
import { OrdersList } from './AdminLists';
import ImportWizard from './ImportWizard';
import ShipmentsWorkspace from './ShipmentsWorkspace';
import HekaWorkspace from './HekaWorkspace';
import WorkspaceTabs from './WorkspaceTabs';

const tabs=[{id:'list',label:'Pedidos'},{id:'shipments',label:'Seguimiento de envíos'},{id:'heka',label:'Centro de envíos'},{id:'imports',label:'Importar Excel'}];
export default function OrdersWorkspace({api,view,onViewChange,onNavigate,onShippingPanel,resource,onCreate,onEdit,onRetry,onInteractionStateChange,onCreateProduct,onMutation,assistantOpenRequest,onAssistantOpenHandled,advisorTargetRequest,onAdvisorTargetHandled,advisorSearchRef,catalogRequest,shippingArrival,onShippingRead}){
  const tab=view.tab||'list';
  return <>
    <WorkspaceTabs label="Vistas de pedidos" items={tabs} value={tab} onChange={key=>{if(key!==tab)onViewChange({tab:key,batch:undefined,record:undefined,panel:undefined,orderId:undefined,shipmentId:undefined,preparationId:undefined,q:'',status:'',paymentStatus:'',issue:'',source:'',platform:'',carrier:'',seller:'',product:'',page:1});}}/>
    {tab==='heka'&&<HekaWorkspace api={api} view={view} onNavigate={onNavigate} onPanel={onShippingPanel} onMutation={onMutation} onInteractionStateChange={onInteractionStateChange} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={onAdvisorTargetHandled} catalogRequest={catalogRequest?.view.tab==='heka'?catalogRequest:null} shippingArrival={shippingArrival} onShippingRead={onShippingRead}/>}
    {tab==='imports'?<ImportWizard api={api} view={view} onViewChange={onViewChange} onNavigate={onNavigate} onInteractionStateChange={onInteractionStateChange} onCreateProduct={onCreateProduct} onMutation={onMutation} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={onAssistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={onAdvisorTargetHandled} importReviewRequest={catalogRequest?.importStep?catalogRequest:null}/>
      :tab==='shipments'?<ShipmentsWorkspace api={api} view={view} onViewChange={onViewChange} onNavigate={onNavigate} onEdit={onEdit} onInteractionStateChange={onInteractionStateChange} onMutation={onMutation} assistantOpenRequest={assistantOpenRequest} onAssistantOpenHandled={onAssistantOpenHandled} advisorTargetRequest={advisorTargetRequest} onAdvisorTargetHandled={onAdvisorTargetHandled}/>
      :tab==='list'?<OrdersList resource={resource} view={view} onViewChange={onViewChange} onCreate={onCreate} onEdit={onEdit} onRetry={onRetry} searchRef={advisorSearchRef}/>:null}
  </>;
}
