// Compare the records used by actual tools, not client-declared intent, page labels or catalog search hits.
const scopeId = value => typeof value === 'string' && value.length>0 && value.length<=200 ? value : null;
const scope = (resource, id = null, mode = 'read', unclear = false) => ({resource, id:scopeId(id), mode, unclear});
const cash = ['accounts','movements','settlements','expenses','payroll','closings'];
const commercial = ['orders','shipments','business-settings','people','platforms','sources','campaigns','record:products','account-ledger',...cash];

export const ASSISTANT_ACCESS_WAIT_MESSAGE = 'Otra conversación tiene una acción en curso que usa los mismos datos y al menos una de las acciones implica cambios. Espera a que termine y vuelve a intentarlo.';
const businessResource = {settings:'business-settings',storefront:'storefront-settings'};

export async function assistantReadAccess(tx,{domain,query:{kind,resource,id,record,orderId,campaignId,snapshotId,mode,accountId,account,lookup,deliveryId}}) {
  switch(domain) {
    case 'catalog': {
      const accesses=[scope(kind ? `record:${kind}` : 'record:*',id)];
      if(kind==='combos'||kind==='products'&&id) {
        const row=id&&await tx.db.get(`SELECT data FROM ${tx.t('records')} WHERE kind=? AND id=?`,[kind,id]);
        const data=row?JSON.parse(row.data):null;
        if(kind==='combos'||data?.productType==='gift') {
          if(Array.isArray(data?.items)) for(const item of data.items)accesses.push(scope('record:products',item.productId));
          else accesses.push(scope('record:products',null,'read',Boolean(id)));
        }
      }
      return accesses;
    }
    case 'orders': {
      const accesses=[scope('orders',id,'read',Boolean(lookup))];
      if(id) {
        const shipments=await tx.db.all(`SELECT id FROM ${tx.t('shipments')} WHERE order_id=?`,[id]);
        for(const shipment of shipments)accesses.push(scope('shipments',shipment.id));
        const expenses=await tx.db.all(`SELECT id FROM ${tx.t('expenses')} WHERE order_id=?`,[id]);
        for(const expense of expenses)accesses.push(scope('expenses',expense.id));
      }
      return accesses;
    }
    case 'shipments': {
      const linked=id&&await tx.db.get(`SELECT order_id FROM ${tx.t('shipments')} WHERE id=?`,[id]);
      return [scope('shipments',id),...(linked&&linked.order_id===null?[]:[scope('orders',linked?.order_id||orderId,'read',Boolean(id&&!linked))])];
    }
    case 'cash': {
      if(kind==='closing-preview') return [scope('accounts',accountId),scope('account-ledger',accountId)];
      if(kind==='payroll-preview') return ['payroll','orders','people','business-settings','expenses','account-ledger'].map(key=>scope(key));
      if(!resource||resource==='overview') return ['orders','business-settings','account-ledger',...cash].map(key=>scope(key));
      if(resource==='movements'&&!record&&account)return [scope('account-ledger',account)];
      return [scope(resource,record),...(resource==='movements'&&!record?[scope('account-ledger')]:[])];
    }
    case 'reports': return [...(['snapshot','list'].includes(mode)?[scope('reports',snapshotId)]:[]),...commercial.map(key=>scope(key))];
    case 'recommendations': return [...commercial,'alerts','alert-rules'].map(key=>scope(key));
    case 'business': return [scope(businessResource[resource||'settings']||resource,id)];
    case 'alerts': return [scope(kind==='rules'?'alert-rules':'alerts',id)];
    case 'imports': return [scope('imports',id)];
    case 'advertising': {
      if(kind==='meta-inventory') return [scope('meta-inventory')];
      if(['assets','connections'].includes(kind)) return [scope(kind)];
      if(kind==='operation') return [scope('campaigns')];
      return [scope('campaigns',id||campaignId,'read',kind==='results'&&Boolean(deliveryId)&&!campaignId),...(kind==='business-result'?commercial.filter(key=>key!=='campaigns').map(key=>scope(key)):[])];
    }
    case 'access': return [scope('access')];
    case 'application': return [];
    default: return [scope('*',null,'read',true)];
  }
}

const financePrimary = {
  collection:['orders','orderId'],refund:['orders','orderId'],return:['orders','orderId'],
  'complete-costs':['orders','orderId'],'resolve-legacy-payment':['orders','orderId'],
  'link-shipment':['shipments','shipmentId'],expense:['expenses','expenseId'],
  'pay-expense':['expenses','expenseId'],'expense-recovery':['expenses','expenseId'],
  'settlement-save':['settlements','settlementId'],'settlement-confirm':['settlements','settlementId'],
  'payroll-confirm':['payroll','payrollId'],'payroll-pay':['payroll','payrollId'],
  'cash-reopen':['closings','closingId'],'cash-reverse':['movements','cashEntryId'],
  'account-save':['accounts','accountId'],
};
const referenceResources = {
  order:'orders',shipment:'shipments',account:'accounts',expense:'expenses',settlement:'settlements',
  payroll:'payroll',closing:'closings',entry:'movements',person:'people',platform:'platforms',source:'sources',
  campaign:'campaigns',connection:'connections',asset:'assets',business_settings:'business-settings',
  'alert-rule':'alert-rules',alert:'alerts',
};
const createIntent = /^(?:new|create|crear|nuevo|nueva)$/iu;

