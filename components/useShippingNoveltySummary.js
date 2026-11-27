'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {reconcileShippingPushPermission,watchShippingPushPermission} from './ShippingPushControl';

export const shippingNoveltyView = {section:'orders',tab:'heka',panel:'novelties'};
export const shippingEventView = eventId => ({...shippingNoveltyView,...(typeof eventId==='string'?{eventId}:{})});
const summaryPath = '/api/admin/shipping/novelties?summary=1';

export default function useShippingNoveltySummary(api,onOpen) {
  const [count,setCount]=useState(0),[notice,setNotice]=useState(false);
  const current=useRef(null),seen=useRef(undefined),open=useRef(onOpen);
  open.current=onOpen;
  const reload=useCallback(()=>{
    current.current?.abort();
    const controller=new AbortController();current.current=controller;
    api(summaryPath,{signal:controller.signal}).then(data=>{
      if(controller.signal.aborted)return;
      if(seen.current!==undefined&&data.latestEventId&&seen.current!==data.latestEventId&&data.unreadCount>0)setNotice(data.latestEventId);
      seen.current=data.latestEventId??null;
      setCount(data.unreadCount??0);
    }).catch(()=>{});
  },[api]);
  useEffect(()=>{
    const reconcile=()=>{void reconcileShippingPushPermission(api).catch(()=>{});};
    const visible=()=>{if(document.visibilityState==='visible')reload();};
    const foreground=()=>{visible();if(document.visibilityState==='visible')reconcile();};
    const message=event=>{
      if(event.data?.type==='shipping-novelties-changed'){foreground();return;}
      if(event.data?.type==='open-shipping-novelties'){foreground();if(open.current?.(event.data.eventId)===false)setNotice(event.data.eventId??true);}
    };
    foreground();
    const unwatch=watchShippingPushPermission(reconcile);
    const interval=setInterval(visible,30_000);
    window.addEventListener('focus',foreground);
    document.addEventListener('visibilitychange',foreground);
    navigator.serviceWorker?.addEventListener('message',message);
    return()=>{
      clearInterval(interval);current.current?.abort();unwatch();
      window.removeEventListener('focus',foreground);
      document.removeEventListener('visibilitychange',foreground);
      navigator.serviceWorker?.removeEventListener('message',message);
    };
  },[api,reload]);
  return {count,notice,reload,dismiss:()=>setNotice(false)};
}
