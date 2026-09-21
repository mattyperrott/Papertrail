import { createHash, randomUUID } from 'node:crypto';
import type { Alert, AlertLevel, PaperAccount } from '../shared/types.js';

const safeMessage=(error:unknown)=>error instanceof Error?error.message.replace(/https?:\/\/\S+/g,'[redacted-url]').slice(0,300):'Webhook delivery failed';

export class AlertService {
  constructor(private readonly webhookUrl?:string,private readonly token?:string) {}

  add(account:PaperAccount,level:AlertLevel,code:string,message:string,now=Date.now()) {
    account.alerts??=[];
    const fingerprint=createHash('sha256').update(`${code}\0${message}`).digest('hex').slice(0,24);
    const active=account.alerts.find(alert=>alert.id===fingerprint&&!alert.acknowledgedAt);
    if(active)return active;
    const alert:Alert={id:fingerprint,level,code,message,createdAt:new Date(now).toISOString(),deliveryAttempts:0};
    account.alerts.unshift(alert);
    if(account.alerts.length>2000)account.alerts.length=2000;
    return alert;
  }

  async deliverPending(account:PaperAccount,now=Date.now()) {
    if(!this.webhookUrl)return {delivered:0,pending:(account.alerts??[]).filter(alert=>!alert.deliveredAt&&!alert.deadLetteredAt).length};
    let delivered=0;
    for(const alert of (account.alerts??[]).filter(row=>!row.deliveredAt&&!row.deadLetteredAt&&Date.parse(row.nextDeliveryAt??new Date(0).toISOString())<=now).slice(0,10)) {
      alert.deliveryAttempts++;
      try {
        const response=await fetch(this.webhookUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{'content-type':'application/json',...(this.token?{authorization:`Bearer ${this.token}`}:{})},body:JSON.stringify({eventId:alert.id,level:alert.level,code:alert.code,message:alert.message,createdAt:alert.createdAt,mode:'paper',liveEnabled:false})});
        if(!response.ok)throw new Error(`Webhook returned HTTP ${response.status}`);
        alert.deliveredAt=new Date(now).toISOString();alert.nextDeliveryAt=undefined;alert.lastDeliveryError=undefined;delivered++;
      } catch(error) {
        alert.lastDeliveryError=safeMessage(error);
        if(alert.deliveryAttempts>=5)alert.deadLetteredAt=new Date(now).toISOString();
        else {
          const base=Math.min(300_000,1000*2**(alert.deliveryAttempts-1));
          const jitter=parseInt(createHash('sha256').update(`${alert.id}:${alert.deliveryAttempts}`).digest('hex').slice(0,4),16)%Math.max(1,Math.floor(base/2));
          alert.nextDeliveryAt=new Date(now+base+jitter).toISOString();
        }
      }
    }
    return {delivered,pending:(account.alerts??[]).filter(alert=>!alert.deliveredAt&&!alert.deadLetteredAt).length};
  }

  async test() {
    if(!this.webhookUrl)throw new Error('Webhook URL is not configured');
    const eventId=`webhook-test:${randomUUID()}`;
    const response=await fetch(this.webhookUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),headers:{'content-type':'application/json',...(this.token?{authorization:`Bearer ${this.token}`}:{})},body:JSON.stringify({eventId,type:'webhook-test',mode:'paper',liveEnabled:false,at:new Date().toISOString()})});
    if(!response.ok)throw new Error(`Webhook test returned HTTP ${response.status}`);
    return eventId;
  }
}