// Resolve dependency identities from persisted relationships, not model predictions. This
// reads only scope metadata under the admission transaction, never runs the requested tool.
async function orderEffects(tx,orderId,write,{inventory=true,commission=true}={}) {
  if(!orderId) {
    if(inventory)write('record:products',null,true);
    if(commission)write('expenses',null,true);
    return;
  }
  const row=await tx.db.get(`SELECT data FROM ${tx.t('orders')} WHERE id=?`,[orderId]);
  if(inventory) {
    if(!row)write('record:products',null,true);
    else {
      const order=JSON.parse(row.data);
      for(const item of order.items||[])for(const component of item.components?.length?item.components:[{productId:item.itemId}])
        write('record:products',component.productId,true);
      for(const {productId} of order.inventory?.products||[])write('record:products',productId,true);
    }
  }
  if(commission) {
    const related=await tx.db.all(`SELECT id FROM ${tx.t('expenses')} WHERE order_id=?`,[orderId]);
    for(const {id} of related)write('expenses',id);
    write('expenses',`@order:${orderId}`); // Includes new derived expenses in any aggregate read.
  }
}

async function ledgerReversal(tx,id,action,documentType,write) {
  const entries=tx.t('cash_entries');
  let rows=[];
  if(id&&action==='cash-reverse') {
    const row=await tx.db.get(`SELECT id,account_id,transfer_id FROM ${entries} WHERE id=?`,[id]);
    if(row)rows=row.transfer_id
      ?await tx.db.all(`SELECT id,account_id FROM ${entries} WHERE transfer_id=? AND reversal_of IS NULL`,[row.transfer_id])
      :[row];
  } else if(id) {
    if(['advance','payroll_payment'].includes(documentType)) {
      rows=await tx.db.all(`SELECT id,account_id FROM ${entries} WHERE source_type=? AND (id=? OR source_id=?) AND reversal_of IS NULL`,[documentType,id,id]);
    } else {
      const tables={collection:'order_collections',refund:'order_collections',settlement:'settlement_receipts',settlement_receipt:'settlement_receipts',expense_payment:'expense_payments'};
      if(Object.hasOwn(tables,documentType))rows=await tx.db.all(`SELECT e.id,e.account_id FROM ${entries} e JOIN ${tx.t(tables[documentType])} d ON d.cash_entry_id=e.id WHERE d.${documentType==='settlement'?'settlement_id':'id'}=?`,[id]);
    }
  }
  if(!rows.length) {
    write('movements',action==='cash-reverse'?id:null,true);
    write('account-ledger',null,true);
  } else for(const {id,account_id} of rows) {
    write('movements',id);
    write('account-ledger',account_id);
  }
}

export async function assistantWriteAccess(tx,{target,entityId,payload={},references=[],intent='',form=null,message='',view=null}) {
  const accesses=[];
  const create=createIntent.test(intent)||/^(?:crea|registra|agrega|añade|genera|quiero\s+crear)\b/iu.test(message.trimStart())||form?.target===target&&form.entityId===null;
  const write=(resource,id,requiresIdentity=false)=>accesses.push(scope(resource,id,'write',requiresIdentity&&!scopeId(id)));
  const get=key=>payload[key]??form?.values?.[key];
  const key=field=>scopeId(get(field));
  if(target.startsWith('record:')) write(target,entityId,!create);
  else switch(target) {
    case 'order': {
      write('orders',entityId,!create);
      if(entityId)await orderEffects(tx,entityId,write);
      else if(!create)await orderEffects(tx,null,write);
      const items=get('items');
      for(const item of Array.isArray(items)?items:[]) {
        const id=scopeId(item?.itemId),kind=item?.kind;
        if(!id||!['products','combos'].includes(kind)) {write('record:products',null,true);continue;}
        const row=await tx.db.get(`SELECT data FROM ${tx.t('records')} WHERE kind=? AND id=?`,[kind,id]);
        const record=row?JSON.parse(row.data):null;
        if(kind==='combos'||record?.productType==='gift') {
          accesses.push(scope(`record:${kind}`,id));
          if(Array.isArray(record?.items))for(const component of record.items)write('record:products',component.productId,true);
          else write('record:products',null,true);
        } else write('record:products',id);
      }
      break;
    }
    case 'shipment-create': {
      const orderId=entityId||key('orderId');
      write('shipments',orderId?`@order:${orderId}`:null);
      write('orders',orderId,true);
      await orderEffects(tx,orderId,write);
      break;
    }
    case 'shipment-metadata':
    case 'shipment-event': {
      write('shipments',entityId,true);
      const row=entityId&&await tx.db.get(`SELECT order_id FROM ${tx.t('shipments')} WHERE id=?`,[entityId]);
      if(row&&row.order_id===null)break;
      const orderId=row?.order_id||references.find(ref=>ref.kind==='order')?.id;
      write('orders',orderId,true);
      await orderEffects(tx,orderId,write);
      break;
    }
    case 'campaign-draft': write('campaigns',entityId,!create);break;
    case 'campaign-duplicate':
      write('campaigns');accesses.push(scope('campaigns',entityId,'read',!entityId));break;
    case 'report-snapshot': write('reports');accesses.push(...commercial.map(key=>scope(key)));break;
    case 'storefront-settings': write('storefront-settings');break;
    case 'settings:policy':
    case 'settings:preferences': write('business-settings');break;
    case 'settings:person': write('people',entityId,!create);break;
    case 'settings:platform': write('platforms',entityId,!create);break;
    case 'settings:source': write('sources',entityId,!create);break;
    case 'settings:alert': write('alerts',entityId,true);break;
    case 'settings:alert-rule': write('alert-rules',entityId,true);break;
    case 'asset-metadata': write('assets');break;
    case 'advertising-result-action': write('campaigns',entityId||get('campaignId'),true);break;
    case 'onboarding:cash': write('accounts',get('accountId'));break;
    case 'onboarding:product': write('record:products');break;
    case 'import-draft':
    case 'import-resolver': write('imports',entityId||view?.batch,true);break;
    case 'import-source-name': write('sources',entityId,!create);break;
    case 'import-platform-name': write('platforms',entityId,!create);break;
    case 'import-profile-name': write('profiles',entityId,!create);break;
    default: {
      const action=target.startsWith('business-action:')?target.slice(16):null;
      if(!action) {write('*',null,true);break;}
      const primary=financePrimary[action];
      if(primary) {
        const [resource,field]=primary;
        write(resource,get(field)||entityId,!create&&!['expense','settlement-save','account-save','payroll-confirm'].includes(action));
      }
      if(action==='payroll-prepare') return assistantReadAccess(tx,{domain:'cash',query:{kind:'payroll-preview'}});
      if(['cash-close','cash-reopen'].includes(action)) write('closings',action==='cash-reopen'?entityId:null);
      if(action==='link-shipment'||get('orderId')||get('shipmentId')) {
        if(primary?.[0]!=='orders') write('orders',get('orderId'));
        if((get('shipmentId')||action==='link-shipment')&&primary?.[0]!=='shipments') write('shipments',get('shipmentId'));
      }
      if(['return','collection','refund','resolve-legacy-payment','link-shipment'].includes(action))
        await orderEffects(tx,key('orderId')||(primary?.[0]==='orders'?entityId:null),write,{inventory:['return','link-shipment'].includes(action)});
      if(action==='document-reverse') {
        for(const resource of ['orders','settlements','expenses','payroll'])write(resource,null,true);
      }
      if(['cash-reverse','document-reverse'].includes(action)) {
        await ledgerReversal(tx,action==='cash-reverse'?key('cashEntryId')||entityId:key('documentId'),action,get('documentType'),write);
        break;
      }
      const accounts=[key('accountId'),key('fromAccountId'),key('toAccountId')].filter(Boolean);
      if(accounts.length) for(const account of accounts) write('account-ledger',account);
      else if(!['complete-costs','link-shipment','settlement-save','payroll-confirm','account-save'].includes(action)) write('account-ledger',null,['cash-close','transfer','advance','income'].includes(action));
      if(action==='account-save') {
        const accountId=key('accountId')||entityId;
        accesses.push(scope('account-ledger',accountId,accountId?'read':'write'));
      }
      if(action==='transfer'&&accounts.length<2)write('account-ledger',null,true);
    }
  }
  for(const ref of references) {
    const resource=referenceResources[ref.kind]||(ref.kind.startsWith('record:')?ref.kind:null);
    if(resource) accesses.push(scope(resource,ref.id));
  }
  return accesses;
}

function resourceCovers(left,right) {
  return left===right||left==='*'||left.endsWith(':*')&&right.startsWith(left.slice(0,-1));
}
function covers(left,right) {
  return resourceCovers(left.resource,right.resource)&&(left.id===null||left.id===right.id);
}

export function mergeAssistantAccess(existing,incoming) {
  const merged=[...existing];
  for(const entry of incoming) {
    if(merged.some(prior=>prior.mode===entry.mode&&covers(prior,entry)))continue;
    for(let i=merged.length-1;i>=0;i--)if(merged[i].mode===entry.mode&&covers(entry,merged[i]))merged.splice(i,1);
    merged.push({...entry,unclear:false});
  }
  return merged;
}

export function assistantAccessConflict(incoming,existing) {
  let blocked=false;
  for(const candidate of incoming) for(const active of existing) {
    if(candidate.mode!=='write'&&active.mode!=='write')continue;
    if(!(resourceCovers(active.resource,candidate.resource)||resourceCovers(candidate.resource,active.resource))||active.id!==null&&candidate.id!==null&&active.id!==candidate.id)continue;
    if(candidate.unclear)return 'clarify';
    blocked=true;
  }
  return blocked?'wait':null;
}
